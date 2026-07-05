import { supabase } from './supabase.js';
import { normalizeWebUrl } from '../lib/safeUrl.js';
import { logSubscriptionEvent } from '../routes/subscriptions.js';
import { enqueueLogoBgRemoval } from '../jobs/processors/removeLogoBg.js';
import { notifyBakerWelcome }   from './notifications.js';
import { getSparkTrialDays }    from './entitlements.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';

// Slugs that must never be claimed by a baker storefront (routes / infra names).
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'www', 'app', 'dashboard', 'baker', 'bakers', 'signup', 'signin',
  'login', 'logout', 'support', 'help', 'about', 'pricing', 'blog', 'static',
  'assets', 'storefront', 'orders', 'design', 'invite', 'billing', 'accounting',
]);

// Canonicalise a free-text business name (or raw slug) into a storefront slug.
export function normalizeSlug(s) {
  return String(s ?? '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// 3–40 chars, lowercase alphanumerics + internal hyphens (no leading/trailing hyphen).
export function isValidSlug(s) {
  return /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s);
}

export async function slugTaken(slug) {
  const { data } = await supabase.from('bakers').select('id').eq('slug', slug).maybeSingle();
  return !!data;
}

// Owner-identity guard: at most ONE baker per PRIMARY OWNER phone AND per primary-owner
// email (the subscription / anti-trial-farming boundary). Scoped to is_primary=true, so
// staff rows (is_primary=false) are intentionally excluded — a former staffer can start
// their own baker with the same phone/email. Phone additionally has a DB race backstop
// (partial unique baker_owner_phone_uidx WHERE is_primary — migration 015); email's race
// backstop is auth.users' native email uniqueness (createUser/signUp fail on a dupe).
//
// Pass a normalised E.164 phone and/or an email. Returns the conflicting baker
// { id, name, matchedOn: 'phone'|'email' } or null. Callers pre-check before creating the
// auth user so we never orphan an auth account on a guaranteed-to-fail insert.
export async function primaryOwnerConflict({ email, phone } = {}) {
  return findAppuserByIdentity({ email, phone, primaryOnly: true });
}

// Find a baker_appusers row matching a given email OR phone. `primaryOnly` restricts to
// owner rows (is_primary=true) — used at baker onboarding, where only owner phones/emails
// must be unique. `primaryOnly=false` scans EVERY row (owner + staff) — used at staff-add,
// where V1 enforces single-membership: an email/phone may exist on at most one appuser row.
// Returns the matched row's baker { id, name, matchedOn: 'phone'|'email' } or null.
export async function findAppuserByIdentity({ email, phone, primaryOnly = false } = {}) {
  const e = email ? String(email).trim().toLowerCase() : null;
  const p = phone || null;
  if (!e && !p) return null;

  // SEC-10: match with parameterised `.eq` (supabase-js encodes the value), NEVER a string-built
  // `.or('email.eq.<raw>')`. A crafted email/phone (e.g. containing `,` or `)`) would otherwise
  // inject PostgREST filter syntax and could bypass or broaden this owner-uniqueness check.
  // Phone is checked first so `matchedOn` keeps its prior phone-priority semantics.
  const lookup = async (column, value) => {
    let q = supabase.from('baker_appusers').select('baker_id, email, phone').eq(column, value);
    if (primaryOnly) q = q.eq('is_primary', true);
    const { data } = await q.limit(1);
    return data?.[0] ?? null;
  };

  let row = null, matchedOn = null;
  if (p)          { row = await lookup('phone', p); if (row) matchedOn = 'phone'; }
  if (!row && e)  { row = await lookup('email', e); if (row) matchedOn = 'email'; }
  if (!row) return null;

  const { data: baker } = await supabase
    .from('bakers').select('name').eq('id', row.baker_id).maybeSingle();
  return { id: row.baker_id, name: baker?.name, matchedOn };
}

// Short, unambiguous random token (no 0/o/1/l) used to de-dupe slugs.
function randomSuffix(n = 4) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Derive a UNIQUE storefront slug from the bakery name — server-side, never
// user-chosen, so a baker can't squat another baker's name. The name-derived base
// is the stable part; if it's reserved/taken we append a random suffix (e.g.
// "sweet-cakes" → "sweet-cakes-7k2"). Later, settings will let the owner edit only
// that suffix, never the base.
export async function generateUniqueSlug(name) {
  // Cap the base so base + "-xxxx" still fits the 40-char slug limit.
  let base = normalizeSlug(name).slice(0, 30).replace(/-+$/g, '');
  if (base.length < 3) base = `brand-${randomSuffix()}`;

  let candidate = base;
  for (let i = 0; i < 25; i++) {
    if (isValidSlug(candidate) && !RESERVED_SLUGS.has(candidate) && !(await slugTaken(candidate))) {
      return candidate;
    }
    candidate = `${base}-${randomSuffix()}`.slice(0, 40).replace(/-+$/g, '');
  }
  // Extremely unlikely fallback after 25 collisions.
  return `brand-${randomSuffix(6)}`;
}

// Create the baker's DB rows for an ALREADY-EXISTING auth user (caller owns the
// Supabase Auth user lifecycle): `bakers` + `baker_appusers` (owner/primary) + a
// Spark (free, 30-day) `baker_subscriptions` row + the subscription event, and mirror
// plan/status onto the baker. Rolls back the baker (and its primary appuser) if the
// appuser OR subscription insert fails; does NOT touch Supabase Auth. Throws on failure.
//
// Shared by admin onboarding (POST /admin/bakers, which first creates the auth user)
// and self-signup (POST /bakers/self, which uses the authenticated req.user) — ONE
// creation path so the two never drift.
export async function createBakerForUser({
  authUserId, name, slug,
  email, tagline, instagram_handle, website_url,
  primary_color, accent_color, logo_url,
  currency_code, timezone, primaryUser, phoneCountry,
}) {
  // Idempotent: a user owns AT MOST ONE baker (enforced by the unique index on
  // bakers.auth_user_id — migration 012). If they already have one, return it
  // rather than creating a duplicate. Safe for both callers: self-signup may
  // retry, and admin onboarding always passes a freshly-created auth user (no
  // existing baker), so this never short-circuits a genuine new baker.
  const { data: existing } = await supabase
    .from('bakers')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  if (existing) return { id: existing.id, alreadyExisted: true };

  const { data, error } = await supabase
    .from('bakers')
    .insert({
      name,
      slug,
      email:            email            || null,
      tagline:          tagline          || null,
      instagram_handle: instagram_handle || null,
      website_url:      normalizeWebUrl(website_url),   // SEC-16 — http(s) only, else null
      primary_color:    primary_color    || null,
      accent_color:     accent_color     || null,
      logo_url:         logo_url         || null,
      currency_code:    currency_code    || 'INR',
      timezone:         timezone         || 'Asia/Kolkata',
      auth_user_id:     authUserId,
      // NOTE: bakers.phone (business phone) is deliberately NOT written here — it's
      // collected later via the profile screen. The onboarding phone is the OWNER's,
      // stored on baker_appusers below (see migration 015).
      is_active:        true,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  const { error: userError } = await supabase
    .from('baker_appusers')
    .insert({
      baker_id:        data.id,
      first_name:      primaryUser.first_name,
      last_name:       primaryUser.last_name,
      email:           primaryUser.email,
      phone:           primaryUser.phone || null,   // normalised E.164 (see lib/phone.js)
      phone_country:   phoneCountry      || null,   // ISO-2 region
      whatsapp_number: primaryUser.whatsapp_number || null,
      role:            'owner',
      is_primary:      true,
      auth_user_id:    authUserId,
    });
  if (userError) {
    await supabase.from('bakers').delete().eq('id', data.id);
    // Race backstop: this owner phone won the pre-check but lost the partial unique
    // index (two concurrent signups, same phone). Surface as a typed conflict → 409.
    if (userError.code === '23505' && /phone/i.test(`${userError.message} ${userError.details ?? ''}`)) {
      const e = new Error('This phone number is already registered to another bakery.');
      e.code = 'phone_taken';
      throw e;
    }
    throw new Error(userError.message);
  }

  // Start baker on Spark — one-time, time-boxed trial; length configurable (features.trial_days).
  const today     = new Date().toISOString().slice(0, 10);
  const trialDays = await getSparkTrialDays();
  const sparkEnd  = new Date();
  sparkEnd.setDate(sparkEnd.getDate() + trialDays);

  const { error: subErr } = await supabase.from('baker_subscriptions').insert({
    baker_id:          data.id,
    plan_id:           PLAN.SPARK,
    billing_period_id: PERIOD.MONTHLY,
    status_id:         SUBSCRIPTION_STATUS.ACTIVE,  // table uses status_id (text `status` column was dropped)
    start_date:        today,
    end_date:          sparkEnd.toISOString().slice(0, 10),
  });
  if (subErr) {
    // A baker must never exist without a subscription (it drives entitlements +
    // expiry). Roll back the baker and its primary appuser, and fail loudly —
    // rather than silently leaving an unsubscribed baker (the bug this replaces).
    await supabase.from('baker_appusers').delete().eq('baker_id', data.id);
    await supabase.from('bakers').delete().eq('id', data.id);
    throw new Error(`baker_subscriptions insert failed: ${subErr.message}`);
  }

  await supabase.from('bakers').update({
    subscription_plan_id:   PLAN.SPARK,
    subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
  }).eq('id', data.id);

  await logSubscriptionEvent(data.id, {
    event: 'activated', newTier: 'spark', newStatus: 'active', changedBy: 'system',
  });

  // If the baker was created with a logo, generate its background-removed version async.
  if (logo_url) enqueueLogoBgRemoval(data.id, logo_url);

  // Welcome the new baker (post-confirmation onboarding kit). Fires exactly once — the idempotent
  // guard above returns early for an existing baker. Fire-and-forget + best-effort: a mail hiccup
  // must never fail provisioning. Recipient is the owner's email (bakers.email may be unset here).
  notifyBakerWelcome({ email: primaryUser.email, firstName: primaryUser.first_name, bakerName: name, slug })
    .catch(err => console.error('[bakers] welcome email failed:', err.message));

  return { id: data.id };
}
