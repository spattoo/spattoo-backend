import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase, supabaseAuth } from '../services/supabase.js';
import { config } from '../config.js';
import { getOrderAcceptance } from '../services/entitlements.js';
import { templatesForStorefront } from '../lib/templateList.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { normalizePhone } from '../lib/phone.js';

const router = Router();

// SEC-4 — OTP abuse guards. Keyed on the INVITE ID (the real abuse unit — works behind shared IPs
// and can't be dodged by rotating IPs), with a per-IP backstop on send (SMS/email cost).
// Limits are generous vs. real use (a customer requests a code and maybe resends once).
const sendOtpPerInvite = rateLimit({
  name: 'otp-send-invite', limit: 5, windowSec: 600, key: req => req.params.id,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});
const sendOtpPerIp = rateLimit({
  name: 'otp-send-ip', limit: 30, windowSec: 600, key: req => req.ip,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});
const verifyOtpPerInvite = rateLimit({
  name: 'otp-verify-invite', limit: 10, windowSec: 600, key: req => req.params.id,
  message: 'Too many attempts. Please wait a few minutes and request a new code.',
});

// ── Storefront OTP guards ─────────────────────────────────────────────────────
// The invite limiters key on the invite id. A storefront visitor HAS no invite — that is the whole
// point of the route — so the abuse unit is the CONTACT they are asking us to send a code to.
// Keying there is what makes the limit meaningful: it caps how many codes one phone can be made to
// receive, which is the thing that costs money and annoys a stranger. The per-IP backstop then caps
// how many DIFFERENT numbers one attacker can spray from.
//
// Normalised through the same helper the handler uses, so "98765 43210" and "+919876543210" land in
// one bucket instead of two — an unnormalised key is a rate limit that reformatting walks straight
// through.
const otpContactKey = (req) => {
  const to = String(req.body?.to ?? '').trim();
  if (!to) return null;                                   // nothing to key on → handler 400s anyway
  if ((req.body?.channel || 'sms') === 'email') return `${req.params.slug}:${to.toLowerCase()}`;
  const p = normalizePhone(to);
  return p.ok ? `${req.params.slug}:${p.e164}` : null;
};

const sfSendOtpPerContact = rateLimit({
  name: 'sf-otp-send-contact', limit: 5, windowSec: 600, key: otpContactKey,
  message: 'Too many code requests for that number. Please wait a few minutes and try again.',
});
const sfSendOtpPerIp = rateLimit({
  name: 'sf-otp-send-ip', limit: 15, windowSec: 600, key: req => req.ip,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});
const sfVerifyOtpPerContact = rateLimit({
  name: 'sf-otp-verify-contact', limit: 10, windowSec: 600, key: otpContactKey,
  message: 'Too many attempts. Please wait a few minutes and request a new code.',
});

/**
 * The baker behind a PUBLIC storefront slug, or null if this storefront may not be served.
 *
 * Three conditions, and they travel together deliberately: active, published, and accepting orders.
 * They were copy-pasted into every public route, which is exactly how a route ends up missing one —
 * a lapsed baker's catalogue staying readable through the one endpoint nobody re-checked. Adding a
 * public storefront route now means calling this, not remembering three things.
 *
 * `columns` lets a caller pull what it needs; `id` is always included since every caller needs it.
 */
async function loadOpenStorefront(slug, columns = '') {
  const select = ['id', 'storefront_published', ...(columns ? columns.split(',').map(c => c.trim()) : [])];
  const { data: baker, error } = await supabase
    .from('bakers')
    .select([...new Set(select)].join(', '))
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  if (!baker || !baker.storefront_published) return null;

  const { accepting } = await getOrderAcceptance(baker.id);
  return accepting ? baker : null;
}

// Load an invite by id with its customer + baker, only if it's still VALID
// (not expired/revoked). Returns { invite, customer, baker } or null.
async function loadValidInvite(id) {
  const { data: invite } = await supabase
    .from('customer_invites')
    .select('id, status, channels, expires_at, customer_id, baker_id, design_snapshot, customers(first_name, email, phone), bakers(slug, name)')
    .eq('id', id)
    .maybeSingle();
  if (!invite) return null;
  const expired = invite.expires_at != null && new Date(invite.expires_at) < new Date();
  if (expired || ['expired', 'revoked'].includes(invite.status)) return null;
  // An invite is only as alive as its baker's subscription — a lapsed baker can't
  // take orders, so the invite is dead too (send/verify-otp then return 410).
  const { accepting } = await getOrderAcceptance(invite.baker_id);
  if (!accepting) return null;
  return invite;
}

// Resolve the raw contact for a channel from an invite's customer.
function contactFor(channel, customer) {
  if (channel === 'email') return customer?.email || null;
  if (channel === 'sms' || channel === 'whatsapp') return customer?.phone || null;
  return null;
}

function toPublicUrl(key) {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  return `${config.r2.publicUrl}/${key}`;
}

// ── GET /api/storefront/:slug ─────────────────────────────────────────────────
// Public. The customer-facing storefront for a baker: branding + story.
// No auth — this is what a customer sees before entering the design space.
router.get('/storefront/:slug', async (req, res) => {
  try {
    const { data: baker, error } = await supabase
      .from('bakers')
      .select('id, name, slug, logo_url, logo_transparent_key, primary_color, accent_color, tagline, story, portrait_url, instagram_handle, website_url, storefront_published, storefront_customizations, storefront_themes(key)')
      .eq('slug', req.params.slug)
      .eq('is_active', true)
      .maybeSingle();

    if (error)  return serverError(req, res, error);
    if (!baker) return res.status(404).json({ error: 'Storefront not found' });
    // Draft storefronts are not publicly visible until the baker hits Publish.
    if (!baker.storefront_published) return res.status(404).json({ error: 'No storefront available' });

    // Gallery photos + testimonials (ordered) + the owner's public contact (for the
    // "Talk to {baker}" path) — all non-critical; absent is fine.
    const [{ data: photos }, { data: tms }, { data: owner }] = await Promise.all([
      supabase.from('baker_storefront_photos').select('storage_key, caption').eq('baker_id', baker.id).order('sort_order'),
      supabase.from('baker_testimonials').select('quote, author, occasion').eq('baker_id', baker.id).order('sort_order'),
      supabase.from('baker_appusers').select('whatsapp_number, phone').eq('baker_id', baker.id).order('is_primary', { ascending: false }).limit(1).maybeSingle(),
    ]);

    // Whether this storefront can take a NEW order right now — the single active-
    // subscription signal (grace-aware: an active-but-cancel_at_period_end baker
    // stays servable until current_period_end, computed live in SQL). A lapsed baker
    // (cancelled past grace / expired / paused) is not served AT ALL — the storefront
    // exists only to take orders, so with no way to order there is nothing to show.
    // Also drives the "not accepting orders" banner in the servable (active) case.
    const { accepting } = await getOrderAcceptance(baker.id);
    if (!accepting) return res.status(404).json({ error: 'Storefront not found' });

    res.json({
      name:             baker.name,
      slug:             baker.slug,
      accepting_orders: accepting,
      logo_url:             toPublicUrl(baker.logo_url),
      logo_transparent_url: toPublicUrl(baker.logo_transparent_key),
      primary_color:    baker.primary_color,
      accent_color:     baker.accent_color,
      tagline:          baker.tagline,
      story:            baker.story,
      portrait_url:     toPublicUrl(baker.portrait_url),
      instagram_handle: baker.instagram_handle,
      website_url:      baker.website_url,
      storefront_theme: baker.storefront_themes?.key || 'spotlight',
      storefront_customizations: baker.storefront_customizations || {},
      gallery:          (photos ?? []).map(p => ({ url: toPublicUrl(p.storage_key), caption: p.caption })),
      testimonials:     (tms ?? []).map(t => ({ quote: t.quote, author: t.author, occasion: t.occasion })),
      whatsapp:         owner?.whatsapp_number ?? null,
      phone:            owner?.phone ?? null,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/storefront/:slug/settings ────────────────────────────────────────
// Public. Only the customer-relevant slice of the baker's settings the designer
// needs (delivery options + store hours) — NOT the full settings blob, which may
// hold internal config. Used by the customer designer's apiClient.fetchBakerSettings.
router.get('/storefront/:slug/settings', async (req, res) => {
  try {
    const baker = await loadOpenStorefront(req.params.slug, 'settings, lead_time_days');
    if (!baker) return res.status(404).json({ error: 'Storefront not found' });

    const s = baker.settings ?? {};
    res.json({
      delivery:    { home_delivery: !!s.delivery?.home_delivery },
      store_hours: s.store_hours ?? null,
      // Minimum notice, so the storefront's date picker can refuse dates inside the window
      // while the customer is still on the page. 0 = same-day is fine, which is the default
      // and today's behaviour. Nothing captures this yet; the column is read before it is
      // written so that switching it on later is a form field, not a deploy.
      lead_time_days: baker.lead_time_days ?? 0,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/storefront/:slug/templates ───────────────────────────────────────
// Public. The designs a customer can order from this baker: Spattoo's global library plus the
// baker's own, minus the globals they have switched off. Resolution lives in lib/templateList.js,
// shared with the authenticated GET /api/templates, so a baker's own browse and their storefront
// can never disagree about what they offer.
//
// Exists because the storefront's design facet is met by an ANONYMOUS visitor — GET /api/templates
// is behind requireAuth + design:create, and asking someone to log in before they may look at cakes
// is the friction that empties the funnel.
//
// Gated exactly like GET /storefront/:slug and /settings: active, published, and accepting orders.
// Kept in lock-step deliberately — a lapsed baker's catalogue must not stay readable through a
// route nobody remembered to gate.
//
// The full `design` snapshot is NOT served here; see templatesForStorefront.
router.get('/storefront/:slug/templates', async (req, res) => {
  try {
    const baker = await loadOpenStorefront(req.params.slug);
    if (!baker) return res.status(404).json({ error: 'Storefront not found' });

    res.json({ templates: await templatesForStorefront(baker.id) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Storefront OTP: verifying a STRANGER ──────────────────────────────────────────────────────────
// The invite pair above authenticates somebody the baker already knows: a customer row exists, the
// contact is on file, and the code proves "you are them". These two routes do a different job —
// there is no customer row, and the contact arrives from the browser. They prove "this number is
// real, and whoever is typing can receive on it".
//
// ── WHY IT SITS BEFORE SUBMIT, NOT BEFORE THE FLOW ───────────────────────────────────────────────
// Asking a browsing stranger to verify a phone before they may look at cakes empties the funnel.
// Asking at submit costs nothing, because by then they WANT the baker to call them. The facets keep
// the draft in localStorage, so abandoning verification loses none of their work.
//
// ── WHY IT EXISTS AT ALL ─────────────────────────────────────────────────────────────────────────
// The baker's next move on every enquiry is to phone the customer. An unverified number makes that
// impossible and the enquiry worthless, so the number is the one field worth proving. It also does
// the security job: an anonymous POST /orders is spammable, and a code that must be received is a
// far better answer than a rate limit alone.
//
// Registration, not authentication — so the captcha matters MORE here than on the invite path.

// Resolve the raw contact a storefront visitor typed into what Supabase needs, or an error string.
// Phone goes through lib/phone.js (E.164 + real per-country validation), because signInWithOtp will
// not accept "98765 43210" and a wrong-shaped number fails as a confusing 502 rather than a 400.
function storefrontContact(channel, to) {
  const raw = String(to ?? '').trim();
  if (!raw) return { error: 'to is required' };
  if (channel === 'email') {
    // Deliberately loose: Supabase is the real validator, and a clever regex here would reject a
    // valid address somebody actually owns.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return { error: 'Enter a valid email address' };
    return { otp: { email: raw.toLowerCase() }, to: raw.toLowerCase() };
  }
  const p = normalizePhone(raw);
  if (!p.ok) return { error: p.error };
  return { otp: { phone: p.e164 }, to: p.e164 };
}

// ── POST /api/storefront/:slug/send-otp ───────────────────────────────────────
// Body: { to, channel? ('sms' | 'email'), captchaToken? }
router.post('/storefront/:slug/send-otp', sfSendOtpPerContact, sfSendOtpPerIp, async (req, res) => {
  try {
    if (!supabaseAuth) return res.status(503).json({ error: 'Auth not configured' });

    // Shape first, then the storefront — a malformed number is free to reject and should not cost a
    // database round trip, which is exactly what spam is made of.
    const channel = req.body?.channel === 'email' ? 'email' : 'sms';
    const { otp, to, error: contactErr } = storefrontContact(channel, req.body?.to);
    if (contactErr) return res.status(400).json({ error: contactErr });

    // Gated exactly like the rest of the storefront: no codes sent on behalf of a baker who could
    // not receive the resulting enquiry anyway.
    if (!await loadOpenStorefront(req.params.slug)) return res.status(404).json({ error: 'Storefront not found' });

    // Anon key so Supabase's own captcha gates it, same as the invite path. shouldCreateUser stays
    // default-true: a storefront visitor is new by definition, and this IS their sign-up.
    const { error } = await supabaseAuth.auth.signInWithOtp({
      ...otp, options: { captchaToken: req.body?.captchaToken || undefined },
    });
    if (error) return res.status(502).json({ error: error.message });

    // The masked contact is echoed so the client can say "code sent to ••••3210" without having to
    // re-derive the normalised form it never saw.
    res.json({ sent: true, channel, to: channel === 'email' ? maskEmail(to) : maskPhone(to) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/storefront/:slug/verify-otp ─────────────────────────────────────
// Body: { to, code, channel? }. Returns the session for the client to adopt — POST /api/orders then
// reads the verified contact FROM THAT TOKEN, never from the enquiry body.
router.post('/storefront/:slug/verify-otp', sfVerifyOtpPerContact, async (req, res) => {
  try {
    if (!supabaseAuth) return res.status(503).json({ error: 'Auth not configured' });

    const channel = req.body?.channel === 'email' ? 'email' : 'sms';
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code is required' });
    const { otp, to, error: contactErr } = storefrontContact(channel, req.body?.to);
    if (contactErr) return res.status(400).json({ error: contactErr });

    if (!await loadOpenStorefront(req.params.slug)) return res.status(404).json({ error: 'Storefront not found' });

    // Same type-probing as the invite path: we don't know whether Supabase issued this as a signup
    // or a login, and a wrong-type attempt doesn't consume the token, so trying in order is safe.
    let data = null, error = null;
    for (const type of channel === 'email' ? ['email', 'magiclink', 'signup'] : ['sms']) {
      const r = await supabaseAuth.auth.verifyOtp({ ...otp, token: code, type });
      if (r.data?.session) { data = r.data; error = null; break; }
      error = r.error;
    }
    if (!data?.session) return res.status(401).json({ error: error?.message || 'Invalid or expired code' });

    // No customer binding here, unlike the invite path — there is no customers row yet. POST /orders
    // upserts one from the verified contact when the enquiry actually lands, so a visitor who
    // verifies and then walks away leaves no half-made customer in the baker's list.
    res.json({
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
      },
      verified: { channel, to },
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/invite/:id ───────────────────────────────────────────────────────
// Public landing for an invite link. Returns baker branding + the MASKED contact
// to prefill/lock on the login screen, plus validity. Marks the invite opened.
// The id grants nothing — OTP still gates access.
function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split('@');
  if (!d) return null;
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, u.length - 1))}@${d}`;
}
function maskPhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length <= 4 ? p : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

router.get('/invite/:id', async (req, res) => {
  try {
    const { data: invite, error } = await supabase
      .from('customer_invites')
      .select('id, status, channels, expires_at, baker_id, design_snapshot, design_thumbnail_url, customers(first_name, email, phone), bakers(name, slug, logo_url, primary_color, accent_color)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error)   return serverError(req, res, error);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });

    // A lapsed baker can't take orders → their invite links stop resolving, same as
    // the storefront (404). Grace-aware via getOrderAcceptance → getEntitlements.
    const { accepting } = await getOrderAcceptance(invite.baker_id);
    if (!accepting) return res.status(404).json({ error: 'Invite not found' });

    const expired = invite.expires_at != null && new Date(invite.expires_at) < new Date();
    const dead    = ['expired', 'revoked'].includes(invite.status);
    const valid   = !expired && !dead;

    // Mark opened on first view (analytics; harmless side effect).
    if (valid && ['pending', 'sent'].includes(invite.status)) {
      await supabase.from('customer_invites')
        .update({ status: 'opened', opened_at: new Date().toISOString() })
        .eq('id', invite.id);
    }

    const baker = invite.bakers;
    const cust  = invite.customers;
    res.json({
      valid,
      expired,
      baker: {
        name: baker?.name,
        slug: baker?.slug,
        logo_url: toPublicUrl(baker?.logo_url),
        primary_color: baker?.primary_color,
        accent_color: baker?.accent_color,
      },
      // Masked + which channels the OTP can go to. Raw contact is never exposed here.
      customer: {
        first_name: cust?.first_name,
        masked_email: maskEmail(cust?.email),
        masked_phone: maskPhone(cust?.phone),
        channels: invite.channels,
      },
      // The baker may have attached a starting design. Expose only a preview here
      // (this landing is PRE-OTP/public) — the full design_snapshot is handed over
      // after OTP verify, never on this unauthenticated endpoint.
      has_design: invite.design_snapshot != null,
      design_thumbnail_url: toPublicUrl(invite.design_thumbnail_url),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/invite/:id/send-otp ─────────────────────────────────────────────
// Server-side OTP send. The raw contact never leaves the server — the client
// only knows the invite id + chosen channel. Body: { channel? } (default email).
router.post('/invite/:id/send-otp', sendOtpPerInvite, sendOtpPerIp, async (req, res) => {
  try {
    if (!supabaseAuth) return res.status(503).json({ error: 'Auth not configured' });
    const invite = await loadValidInvite(req.params.id);
    if (!invite) return res.status(410).json({ error: 'Invite is no longer valid' });

    const channel = req.body?.channel || 'email';
    const to = contactFor(channel, invite.customers);
    if (!to) return res.status(400).json({ error: `No ${channel} contact on file for this invite` });

    // signInWithOtp uses the ANON key, so Supabase captcha (when enabled) gates it — service-role
    // would bypass but we intentionally keep the anon flow. The customer's browser solves Turnstile
    // and forwards the token here; we pass it through. undefined when captcha is off → ignored.
    const captchaToken = req.body?.captchaToken || undefined;
    const otp = channel === 'email' ? { email: to } : { phone: to };
    const { error } = await supabaseAuth.auth.signInWithOtp({ ...otp, options: { captchaToken } });
    if (error) return res.status(502).json({ error: error.message });

    if (['pending', 'opened'].includes(invite.status)) {
      await supabase.from('customer_invites')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', invite.id);
    }
    res.json({ sent: true, channel });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/invite/:id/verify-otp ───────────────────────────────────────────
// Verify the code server-side and return the Supabase session for the client to
// adopt (supabase.auth.setSession). Body: { channel?, code }.
router.post('/invite/:id/verify-otp', verifyOtpPerInvite, async (req, res) => {
  try {
    if (!supabaseAuth) return res.status(503).json({ error: 'Auth not configured' });
    const invite = await loadValidInvite(req.params.id);
    if (!invite) return res.status(410).json({ error: 'Invite is no longer valid' });

    const channel = req.body?.channel || 'email';
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code is required' });
    const to = contactFor(channel, invite.customers);
    if (!to) return res.status(400).json({ error: `No ${channel} contact on file` });

    // Verify type depends on how the OTP was issued: new user → 'signup',
    // existing user login → 'magiclink', plus the unified 'email'. We don't know
    // which up front, so try in order — a wrong-type attempt doesn't consume the
    // token, so the correct type still succeeds.
    let data = null, error = null;
    const types = channel === 'email' ? ['email', 'magiclink', 'signup'] : ['sms'];
    for (const type of types) {
      const r = channel === 'email'
        ? await supabaseAuth.auth.verifyOtp({ email: to, token: code, type })
        : await supabaseAuth.auth.verifyOtp({ phone: to, token: code, type });
      if (r.data?.session) { data = r.data; error = null; break; }
      error = r.error;
    }
    if (!data?.session) return res.status(401).json({ error: error?.message || 'Invalid or expired code' });

    // Bind this customer to the authenticated user — the one moment we hold both
    // the invite's customer_id and the freshly verified session's user id. This is
    // what lets order routes later derive the customer FROM THE TOKEN instead of
    // trusting a client-supplied identity. Bind only when unbound (never overwrite
    // an existing binding → no account takeover); a repeat login is a harmless no-op.
    const authUserId = data.session.user?.id;
    if (authUserId) {
      await supabase
        .from('customers')
        .update({ auth_user_id: authUserId })
        .eq('id', invite.customer_id)
        .is('auth_user_id', null);
    }

    res.json({
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
      },
      customer_id: invite.customer_id,
      baker_slug:  invite.bakers?.slug,
      // The starting design the baker attached (if any) — handed over ONLY here, at
      // the authenticated moment, so the storefront can seed the designer. Absent =
      // blank start. NULL-safe: a plain invite has no design_snapshot.
      design_snapshot: invite.design_snapshot ?? null,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
