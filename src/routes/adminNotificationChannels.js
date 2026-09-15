import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { pushConfigured } from '../services/fcm.js';
import { templateSmsConfigured } from '../services/msg91.js';
import { whatsappConfigured } from '../services/aisensy.js';
import { addedTemplateFields } from '../services/notifications.js';
import {
  CHANNELS, PUSH_TEXT_TYPES, CUSTOMER_PHONE_CONSENT_BUILT,
  defaultChannels, isMissingTable, validateChannel,
} from '../services/notificationChannels.js';

// ── Notification channels, authored in admin ────────────────────────────────────────────────────
// Schema and argument: migrations/095_notification_channels.sql. Which channels each notification
// goes out on, and the SMS template id or WhatsApp campaign each uses — the values that change when
// a DLT template clears or a campaign is renamed, and must not need a deploy to change.

const router = Router();

const ROW_FIELDS = 'type_id, channel, enabled, template_ref, config, fallback_for, updated_at';

/* The fields a type's payload carries, read off its most recent notification, so admin picks a
   template variable's field from a list instead of typing it. Empty for a type never sent yet —
   validateChannel then accepts any name, because there is nothing to check it against. */
async function payloadFields(type) {
  const { data } = await supabase
    .from('notifications')
    .select('payload')
    .eq('type_id', type.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return [];
  const stored = Object.entries(data.payload ?? {})
    .filter(([, v]) => v === null || typeof v !== 'object')   // a list cannot fill a line of text
    .map(([k]) => k);
  // Plus the ready-to-show fields the code now adds for this type. The latest notification may predate
  // them; without this, `planLabel` could not be picked and the save check refused it as unknown.
  return [...new Set([...stored, ...addedTemplateFields(type.slug, data.payload)])].sort();
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

    const { data: type, error: typeErr } = await supabase
      .from('notification_types')
      .select('id, slug, audience')
      .eq('id', Number(req.params.typeId))
      .maybeSingle();
    if (typeErr) return serverError(req, res, typeErr);
    if (!type) return res.status(404).json({ error: 'Notification type not found.' });

    const b = req.body ?? {};
    const row = {
      enabled:      b.enabled === true,
      template_ref: typeof b.template_ref === 'string' && b.template_ref.trim() ? b.template_ref.trim() : null,
      config:       b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? b.config : {},
      fallback_for: b.fallback_for || null,
    };
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

export default router;
