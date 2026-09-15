import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { pushConfigured } from '../services/fcm.js';
import { templateSmsConfigured } from '../services/msg91.js';
import { whatsappConfigured } from '../services/aisensy.js';
import { addedTemplateFields, withTemplateFields } from '../services/notifications.js';
import { normalizePhone } from '../lib/phone.js';
import {
  CHANNELS, PUSH_TEXT_TYPES, CUSTOMER_PHONE_CONSENT_BUILT,
  defaultChannels, isMissingTable, validateChannel, sendTemplateMessage, PHONE_CHANNELS,
} from '../services/notificationChannels.js';

// ── Notification channels, authored in admin ────────────────────────────────────────────────────
// Schema and argument: migrations/095_notification_channels.sql. Which channels each notification
// goes out on, and the SMS template id or WhatsApp campaign each uses — the values that change when
// a DLT template clears or a campaign is renamed, and must not need a deploy to change.

const router = Router();

const ROW_FIELDS = 'type_id, channel, enabled, template_ref, config, fallback_for, updated_at';

// One notification type by id, or { type: null } when there is none. Shared by save and test.
async function loadType(typeId) {
  const { data, error } = await supabase
    .from('notification_types')
    .select('id, slug, label, audience')
    .eq('id', Number(typeId))
    .maybeSingle();
  return { type: data ?? null, error };
}

/* A channel row from a request body, shaped the way validateChannel and the table expect. `enabled`
   is decided by the caller: save takes it from the body, a test always checks the row as if it were on. */
function rowFromBody(b = {}, { enabled, withFallback }) {
  return {
    enabled,
    template_ref: typeof b.template_ref === 'string' && b.template_ref.trim() ? b.template_ref.trim() : null,
    config:       b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? b.config : {},
    fallback_for: withFallback ? (b.fallback_for || null) : null,
  };
}

/* The fields a type's payload carries, read off its most recent notification, so admin picks a
   template variable's field from a list instead of typing it. Empty for a type never sent yet —
   validateChannel then accepts any name, because there is nothing to check it against. */
// The payload of a type's most recent notification — the example admin works from. null if none yet.
async function latestPayload(typeId) {
  const { data } = await supabase
    .from('notifications')
    .select('payload')
    .eq('type_id', typeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? (data.payload ?? {}) : null;
}

async function payloadFields(type) {
  const payload = await latestPayload(type.id);
  if (!payload) return [];
  const stored = Object.entries(payload)
    .filter(([, v]) => v === null || typeof v !== 'object')   // a list cannot fill a line of text
    .map(([k]) => k);
  // Plus the ready-to-show fields the code now adds for this type. The latest notification may predate
  // them; without this, `planLabel` could not be picked and the save check refused it as unknown.
  return [...new Set([...stored, ...addedTemplateFields(type.slug, payload)])].sort();
}

// ── GET /api/admin/notification-channels ─────────────────────────────────────────────────────────
router.get('/admin/notification-channels', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: types, error } = await supabase
      .from('notification_types')
      .select('id, slug, label, audience')
      .order('audience')
      .order('label');
    if (error) return serverError(req, res, error);

    const { data: rows, error: rowsErr } = await supabase.from('notification_channels').select(ROW_FIELDS);
    if (rowsErr && !isMissingTable(rowsErr, 'notification_channels')) return serverError(req, res, rowsErr);

    const fields = await Promise.all(types.map(t => payloadFields(t)));
    res.json({
      // false until 095 has run: the screen shows the code's defaults and cannot save.
      ready:     !rowsErr,
      providers: { push: pushConfigured(), sms: templateSmsConfigured(), whatsapp: whatsappConfigured() },
      customer_phone_consent: CUSTOMER_PHONE_CONSENT_BUILT,
      types: types.map((t, i) => {
        const own = (rows ?? []).filter(r => r.type_id === t.id);
        const list = own.length ? own : defaultChannels(t.slug);   // the same rule the sender applies
        return {
          ...t,
          has_push_text: PUSH_TEXT_TYPES.has(t.slug),
          fields:        fields[i],
          channels:      Object.fromEntries(CHANNELS.map(c => [c, list.find(r => r.channel === c) ?? null])),
        };
      }),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PUT /api/admin/notification-channels/:typeId/:channel ────────────────────────────────────────
router.put('/admin/notification-channels/:typeId/:channel', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { channel } = req.params;
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: `Unknown channel "${channel}".` });

    const { type, error: typeErr } = await loadType(req.params.typeId);
    if (typeErr) return serverError(req, res, typeErr);
    if (!type) return res.status(404).json({ error: 'Notification type not found.' });

    const row = rowFromBody(req.body, { enabled: req.body?.enabled === true, withFallback: true });
    const problem = validateChannel(type, channel, row, await payloadFields(type));
    if (problem) return res.status(400).json({ error: problem });

    const { count, error: countErr } = await supabase
      .from('notification_channels')
      .select('id', { count: 'exact', head: true })
      .eq('type_id', type.id);
    if (countErr) {
      if (isMissingTable(countErr, 'notification_channels')) {
        return res.status(409).json({ error: 'Run migration 095 on this database before changing channels.' });
      }
      return serverError(req, res, countErr);
    }

    // ⚠️ A type with NO rows runs on the defaults (email, and push where it has text). Saving one
    // channel gives it rows, and from then on only its rows count — so without this, switching on SMS
    // for a type added after 095 would silently switch its email OFF. Write the defaults first.
    if (!count) {
      const seed = defaultChannels(type.slug).map(r => ({ ...r, type_id: type.id }));
      const { error: seedErr } = await supabase
        .from('notification_channels')
        .upsert(seed, { onConflict: 'type_id,channel', ignoreDuplicates: true });
      if (seedErr) return serverError(req, res, seedErr);
    }

    const { data: saved, error: saveErr } = await supabase
      .from('notification_channels')
      .upsert({ type_id: type.id, channel, ...row }, { onConflict: 'type_id,channel' })
      .select(ROW_FIELDS)
      .single();
    if (saveErr) return serverError(req, res, saveErr);
    res.json(saved);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/admin/notification-channels/:typeId/:channel/test ─────────────────────────────────
// Send the template in the editor — saved or not — to one phone number, filled from the most recent
// real notification of this type. It goes through sendTemplateMessage, the path a real notification
// takes, so what arrives is what a bakery would get.
//
// ⚠️ It reaches a real phone and costs a real message: AiSensy and MSG91 charge per send. Admin-only,
// one number per call, and nothing is recorded as a delivery — it is not a notification.
router.post('/admin/notification-channels/:typeId/:channel/test', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { channel } = req.params;
    if (!PHONE_CHANNELS.has(channel)) return res.status(400).json({ error: 'Only SMS and WhatsApp can send a test.' });

    const phone = normalizePhone(req.body?.phone);
    if (!phone.ok) return res.status(400).json({ error: phone.error });

    const { type, error: typeErr } = await loadType(req.params.typeId);
    if (typeErr) return serverError(req, res, typeErr);
    if (!type) return res.status(404).json({ error: 'Notification type not found.' });

    // A test checks the template as if it were switched on, and a fallback means nothing for one send.
    const row = rowFromBody(req.body, { enabled: true, withFallback: false });
    const problem = validateChannel(type, channel, row, await payloadFields(type));
    if (problem) return res.status(400).json({ error: problem });

    if (channel === 'sms' ? !templateSmsConfigured() : !whatsappConfigured()) {
      return res.status(409).json({ error: `${channel === 'sms' ? 'MSG91' : 'AiSensy'} is not set up on this server.` });
    }

    const sample = await latestPayload(type.id);
    if (!sample) {
      return res.status(409).json({
        error: `No "${type.label}" notification has been sent yet, so there are no details to fill the template with.`,
      });
    }

    const result = await sendTemplateMessage({
      channel, row, payload: withTemplateFields(type.slug, sample), phone: phone.e164, name: 'Spattoo test',
    });
    console.log('[notifications] test send', JSON.stringify({
      type: type.slug, channel, to: phone.e164, status: result.status, detail: result.detail, response: result.response,
    }));

    if (result.status === 'sent') {
      return res.json({ ok: true, to: phone.e164, values: result.values, provider_message_id: result.providerMessageId });
    }
    // skipped = the template cannot be filled (a missing field): the admin's to fix, so 400.
    // failed  = the provider refused or did not answer: 502, with its words.
    return res.status(result.status === 'skipped' ? 400 : 502).json({ error: result.detail, values: result.values });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
