import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { notifyCustomerInvited } from '../services/notifications.js';
import { normalizePhone } from '../lib/phone.js';
import { config } from '../config.js';
import { DESIGN_SESSION_STATUS } from '../constants/designSessionStatuses.js';

// Basic email shape check — the authoritative check is the OTP delivery, but reject
// obvious garbage at the write point so an unreachable address never lands on a customer.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = Router();

// baker_id is the SERVER-RESOLVED req.bakerId (middleware/rbac.js → ensurePrincipal, populated by
// requireCapability on every route here) — no local re-lookup needed (SEC-14: one canonical source).

// ── GET /api/baker/customers ──────────────────────────────────────────────────
// ?include_inactive=true  → include deactivated customers
// ?q=search               → filter by name / phone / email

router.get('/baker/customers', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const includeInactive = req.query.include_inactive === 'true';
    const q    = req.query.q?.trim().toLowerCase();
    const from = req.query.from;

    let query = supabase
      .from('customers')
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .eq('baker_id', bakerId)
      .order('first_name');

    if (!includeInactive) query = query.eq('is_active', true);
    if (from)             query = query.gte('created_at', from);

    const { data, error } = await query;
    if (error) return serverError(req, res, error);

    const result = q
      ? data.filter(c => {
          const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.toLowerCase();
          return name.includes(q) || (c.phone ?? '').includes(q) || (c.email ?? '').toLowerCase().includes(q);
        })
      : data;

    res.json(result);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/customers ─────────────────────────────────────────────────
// Body: { firstName, lastName?, email?, phone? }

router.post('/baker/customers', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { firstName, lastName, email, phone, phoneCountry } = req.body;
    const emailNorm = email?.trim().toLowerCase() || null;
    if (!firstName?.trim())                  return res.status(400).json({ error: 'firstName is required' });
    if (!phone?.trim() && !emailNorm)        return res.status(400).json({ error: 'phone or email is required' });
    if (emailNorm && !EMAIL_RE.test(emailNorm)) return res.status(400).json({ error: 'Enter a valid email address' });
    let phoneNorm = null;
    if (phone?.trim()) {
      const p = normalizePhone(phone, phoneCountry);
      if (!p.ok) return res.status(400).json({ error: p.error });
      phoneNorm = p.e164;
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({
        baker_id:   bakerId,
        first_name: firstName.trim(),
        last_name:  lastName?.trim() || null,
        email:      emailNorm,
        phone:      phoneNorm,
        source:     'manual',
        is_active:  true,
      })
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .single();

    if (error) return serverError(req, res, error);
    res.status(201).json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /api/baker/customers/:id ────────────────────────────────────────────
// Body: { firstName?, lastName?, email?, phone? }

router.patch('/baker/customers/:id', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { firstName, lastName, email, phone } = req.body;

    const updates = {};
    if (firstName !== undefined) updates.first_name = firstName?.trim() || null;
    if (lastName  !== undefined) updates.last_name  = lastName?.trim()  || null;
    if (email     !== undefined) updates.email      = email?.trim().toLowerCase() || null;
    if (phone     !== undefined) updates.phone      = phone?.trim() || null;

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });
    if (updates.first_name === null)   return res.status(400).json({ error: 'firstName cannot be empty' });

    const { data, error } = await supabase
      .from('customers').update(updates)
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .maybeSingle();

    if (error)  return serverError(req, res, error);
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /api/baker/customers/:id/deactivate ─────────────────────────────────

router.patch('/baker/customers/:id/deactivate', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data, error } = await supabase
      .from('customers').update({ is_active: false })
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, is_active').maybeSingle();

    if (error)  return serverError(req, res, error);
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /api/baker/customers/:id/reactivate ─────────────────────────────────

router.patch('/baker/customers/:id/reactivate', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data, error } = await supabase
      .from('customers').update({ is_active: true })
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, is_active').maybeSingle();

    if (error)  return serverError(req, res, error);
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/customers/invite ──────────────────────────────────────────
// Upsert the customer (dedupe the person by contact), then create an invite EVENT
// and return the link. OTP/login is enforced later via the invite gate.
// Body: { firstName, lastName?, email?, phone?, channels?, note?, expiresInDays? }
router.post('/baker/customers/invite', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(400).json({ error: 'Baker context required' });

    // A draft storefront can't take customers yet — publish it first.
    const { data: pub } = await supabase
      .from('bakers').select('storefront_published').eq('id', bakerId).maybeSingle();
    if (!pub?.storefront_published) {
      return res.status(409).json({ error: 'Publish your storefront before inviting customers.' });
    }

    const { firstName, lastName, email, phone, phoneCountry, channels, note, expiresInDays = 14,
            templateId, designSnapshot, designThumbnailKey, sessionId } = req.body;
    const emailNorm = email?.trim().toLowerCase() || null;
    if (!firstName?.trim())        return res.status(400).json({ error: 'firstName is required' });
    if (!emailNorm && !phone?.trim()) return res.status(400).json({ error: 'email or phone is required' });
    if (emailNorm && !EMAIL_RE.test(emailNorm)) return res.status(400).json({ error: 'Enter a valid email address' });
    // Validate + canonicalise the phone (libphonenumber /max) so a junk number never reaches an invite.
    let phoneNorm = null;
    if (phone?.trim()) {
      const p = normalizePhone(phone, phoneCountry);
      if (!p.ok) return res.status(400).json({ error: p.error });
      phoneNorm = p.e164;
    }

    // ── Resolve the OPTIONAL starting design (frozen onto the invite) ───────────
    // Path A (templateId): seed from a library template — only a GLOBAL template or
    // one this baker owns may be shared. Path B (designSnapshot): an inline snapshot
    // from the designer's "Share the draft". Neither → a blank invite (today's
    // behaviour). templateId wins if both are somehow supplied. Fail fast (before
    // creating a customer) on an invalid template. See docs/INVITE_WITH_TEMPLATE_PLAN.md.
    let inviteDesign = null, inviteThumbKey = null, inviteTemplateId = null;
    if (templateId) {
      const { data: tpl, error: tErr } = await supabase
        .from('cake_templates').select('id, baker_id, design, thumbnail_url').eq('id', templateId).maybeSingle();
      if (tErr)  return serverError(req, res, tErr);
      if (!tpl)  return res.status(404).json({ error: 'Template not found' });
      if (tpl.baker_id != null && tpl.baker_id !== bakerId) {
        return res.status(403).json({ error: 'Template does not belong to this baker' });
      }
      inviteDesign     = tpl.design ?? null;
      inviteThumbKey   = tpl.thumbnail_url ?? null;
      inviteTemplateId = tpl.id;
    } else if (designSnapshot != null) {
      if (typeof designSnapshot !== 'object' || Array.isArray(designSnapshot)) {
        return res.status(400).json({ error: 'designSnapshot must be a design object' });
      }
      inviteDesign   = designSnapshot;
      inviteThumbKey = designThumbnailKey?.trim() || null;
    }

    // ── Upsert the customer (the person) — dedupe by email, else phone ──────────
    let lookup = supabase.from('customers').select('id').eq('baker_id', bakerId);
    lookup = emailNorm ? lookup.eq('email', emailNorm) : lookup.eq('phone', phoneNorm);
    let { data: customer } = await lookup.maybeSingle();

    if (!customer) {
      const { data: created, error: cErr } = await supabase
        .from('customers')
        .insert({
          baker_id:   bakerId,
          first_name: firstName.trim(),
          last_name:  lastName?.trim() || null,
          email:      emailNorm,
          phone:      phoneNorm,
          source:     'invite',
          is_active:  true,
        })
        .select('id')
        .single();
      if (cErr) return serverError(req, res, cErr);
      customer = created;
    }

    // ── Who is sending it (audit) + baker slug for the link ─────────────────────
    const [{ data: appUser }, { data: baker }] = await Promise.all([
      supabase.from('baker_appusers').select('id').eq('auth_user_id', req.user.id).eq('baker_id', bakerId).maybeSingle(),
      supabase.from('bakers').select('slug, name, primary_color, logo_url').eq('id', bakerId).single(),
    ]);

    // Default channels from the contact we have, unless the caller specifies.
    const resolvedChannels = Array.isArray(channels) && channels.length
      ? channels
      : [emailNorm && 'email', phoneNorm && 'sms'].filter(Boolean);

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
      : null;

    // ── Create the invite event ─────────────────────────────────────────────────
    const { data: invite, error: iErr } = await supabase
      .from('customer_invites')
      .insert({
        baker_id:    bakerId,
        customer_id: customer.id,
        channels:    resolvedChannels.length ? resolvedChannels : ['link'],
        status:      'pending',
        note:        note?.trim() || null,
        expires_at:  expiresAt,
        created_by:  appUser?.id ?? null,
        design_snapshot:      inviteDesign,
        design_thumbnail_url: inviteThumbKey,
        template_id:          inviteTemplateId,
      })
      // design_snapshot is big — echo only the lightweight fields (a client that needs
      // the design has it already; the customer gets it post-OTP from verify-otp).
      .select('id, status, channels, note, expires_at, created_at, template_id, design_thumbnail_url')
      .single();
    if (iErr) return serverError(req, res, iErr);

    // ── Live co-design ("Design Together"): bind this customer to the caller's live
    // session and carry it in the link, so the storefront routes them straight into the
    // live room after OTP. The baker already started the session (createDesignSession);
    // an unknown/foreign/ended sessionId is ignored (the invite still works, just not live).
    let liveSessionParam = '';
    if (sessionId) {
      const { data: sess } = await supabase
        .from('design_sessions')
        .select('id, baker_id, status_id, customer_id')
        .eq('id', sessionId).eq('baker_id', bakerId).maybeSingle();
      if (sess && sess.status_id === DESIGN_SESSION_STATUS.ACTIVE) {
        if (sess.customer_id !== customer.id) {
          await supabase.from('design_sessions').update({ customer_id: customer.id }).eq('id', sess.id);
        }
        liveSessionParam = `&session=${sess.id}`;
      }
    }

    // Subdomain link: {slug}.<storefront domain>. The invite id grants nothing — OTP gates access.
    const link = `${config.storefront.urlTemplate.replace('{slug}', baker.slug)}/?invite=${invite.id}${liveSessionParam}`;

    // Queue the invite email through the durable notification outbox (worker sends it,
    // sweeper retries on failure). The invite is already created — a delivery hiccup
    // can't roll it back, so we never block on the send. (SMS/WhatsApp recorded in
    // `channels` but not yet wired.)
    const logoUrl = baker.logo_url
      ? (/^https?:\/\//i.test(baker.logo_url) ? baker.logo_url : `${config.r2.publicUrl}/${baker.logo_url}`)
      : null;
    const willEmail = resolvedChannels.includes('email') && !!emailNorm;
    let emailResult = { queued: false, reason: 'email not a channel' };
    if (willEmail) {
      try {
        await notifyCustomerInvited({
          to: emailNorm,
          link,
          bakerName: baker.name,
          firstName: firstName.trim(),
          brandColor: baker.primary_color,
          logoUrl,
          note: note?.trim() || null,
          expiresAt,
        });
        emailResult = { queued: true };
        // Optimistic: handed off to the durable outbox. Mark the invite 'sent' so the
        // baker sees it dispatched — actual delivery state lives in `notifications`.
        await supabase.from('customer_invites')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', invite.id);
        invite.status = 'sent';
      } catch (err) {
        emailResult = { queued: false, reason: err.message };
      }
    }

    res.status(201).json({
      customer_id: customer.id,
      invite,
      link,
      delivery: { email: emailResult },
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
