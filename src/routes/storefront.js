import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase, supabaseAuth } from '../services/supabase.js';
import { config } from '../config.js';
import { getOrderAcceptance } from '../services/entitlements.js';
import { rateLimit } from '../middleware/rateLimit.js';

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

    // Whether this storefront can take a NEW order right now (trial/cap) — drives a
    // proactive "not accepting orders" banner so customers aren't blocked at submit.
    const { accepting } = await getOrderAcceptance(baker.id);

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
    const { data: baker, error } = await supabase
      .from('bakers')
      .select('settings, storefront_published')
      .eq('slug', req.params.slug)
      .eq('is_active', true)
      .maybeSingle();
    if (error)  return serverError(req, res, error);
    if (!baker || !baker.storefront_published) return res.status(404).json({ error: 'Storefront not found' });

    const s = baker.settings ?? {};
    res.json({
      delivery:    { home_delivery: !!s.delivery?.home_delivery },
      store_hours: s.store_hours ?? null,
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
      .select('id, status, channels, expires_at, design_snapshot, design_thumbnail_url, customers(first_name, email, phone), bakers(name, slug, logo_url, primary_color, accent_color)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error)   return serverError(req, res, error);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });

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

    const { error } = channel === 'email'
      ? await supabaseAuth.auth.signInWithOtp({ email: to })
      : await supabaseAuth.auth.signInWithOtp({ phone: to });
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
