import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { assertBakerOwns } from '../lib/tenantScope.js';
import { normalizeWebUrl } from '../lib/safeUrl.js';
import { randomBytes, randomUUID } from 'crypto';
import { supabase } from '../services/supabase.js';
import { deleteObject, copyObject } from '../services/r2.js';
import { enqueueLogoBgRemoval } from '../jobs/processors/removeLogoBg.js';
import { enqueueOptimizePhoto } from '../jobs/processors/optimizePhoto.js';
import { optimizeImageToWebp } from '../services/imageOptimize.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolveCustomer } from '../middleware/rbac.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import { validateDietaryKeys, requirementsForBaker, setBakerDietaryExclusions } from '../lib/dietaryRequirements.js';
import { baselineConflictKeys, conflictsForBaker, setBakerFlavourConflicts } from '../lib/flavourDietary.js';
import { resolveFlavours, PRICE_VISIBILITY } from '../lib/flavourList.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { createBakerForUser, slugTaken, primaryOwnerConflict, findAppuserByIdentity, normalizeSlug, isValidSlug, RESERVED_SLUGS, generateUniqueSlug } from '../services/bakerProvisioning.js';
import { recordAttestation, attestationMissing, publishError } from '../services/contentAttestation.js';
import { ATTESTATION_TARGET_TYPE } from '../constants/legalDocuments.js';
import { normalizePhone } from '../lib/phone.js';
import { sendStaffWelcomeEmail } from '../services/email.js';
import { getEntitlements } from '../services/entitlements.js';
import { requireEntitlement } from '../middleware/entitlements.js';
import { pendingConsents } from '../services/legalConsent.js';
import { CONSENT_SUBJECT_TYPE } from '../constants/legalDocuments.js';

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

const router = Router();

router.post('/admin/bakers', requireAuth, requireCapability('baker:onboard'), async (req, res) => {
  try {
    const {
      name, slug, email, tagline,
      instagram_handle, website_url,
      primary_color, accent_color, logo_url,
      currency_code, timezone,
      primaryUser,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug are required' });
    }
    if (!primaryUser?.first_name || !primaryUser?.last_name || !primaryUser?.email) {
      return res.status(400).json({ error: 'primaryUser.first_name, last_name, and email are required' });
    }

    // Phone is required + normalised to E.164 (the anti-trial-farming key). WhatsApp
    // is optional but validated when present. Both parse against the form's country.
    const phone = normalizePhone(primaryUser.phone, primaryUser.phone_country);
    if (!phone.ok) return res.status(400).json({ error: phone.error, field: 'phone' });

    let whatsappE164 = null;
    if (primaryUser.whatsapp_number) {
      const wa = normalizePhone(primaryUser.whatsapp_number, primaryUser.phone_country);
      if (!wa.ok) return res.status(400).json({ error: 'Enter a valid WhatsApp number', field: 'whatsapp' });
      whatsappE164 = wa.e164;
    }

    const ownerEmail = String(primaryUser.email).trim().toLowerCase();

    // Check slug + owner identity (phone OR email) before creating the auth user (avoid
    // an orphan auth account on a guaranteed-to-fail insert). Admin sees the conflict.
    if (await slugTaken(slug)) return res.status(409).json({ error: 'Slug already taken' });
    const conflict = await primaryOwnerConflict({ email: ownerEmail, phone: phone.e164 });
    if (conflict) {
      const what = conflict.matchedOn === 'phone' ? 'phone number' : 'email';
      return res.status(409).json({
        error: `This ${what} already belongs to "${conflict.name}".`,
        code: 'owner_exists', bakerName: conflict.name, field: conflict.matchedOn,
      });
    }

    const tempPassword = randomBytes(6).toString('hex') + 'Aa1!';

    // Auth account is created for the primary user, not the business contact
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:         ownerEmail,
      password:      tempPassword,
      email_confirm: true,
    });
    if (authError) return res.status(400).json({ error: authError.message });

    // Shared provisioning: bakers + baker_appusers + Spark subscription + event.
    try {
      const { id } = await createBakerForUser({
        authUserId: authData.user.id,
        name, slug, email, tagline, instagram_handle, website_url,
        primary_color, accent_color, logo_url, currency_code, timezone,
        primaryUser: { ...primaryUser, email: ownerEmail, phone: phone.e164, whatsapp_number: whatsappE164 },
        phoneCountry: phone.country,
      });
      res.status(201).json({ id, tempPassword });
    } catch (e) {
      // Admin created the auth user here, so admin rolls it back on failure.
      await supabase.auth.admin.deleteUser(authData.user.id);
      // Race backstop: phone won the pre-check but lost the unique index → 409, not 500.
      if (e.code === 'phone_taken') return res.status(409).json({ error: e.message, code: 'phone_taken', field: 'phone' });
      return serverError(req, res, e);
    }
  } catch (err) {
    serverError(req, res, err);
  }
});

// SEC-4 — rate limits for the public self-signup surface.
// Availability checks fire as the user types (debounced) → generous per-IP ceiling that a real
// user never reaches but mass enumeration does. self-signup is per-user (idempotent anyway).
const availabilityLimit = rateLimit({
  name: 'signup-available', limit: 120, windowSec: 60, key: req => req.ip,
  message: 'Too many checks. Please slow down and try again shortly.',
});
const selfSignupLimit = rateLimit({
  name: 'baker-self', limit: 10, windowSec: 3600, key: req => req.user?.id || req.ip,
  message: 'Too many attempts. Please try again later.',
});

// ── GET /api/bakers/slug-available?slug= ──────────────────────────────────────
// Public: live availability check for the self-signup storefront-address field.
router.get('/bakers/slug-available', availabilityLimit, async (req, res) => {
  try {
    const slug = normalizeSlug(req.query.slug);
    if (!slug || !isValidSlug(slug)) return res.json({ slug, available: false, reason: 'invalid' });
    if (RESERVED_SLUGS.has(slug))    return res.json({ slug, available: false, reason: 'reserved' });
    if (await slugTaken(slug))       return res.json({ slug, available: false, reason: 'taken' });
    return res.json({ slug, available: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/bakers/phone-available?phone=&country= ───────────────────────────
// Public: live "is this phone already a baker owner?" check for the self-signup
// screen, so a duplicate phone is caught BEFORE the account + confirm email exist.
// Enumeration-light: returns only available true/false, never the owning baker.
// The AUTHORITATIVE checks remain POST /api/bakers/self + the DB unique index — this
// is UX only (a client can skip it; the server-side path still rejects).
router.get('/bakers/phone-available', availabilityLimit, async (req, res) => {
  try {
    const norm = normalizePhone(req.query.phone, req.query.country);
    if (!norm.ok) return res.json({ available: false, reason: 'invalid' });
    const conflict = await primaryOwnerConflict({ phone: norm.e164 });
    return res.json({ available: !conflict, e164: norm.e164 });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/bakers/self ─────────────────────────────────────────────────────
// Baker self-signup completion (wizard step 1). Auth = the signed-up user's JWT.
// Creates their baker on the free Spark tier. Idempotent: one baker per auth user.
// First/last name + phone come from the signup metadata (collected on the signup
// screen, stored in user_metadata); the slug is generated server-side from the
// bakery name (never user-chosen — see generateUniqueSlug). Body: { name }.
router.post('/bakers/self', requireAuth, selfSignupLimit, async (req, res) => {
  try {
    const { data: existingUser } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (existingUser?.baker_id) return res.status(200).json({ id: existingUser.baker_id, existing: true });

    const meta        = req.user.user_metadata ?? {};
    const name        = (req.body.name ?? '').trim();
    const firstName   = (req.body.firstName ?? meta.first_name ?? '').trim();
    const lastName    = (req.body.lastName  ?? meta.last_name  ?? '').trim();
    const phoneRaw    = req.body.phone         ?? meta.phone         ?? null;
    const phoneCountry= req.body.phone_country ?? meta.phone_country ?? 'IN';

    if (!name)                   return res.status(400).json({ error: 'Business name is required' });
    if (!firstName || !lastName) return res.status(400).json({ error: 'Your first and last name are required' });

    // Phone is required + normalised (anti-trial-farming key). Collected at signup
    // into user_metadata; validated again here (source of truth).
    const phone = normalizePhone(phoneRaw, phoneCountry);
    if (!phone.ok) return res.status(400).json({ error: phone.error, field: 'phone' });

    const ownerEmail = String(req.user.email ?? '').trim().toLowerCase();

    // One owner per phone AND per email. Generic message (no baker name) — a self-signup
    // caller is anonymous-ish, so we don't leak WHICH bakery owns the identity.
    if (await primaryOwnerConflict({ email: ownerEmail, phone: phone.e164 })) {
      return res.status(409).json({
        error: 'An account with this phone number or email already exists. Please sign in, or use different details.',
        code: 'owner_exists', field: 'phone',
      });
    }

    // Slug is derived from the bakery name and de-duped server-side; the client
    // never picks it, so no baker can claim another's name.
    const slug = await generateUniqueSlug(name);

    const { id } = await createBakerForUser({
      authUserId: req.user.id,
      name, slug,
      primaryUser: { first_name: firstName, last_name: lastName, email: ownerEmail, phone: phone.e164 },
      phoneCountry: phone.country,
    });
    res.status(201).json({ id, slug });
  } catch (err) {
    if (err.code === 'phone_taken') {
      return res.status(409).json({ error: 'An account with this phone number already exists. Please sign in, or use a different number.', code: 'owner_exists', field: 'phone' });
    }
    serverError(req, res, err);
  }
});

// ── POST /api/baker/staff ─────────────────────────────────────────────────────
// A baker (owner) adds a staff member: creates a Supabase auth account (temp password
// returned for the owner to hand over) + a baker_appusers row (role='staff',
// is_primary=false) under the OWNER's baker.
//
// V1 = single-membership: reject if the email OR phone already exists on ANY
// baker_appusers row (owner or staff, any baker). A staff member belongs to exactly one
// baker; multi-baker staff + a "log in as staff → pick baker" flow is deferred (see the
// identity-model doc). Email also has auth.users' native uniqueness as a race backstop.
router.post('/baker/staff', requireAuth, requireCapability('staff:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;   // set by requireCapability → loadPrincipal (the owner's baker)
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const first_name = String(req.body.first_name ?? '').trim();
    const last_name  = String(req.body.last_name  ?? '').trim();
    const email      = String(req.body.email ?? '').trim().toLowerCase();
    if (!first_name) return res.status(400).json({ error: 'First name is required', field: 'first_name' });
    if (!email)      return res.status(400).json({ error: 'Email is required', field: 'email' });

    // Phone is optional for staff; validated + normalised to E.164 when provided.
    let phoneE164 = null, phoneCountry = null;
    if (req.body.phone) {
      const phone = normalizePhone(req.body.phone, req.body.phone_country);
      if (!phone.ok) return res.status(400).json({ error: phone.error, field: 'phone' });
      phoneE164 = phone.e164; phoneCountry = phone.country;
    }

    // V1 single-membership: this email/phone must not already exist on ANY appuser row.
    const conflict = await findAppuserByIdentity({ email, phone: phoneE164 });
    if (conflict) {
      const what = conflict.matchedOn === 'phone' ? 'phone number' : 'email';
      return res.status(409).json({ error: `This ${what} is already registered on Spattoo.`, code: 'appuser_exists', field: conflict.matchedOn });
    }

    // Invite the staff member: Supabase creates the (unconfirmed, password-less) auth user
    // and SENDS the activation email (SMTP is configured). `data` → user_metadata, so the
    // email template can branch on .Data.role and the app knows they must set a password.
    // On accept they land on `redirectTo` (the app root) → set-password gate → welcome email.
    const redirectTo = typeof req.body.redirectTo === 'string' ? req.body.redirectTo : undefined;
    const { data: authData, error: authError } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { role: 'staff', baker_id: bakerId, first_name, last_name, must_set_password: true },
      redirectTo,
    });
    if (authError) return res.status(400).json({ error: authError.message });

    const { data: row, error: insErr } = await supabase
      .from('baker_appusers')
      .insert({
        baker_id:      bakerId,
        first_name, last_name, email,
        phone:         phoneE164,
        phone_country: phoneCountry,
        role:          'staff',
        is_primary:    false,
        auth_user_id:  authData.user.id,
      })
      .select('id')
      .single();
    if (insErr) {
      await supabase.auth.admin.deleteUser(authData.user.id);   // roll back the orphan auth user
      return serverError(req, res, insErr);
    }

    res.status(201).json({ id: row.id, email, invited: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/baker/profile', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('id, first_name, last_name, baker_id, role, welcome_sent_at')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) {
      // A logged-in customer (invite-gated): return their baker's branding so the
      // designer renders in customer mode. No subscription details for customers.
      const cust = await resolveCustomer(req.user);
      if (cust?.baker_id) {
        const { data: cbaker } = await supabase
          .from('bakers')
          .select('id, name, slug, logo_url, primary_color, accent_color, instagram_handle, website_url, tagline')
          .eq('id', cust.baker_id).single();
        const { data: c } = await supabase
          .from('customers').select('first_name, last_name').eq('id', cust.customer_id).maybeSingle();
        if (cbaker) {
          return res.json({
            baker: {
              id: cbaker.id, name: cbaker.name, slug: cbaker.slug,
              logo_url:         toPublicUrl(cbaker.logo_url),
              primary_color:    cbaker.primary_color,  accent_color: cbaker.accent_color,
              instagram_handle: cbaker.instagram_handle, website_url: cbaker.website_url,
              tagline:          cbaker.tagline,
            },
            user: { firstName: c?.first_name ?? '', lastName: c?.last_name ?? '', email: req.user.email },
          });
        }
      }
      return res.status(404).json({ error: 'No baker account found' });
    }

    const { data: baker } = await supabase
      .from('bakers')
      .select('id, name, slug, logo_url, logo_transparent_key, primary_color, accent_color, instagram_handle, website_url, tagline, storefront_theme_id, portrait_url, storefront_published, storefront_customizations, first_paid_at')
      .eq('id', contact.baker_id)
      .single();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    // First authenticated request by a just-confirmed staff member → send OUR welcome
    // email (once). Race-safe: claim the send with a conditional UPDATE before mailing,
    // so concurrent profile loads can't double-send. Fire-and-forget — never blocks login.
    if (contact.role === 'staff' && !contact.welcome_sent_at) {
      const { data: claimed } = await supabase
        .from('baker_appusers')
        .update({ welcome_sent_at: new Date().toISOString() })
        .eq('id', contact.id).is('welcome_sent_at', null)
        .select('id').maybeSingle();
      if (claimed) {
        sendStaffWelcomeEmail({ staff: { email: req.user.email, first_name: contact.first_name }, baker })
          .catch((e) => console.error('staff welcome email failed:', e?.message));
      }
    }

    const sub = await deriveSubscription(contact.baker_id);

    // Auto-log expiry event when status flips to expired for the first time
    if (sub.status === 'expired') {
      const { count } = await supabase
        .from('subscription_events')
        .select('id', { count: 'exact', head: true })
        .eq('baker_id', baker.id).eq('event', 'expired');
      if (!count) {
        await logSubscriptionEvent(baker.id, {
          event: 'expired', previousStatus: 'active', newStatus: 'expired', changedBy: 'system',
        });
      }
    }

    // Legal docs (ToS/Privacy) whose CURRENT version this baker hasn't accepted → the app
    // shows the first-login acceptance gate. [] until Layer 1 is published (draft phase),
    // so the gate stays silent pre-launch. See docs/CONSENT_CAPTURE_PLAN.md.
    const pending_consents = await pendingConsents(CONSENT_SUBJECT_TYPE.BAKER_APPUSER, req.user.id);

    res.json({
      baker: {
        id: baker.id, name: baker.name, slug: baker.slug,
        logo_url:             toPublicUrl(baker.logo_url),
        logo_transparent_url: toPublicUrl(baker.logo_transparent_key),
        primary_color:    baker.primary_color,  accent_color: baker.accent_color,
        instagram_handle: baker.instagram_handle, website_url: baker.website_url,
        tagline:          baker.tagline,
        storefront_theme_id: baker.storefront_theme_id,
        portrait_url:     toPublicUrl(baker.portrait_url),
        storefront_published: baker.storefront_published,
        storefront_customizations: baker.storefront_customizations || {},
        subscription_status: sub.status,
        subscription_plan:   sub.plan?.name ?? null,
        subscription_end:    sub.end_date   ?? null,
        // The lapsed-access gate needs to tell THREE situations apart, because the wrong copy
        // tells the baker a false story about their account: never paid (trial ran out) vs
        // paid-then-cancelled vs paid-then-renewal-failed. Two facts decide it:
        //   has_paid_before — one-way flag, set on the first captured payment (bakers.first_paid_at)
        //   subscription_cancellation_reason — present when the lapse was a DELIBERATE cancel;
        //     absent when Razorpay simply stopped being able to charge (halted / dunning exhausted)
        has_paid_before:     !!baker.first_paid_at,
        subscription_plan_display: sub.plan?.display_name ?? null,
        subscription_cancellation_reason: sub.cancellation_reason ?? null,
      },
      user: { firstName: contact.first_name, lastName: contact.last_name, email: req.user.email, role: contact.role },
      pending_consents,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/entitlements ──────────────────────────────────────────────
// Resolved subscription gate + per-plan entitlements for the logged-in baker.
// The client reads this for UX gating (the server enforces via the entitlement
// middleware on the actual routes).
router.get('/baker/entitlements', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact?.baker_id) return res.status(404).json({ error: 'No baker account found' });
    const ent = await getEntitlements(contact.baker_id);
    res.json(ent);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.patch('/baker/profile', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const ALLOWED = ['primary_color', 'accent_color', 'logo_url', 'instagram_handle', 'website_url', 'tagline', 'story', 'portrait_url',
      'address_line1', 'address_line2', 'street', 'city', 'state', 'postal_code', 'country'];
    const updates = {};
    for (const f of ALLOWED) {
      if (f in req.body) updates[f] = req.body[f] || null;
    }
    // SEC-16 — a stored URL rendered into an href must be http(s); reject javascript:/data:/etc at
    // the write-point (defense-in-depth behind the front-end safeHref guard).
    if ('website_url' in updates) updates.website_url = normalizeWebUrl(updates.website_url);
    // storefront_theme_id is a FK to the themes master table — validate it exists and
    // is available (is_active); never coerce the NOT-NULL column to null.
    if ('storefront_theme_id' in req.body) {
      const id = Number(req.body.storefront_theme_id);
      const { data: theme } = await supabase
        .from('storefront_themes').select('id, is_active').eq('id', id).maybeSingle();
      if (!theme)           return res.status(400).json({ error: 'Unknown storefront_theme_id' });
      if (!theme.is_active) return res.status(400).json({ error: 'That theme is not available yet' });
      updates.storefront_theme_id = id;
    }
    // storefront_customizations is jsonb (NOT NULL) — only set when a real object is sent.
    if (req.body.storefront_customizations && typeof req.body.storefront_customizations === 'object') {
      updates.storefront_customizations = req.body.storefront_customizations;
    }
    // Logo changed → reset the derived transparent version; the async job repopulates it (and it
    // stays null if the logo was cleared), so we never show a transparent cutout of a stale logo.
    if ('logo_url' in updates) updates.logo_transparent_key = null;

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

    const { error } = await supabase
      .from('bakers')
      .update(updates)
      .eq('id', contact.baker_id);
    if (error) return serverError(req, res, error);

    if (updates.logo_url) enqueueLogoBgRemoval(contact.baker_id, updates.logo_url);

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/storefront-themes ──────────────────────────────────────────
// The themes master list for the Settings → Store Settings → Themes picker.
// Returns [{ id, key, name, description, is_active }] (is_active=false = coming soon).
router.get('/baker/storefront-themes', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('storefront_themes')
      .select('id, key, name, description, is_active')
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json({ themes: data ?? [] });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/storefront-photos ──────────────────────────────────────────
// The baker's gallery photos (ordered) for the storefront slideshow / customiser.
router.get('/baker/storefront-photos', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data, error } = await supabase
      .from('baker_storefront_photos')
      .select('id, storage_key, caption, sort_order')
      .eq('baker_id', contact.baker_id)
      .order('sort_order');
    if (error) return serverError(req, res, error);

    res.json({ photos: (data ?? []).map(p => ({ id: p.id, key: p.storage_key, url: toPublicUrl(p.storage_key), caption: p.caption })) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/storefront-photos ─────────────────────────────────────────
// Add one gallery photo (already uploaded to R2). Body: { storage_key | key, caption? }.
// A row is written immediately on upload so every R2 object is tracked + manageable.
//
// NO rights attestation here: a gallery photo is not public until the STOREFRONT is published
// (until then GET /api/storefront/:slug 404s). The single gate is the Publish button below, whose
// attestation stands over the storefront's content as a whole — including photos added later while
// already published (their created_at dates them). See supabase/content_attestations.sql.
router.post('/baker/storefront-photos', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const storage_key = req.body?.storage_key || req.body?.key;
    if (!storage_key) return res.status(400).json({ error: 'storage_key is required' });

    const { data: last } = await supabase
      .from('baker_storefront_photos').select('sort_order')
      .eq('baker_id', contact.baker_id).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const sort_order = (last?.sort_order ?? -1) + 1;

    const { data, error } = await supabase
      .from('baker_storefront_photos')
      .insert({ baker_id: contact.baker_id, storage_key, caption: req.body?.caption || null, sort_order })
      .select('id, storage_key, caption, sort_order')
      .single();
    if (error) return serverError(req, res, error);

    // Convert the uploaded photo to a web-optimised WebP (resize + quality) in the background.
    enqueueOptimizePhoto(data.id, data.storage_key);

    res.json({ id: data.id, key: data.storage_key, url: toPublicUrl(data.storage_key), caption: data.caption, sort_order: data.sort_order });
  } catch (err) {
    serverError(req, res, err);
  }
});

// Access-check a cake design (global or owned by this baker) and SNAPSHOT its thumbnail into the
// baker's gallery folder as an INDEPENDENT R2 object. Returns { key, url }. Throws an Error with
// `.status` for expected failures (404 not found / 400 no image) so callers translate cleanly.
// Shared by the gallery-photo and hero-image "from a design" endpoints — one copy of the logic.
async function snapshotDesignThumbnail(bakerId, templateId, keyPrefix = '') {
  const { data: tpl, error } = await supabase
    .from('cake_templates')
    .select('id, thumbnail_url, baker_id')
    .eq('id', templateId)
    .eq('is_active', true)
    .or(`baker_id.is.null,baker_id.eq.${bakerId}`)   // global OR this baker's own — no cross-tenant
    .maybeSingle();
  if (error) throw error;
  if (!tpl) { const e = new Error('Design not found'); e.status = 404; throw e; }
  if (!tpl.thumbnail_url) { const e = new Error('This design has no image yet'); e.status = 400; throw e; }

  const srcKey = tpl.thumbnail_url;   // stored as an R2 key, not a URL
  const ext = (srcKey.split('.').pop() || 'webp').toLowerCase();
  const contentType = ext === 'png' ? 'image/png' : (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/webp';
  const destKey = `storefront/gallery/${keyPrefix}${bakerId}-${randomUUID()}.${ext}`;
  const url = await copyObject(srcKey, destKey, contentType);
  return { key: destKey, url };
}

// ── POST /api/baker/storefront-photos/from-template ───────────────────────────
// Add a gallery photo by SNAPSHOTTING a cake design's thumbnail (independent copy + a photo row) —
// so the gallery picture stays exactly as picked even if the design is later re-saved or deleted.
// Body: { template_id }.
router.post('/baker/storefront-photos/from-template', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });
    const templateId = req.body?.template_id || req.body?.templateId;
    if (!templateId) return res.status(400).json({ error: 'template_id is required' });

    const snap = await snapshotDesignThumbnail(req.bakerId, templateId);

    const { data: last } = await supabase
      .from('baker_storefront_photos').select('sort_order')
      .eq('baker_id', req.bakerId).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const sort_order = (last?.sort_order ?? -1) + 1;

    const { data, error } = await supabase
      .from('baker_storefront_photos')
      .insert({ baker_id: req.bakerId, storage_key: snap.key, caption: null, sort_order })
      .select('id, storage_key, caption, sort_order')
      .single();
    if (error) {
      try { await deleteObject(snap.key); } catch { /* best-effort: don't leave an orphan copy */ }
      return serverError(req, res, error);
    }

    res.json({ id: data.id, key: data.storage_key, url: toPublicUrl(data.storage_key), caption: data.caption, sort_order: data.sort_order });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    serverError(req, res, err);
  }
});

// ── POST /api/baker/storefront-image/from-template ────────────────────────────
// Snapshot a cake design's thumbnail and return { key, url } (NO photo row) — for the hero cake,
// which lives as a single URL in storefront_customizations, not a gallery row. Body: { template_id }.
router.post('/baker/storefront-image/from-template', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });
    const templateId = req.body?.template_id || req.body?.templateId;
    if (!templateId) return res.status(400).json({ error: 'template_id is required' });

    const snap = await snapshotDesignThumbnail(req.bakerId, templateId, 'hero-');
    res.json(snap);
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    serverError(req, res, err);
  }
});

// ── POST /api/baker/storefront-image ──────────────────────────────────────────
// Convert an already-uploaded storefront content image (e.g. a Highlight band photo, which lives in
// storefront_customizations jsonb — not a photo row) to an optimised WebP; return its public URL.
// Synchronous so the customiser can store the final URL immediately. Body: { key | storage_key }.
router.post('/baker/storefront-image', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const key = req.body?.key || req.body?.storage_key;
    if (!key) return res.status(400).json({ error: 'key is required' });
    const newKey = await optimizeImageToWebp(key);
    res.json({ key: newKey, url: toPublicUrl(newKey) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── DELETE /api/baker/storefront-photos/:id ───────────────────────────────────
// Remove a photo: deletes the row AND its R2 object (no orphans left behind).
router.delete('/baker/storefront-photos/:id', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

    const row = await assertBakerOwns(req, 'baker_storefront_photos', req.params.id, { select: 'id, storage_key' });
    if (!row) return res.status(404).json({ error: 'Photo not found' });

    // The .eq('baker_id') below is INTENTIONAL, not redundant with assertBakerOwns above — do not
    // remove. assertBakerOwns is the readable pre-check; scoping the DELETE itself makes the write
    // atomically tenant-bound (belt-and-suspenders, closes any TOCTOU gap). See lib/tenantScope.js.
    const { error } = await supabase.from('baker_storefront_photos').delete().eq('id', row.id).eq('baker_id', req.bakerId);
    if (error) return serverError(req, res, error);
    try { await deleteObject(row.storage_key); } catch (e) { /* best-effort R2 cleanup */ }

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/baker/storefront-photos ──────────────────────────────────────────
// Save captions + order for EXISTING photos. Body: { photos: [{ id, caption?, sort_order? }] }.
// Metadata-only — use POST/DELETE to add/remove.
router.put('/baker/storefront-photos', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const photos = Array.isArray(req.body?.photos) ? req.body.photos : null;
    if (!photos) return res.status(400).json({ error: 'photos array is required' });

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (!p?.id) continue;
      await supabase.from('baker_storefront_photos')
        .update({ caption: p.caption ?? null, sort_order: p.sort_order ?? i })
        .eq('id', p.id).eq('baker_id', contact.baker_id);
    }
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/storefront/publish  +  /unpublish ─────────────────────────
// Flip the storefront live/draft. Required before the public page renders or the
// baker can invite customers.
//
// PUBLISH IS THE ONE RIGHTS GATE (IP/copyright). This is the exact moment the baker's content
// becomes visible to the WORLD — until storefront_published is true, GET /api/storefront/:slug
// 404s, so templates, gallery photos and the hero are all still baker<->customer only. Cake themes
// are overwhelmingly third-party IP, and Spattoo does not pre-screen, so the baker must affirm
// they have the right to publish (ToS 6.4/6.5, B5.4-B5.6) and we keep the evidence
// (content_attestations). Every Publish click appends a fresh attestation — a re-publish after
// adding new cakes is a new affirmation, against whatever statement version is current then.
//
// UNPUBLISH is NOT gated: taking your storefront down needs no permission, and refusing it would
// be perverse (it is the remedy we would ask for on a takedown).
async function setPublished(req, res, published) {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    if (published && attestationMissing(req.body)) {
      return res.status(400).json({
        error: 'Confirm you have the right to publish this content.',
        code: 'ATTESTATION_REQUIRED',
      });
    }

    // Evidence BEFORE exposure: attest first, then go live. If the attestation write fails the
    // storefront stays private, so nothing is ever world-visible without a record of who vouched
    // for it. (Ordering it this way is why no rollback is needed — cf. the Supabase REST client
    // having no cross-table transaction.)
    if (published) {
      await recordAttestation({
        subjectId:  req.user.id,
        bakerId:    contact.baker_id,
        targetType: ATTESTATION_TARGET_TYPE.STOREFRONT,
        targetId:   contact.baker_id,      // the storefront IS the baker
        ip:         req.ip,
        userAgent:  req.headers['user-agent'] ?? null,
      });
    }

    const { error } = await supabase.from('bakers')
      .update({ storefront_published: published }).eq('id', contact.baker_id);
    if (error) return serverError(req, res, error);
    res.json({ ok: true, storefront_published: published });
  } catch (err) {
    publishError(req, res, err);
  }
}
router.post('/baker/storefront/publish',   requireAuth, requireCapability('store:manage'), requireEntitlement('storefront'), (req, res) => setPublished(req, res, true));
router.post('/baker/storefront/unpublish', requireAuth, requireCapability('store:manage'), (req, res) => setPublished(req, res, false));

// ── GET /api/baker/testimonials ───────────────────────────────────────────────
// The baker's customer reviews (ordered) for the storefront + customiser.
router.get('/baker/testimonials', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data, error } = await supabase
      .from('baker_testimonials')
      .select('id, quote, author, occasion, sort_order')
      .eq('baker_id', contact.baker_id)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json({ testimonials: data ?? [] });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/baker/testimonials ───────────────────────────────────────────────
// Replace the baker's whole ordered review set. Body: { testimonials: [{ quote, author?, occasion? }] }.
// Rows without a quote are dropped. (Pure text — no external resource, so replace is fine.)
router.put('/baker/testimonials', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const list = Array.isArray(req.body?.testimonials) ? req.body.testimonials : null;
    if (!list) return res.status(400).json({ error: 'testimonials array is required' });

    const rows = list
      .filter(t => t?.quote && t.quote.trim())
      .map((t, i) => ({ baker_id: contact.baker_id, quote: t.quote.trim(), author: t.author?.trim() || null, occasion: t.occasion?.trim() || null, sort_order: i }));

    const { error: delErr } = await supabase
      .from('baker_testimonials').delete().eq('baker_id', contact.baker_id);
    if (delErr) return serverError(req, res, delErr);

    if (rows.length) {
      const { error: insErr } = await supabase.from('baker_testimonials').insert(rows);
      if (insErr) return serverError(req, res, insErr);
    }
    res.json({ ok: true, count: rows.length });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/baker/settings', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data: baker } = await supabase
      .from('bakers')
      .select('settings')
      .eq('id', contact.baker_id)
      .single();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    res.json(baker.settings ?? {});
  } catch (err) {
    serverError(req, res, err);
  }
});

router.put('/baker/settings', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { error } = await supabase
      .from('bakers')
      .update({ settings: req.body })
      .eq('id', contact.baker_id);
    if (error) return serverError(req, res, error);

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/flavours ───────────────────────────────────────────────────
// Auth. Everything the Flavours settings screen needs, in one response:
//   { flavours: [{ id, source, name, description, excluded, price_per_kg, display_name,
//                  conflicts_with, baseline_conflicts }],
//     visibility: { price_visibility } }
//
// `excluded: true` means the baker has switched it off and it's hidden from their
// customers. Kept as `excluded` rather than flipped to `offered` because that is the
// word the panel and its PUT already speak; the STORAGE inverted in migration 037, the
// baker-facing contract did not.
//
// The list itself now comes from lib/flavourList.js, shared with the public
// GET /api/flavours. Two copies of "what does this baker offer" drifted the moment one
// of them learned about prices, which is the whole reason that module exists.
//
// The baker sees their own prices unconditionally — price_visibility governs what
// CUSTOMERS see, never what the owner sees on their own settings screen.
router.get('/baker/flavours', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    // Dietary conflicts, both layers. The panel needs BOTH: `conflicts_with` is what is in
    // force for this baker, `baseline_conflicts` is what Spattoo declared globally. A
    // toggle whose default the baker cannot see is a toggle they cannot reason about —
    // and since clearing one of our rows is their right of reply ("our hazelnut sponge
    // IS nut-free"), they have to be able to tell which rows are ours.
    const [flavours, baseline, { data: baker }] = await Promise.all([
      resolveFlavours(contact.baker_id),
      baselineConflictKeys(),
      supabase.from('bakers')
        .select('price_visibility')
        .eq('id', contact.baker_id).maybeSingle(),
    ]);

    res.json({
      flavours: flavours.map(f => ({
        id: f.id,
        source: f.source,
        name: f.name,
        description: f.description,
        excluded: !f.offered,
        price_per_kg: f.pricePerKg,
        is_signature: f.isSignature === true,
        conflicts_with:     f.conflicts_with,
        // Only global flavours have a Spattoo-authored baseline — a baker's own recipe is
        // theirs, and we have no basis for an opinion on it (supabase/flavour_dietary.sql).
        baseline_conflicts: f.source === 'global' ? (baseline[f.id] ?? []) : [],
      })),
      visibility: {
        price_visibility: baker?.price_visibility ?? 'private',
      },
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/baker/flavours ───────────────────────────────────────────────────
// Auth + store:manage. Body:
//   { flavours: [{ flavour_id, excluded?, price_per_kg?, display_name? }, ...],
//     visibility?: { price_visibility? } }
//
// Replaces PUT /api/baker/flavours/exclusions, which is GONE rather than deprecated —
// see below, because leaving it running is the single most expensive thing that could
// happen to this feature.
//
// ── WHY THIS UPSERTS AND THE OLD ONE COULD NOT ────────────────────────────────
// The old endpoint replaced the set: DELETE every row for this baker, then INSERT the
// new exclusions. That was harmless when a row carried nothing but its own existence.
// Now a row carries a PRICE, and the same code would delete every price a baker had
// entered the next time they toggled any flavour — silently, with the client having sent
// only flags. So this upserts on (baker_id, flavour_id), which the table's existing
// unique constraint already supports, and touches only the fields it was given.
//
// ── WHY UNTICKING DOES NOT DELETE ─────────────────────────────────────────────
// The instinct is to mirror the old logic — untick inserts a row, re-tick deletes it —
// and it is now wrong in both directions. Untick writes `offered = false` and KEEPS the
// row, so a baker who turns mango off for the winter still has their rate in April.
// Deleting would lose it, and they would not find out until they turned it back on.
router.put('/baker/flavours', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const entries = Array.isArray(req.body?.flavours) ? req.body.flavours : null;
    const visibility = req.body?.visibility ?? null;
    if (!entries && !visibility) {
      return res.status(400).json({ error: 'flavours must be an array, or visibility must be given' });
    }

    if (visibility) {
      const patch = {};
      // `show_flavours` is deliberately NOT read, even though a core older than this
      // still sends it. Ignoring an unknown key is what lets the column be dropped
      // without every save from an un-upgraded client failing on a missing column.
      if (visibility.price_visibility !== undefined) {
        if (!PRICE_VISIBILITY.includes(visibility.price_visibility)) {
          return res.status(400).json({ error: `price_visibility must be one of ${PRICE_VISIBILITY.join(', ')}` });
        }
        patch.price_visibility = visibility.price_visibility;
      }
      if (Object.keys(patch).length) {
        const { error } = await supabase.from('bakers').update(patch).eq('id', contact.baker_id);
        if (error) return serverError(req, res, error);
      }
    }

    if (entries?.length) {
      // Only real active global flavours, so the table cannot accumulate junk — the same
      // guard the old endpoint had, for the same reason.
      const { data: globals } = await supabase.from('flavours').select('id').eq('is_active', true);
      const valid = new Set((globals ?? []).map(f => f.id));

      // ── The signature cap ───────────────────────────────────────────────────────────────────
      // "What this kitchen is known for" means nothing if it is everything — a baker who marks all
      // twenty-six has said the same as one who marked none, except the suggester now quietly
      // prefers their whole catalogue over the rules. Counted across BOTH tables, because a baker
      // has one set of signatures, not one per storage location.
      const MAX_SIGNATURES = 3;
      const markedHere = entries.filter(e => e?.is_signature === true).length;
      const { count: ownSignatures } = await supabase
        .from('baker_flavours')
        .select('id', { count: 'exact', head: true })
        .eq('baker_id', contact.baker_id).eq('is_active', true).eq('is_signature', true);
      if (markedHere + (ownSignatures ?? 0) > MAX_SIGNATURES) {
        return res.status(400).json({
          error: `Pick at most ${MAX_SIGNATURES} signature flavours — they mean less the more there are.`,
        });
      }

      const rows = [];
      for (const e of entries) {
        if (!valid.has(e?.flavour_id)) continue;
        const price = e.price_per_kg;
        // '' from an emptied input means "unprice this", which is null — not 0, which
        // would be a baker advertising a free cake.
        const parsed = price === '' || price === null || price === undefined ? null : Number(price);
        if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
          return res.status(400).json({ error: `price_per_kg for ${e.flavour_id} must be a non-negative number` });
        }
        rows.push({
          baker_id:     contact.baker_id,
          flavour_id:   e.flavour_id,
          offered:      e.excluded === true ? false : true,
          price_per_kg: parsed,
          display_name: e.display_name?.trim() || null,
          is_signature: e.is_signature === true,
          updated_at:   new Date().toISOString(),
        });
      }

      if (rows.length) {
        const { error } = await supabase
          .from('baker_flavour_settings')
          .upsert(rows, { onConflict: 'baker_id,flavour_id' });
        if (error) return serverError(req, res, error);
      }
    }

    res.json({ ok: true, updated: entries?.length ?? 0 });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/dietary-requirements ───────────────────────────────────────
// Auth. The full vocabulary flagged with this baker's on/off state — the settings-screen
// twin of the public GET /api/dietary-requirements?bakerSlug=.
router.get('/baker/dietary-requirements', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    res.json(await requirementsForBaker(contact.baker_id));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/baker/dietary-requirements/exclusions ────────────────────────────
// Auth + store:manage. Body: { excluded_keys: ['vegan', ...] }
// Replace-set. A key is all a row carries, so there is nothing a replace can destroy —
// unlike the flavour settings, which stopped being a replace in migration 037 precisely
// because their rows gained a price.
//
// Switching one OFF never removes a customer's ability to be recorded as needing it when
// it is an ALLERGEN — that is enforced on the surfaces, not here, because the row means
// the same thing either way ("we don't deal in this") and it is the RENDERING that
// differs by kind. See supabase/baker_dietary_options.sql.
router.put('/baker/dietary-requirements/exclusions', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const keys = req.body?.excluded_keys;
    if (!Array.isArray(keys)) return res.status(400).json({ error: 'excluded_keys must be an array' });

    const keyErr = await validateDietaryKeys(keys);
    if (keyErr) return res.status(400).json({ error: keyErr });

    const ids = await setBakerDietaryExclusions(contact.baker_id, keys);
    res.json({ ok: true, excluded_count: ids.length });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/baker/flavours/dietary-conflicts ─────────────────────────────────
// Auth + store:manage. Body: { conflicts: [{ flavourId, source?, requirementKeys: [] }] }
//
// The baker sends the EFFECTIVE truth per flavour — "this flavour cannot be made
// eggless" — and the server stores only where that differs from the global baseline
// (setBakerFlavourConflicts does the diff). The UI therefore never has to know what a
// baseline is, and the override table stays sparse: a row exists only where a baker
// disagrees with us.
//
// Replace-set, exactly like the exclusions route above: what is sent becomes the whole
// truth for this baker. A set has no natural partial update.
//
// This authors a WARNING, never a block. Nothing downstream may disable a flavour or
// reject an order on these rows — see lib/flavourDietary.js and ToS §3.4 / B5.9 / C2.3.
router.put('/baker/flavours/dietary-conflicts', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const entries = Array.isArray(req.body?.conflicts) ? req.body.conflicts : null;
    if (!entries) return res.status(400).json({ error: 'conflicts must be an array' });

    // Validate every key BEFORE writing anything, so a typo cannot land a half-applied
    // set. Reuses the dietary vocabulary validator — there is no second list of keys.
    const keyErr = await validateDietaryKeys(entries.flatMap(e => e?.requirementKeys ?? []));
    if (keyErr) return res.status(400).json({ error: keyErr });

    const rows = await setBakerFlavourConflicts(contact.baker_id, entries);
    res.json({ ok: true, override_count: rows.length });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/templates ──────────────────────────────────────────────────
// Auth. The GLOBAL (Spattoo-authored) template master list, flagged with this baker's on/off state:
//   [{ id, name, thumbnail_url, tier_count, offering, excluded }]
// `excluded: true` means the baker has switched it off → it's hidden from their whole tenant (see the
// filter in GET /api/templates). Only globals are listed — a baker's OWN templates aren't managed
// here (they delete those). Direct sibling of GET /api/baker/flavours.
router.get('/baker/templates', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const [{ data: globals }, { data: exclusions }] = await Promise.all([
      supabase.from('cake_templates')
        .select('id, name, thumbnail_url, tier_count, offering, sort_order')
        .is('baker_id', null)
        .eq('is_active', true)
        .order('sort_order').order('name'),
      supabase.from('baker_template_exclusions')
        .select('template_id')
        .eq('baker_id', contact.baker_id),
    ]);

    const excluded = new Set((exclusions ?? []).map(e => e.template_id));
    res.json((globals ?? []).map(t => ({
      id: t.id, name: t.name, thumbnail_url: toPublicUrl(t.thumbnail_url),
      tier_count: t.tier_count, offering: t.offering, excluded: excluded.has(t.id),
    })));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/baker/templates/exclusions ───────────────────────────────────────
// Auth + store:manage. Body: { excluded_template_ids: [uuid, ...] }
// Replaces this baker's exclusion set (clear, then insert the new set). Only ids that are real active
// GLOBAL templates are written, so a baker can never hide another tenant's private template and the
// table can't accumulate junk. Same shape the flavour exclusions had before migration 037
// widened those rows into priced settings and made replace unsafe for them.
router.put('/baker/templates/exclusions', requireAuth, requireCapability('store:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const requested = Array.isArray(req.body?.excluded_template_ids) ? req.body.excluded_template_ids : null;
    if (!requested) return res.status(400).json({ error: 'excluded_template_ids must be an array' });

    // Keep only ids that are real active GLOBAL templates (baker_id IS NULL).
    const { data: globals } = await supabase
      .from('cake_templates').select('id').is('baker_id', null).eq('is_active', true);
    const valid = new Set((globals ?? []).map(t => t.id));
    const ids = [...new Set(requested)].filter(id => valid.has(id));

    // Replace the set: clear this baker's exclusions, then insert the new ones.
    const { error: delErr } = await supabase
      .from('baker_template_exclusions').delete().eq('baker_id', contact.baker_id);
    if (delErr) return serverError(req, res, delErr);

    if (ids.length) {
      const rows = ids.map(template_id => ({ baker_id: contact.baker_id, template_id }));
      const { error: insErr } = await supabase.from('baker_template_exclusions').insert(rows);
      if (insErr) return serverError(req, res, insErr);
    }

    res.json({ ok: true, excluded_count: ids.length });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/admin/bakers', requireAuth, requireCapability('baker:onboard'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bakers')
      .select('id, name, slug, email, subscription_status_id, is_active, created_at')
      .order('created_at', { ascending: false });
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
