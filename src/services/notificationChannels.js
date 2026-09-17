import { supabase } from './supabase.js';
import { toPublicUrl } from '../lib/publicUrl.js';
import { sendTemplateSms } from './msg91.js';
import { sendWhatsAppCampaign } from './aisensy.js';
import { whatsappImageUrl } from './whatsappMedia.js';

// ── Which channels a notification goes out on, and what fills their templates ────────────────────
// Schema and the argument for it: migrations/095_notification_channels.sql.
//
// The rows say WHICH channels are on and WHICH approved template each uses. What a notification
// SAYS stays in code: the email and push text in sendNotification.js, and the payload whose fields
// fill an SMS or WhatsApp template's gaps.

export const CHANNELS = ['email', 'push', 'sms', 'whatsapp'];

// buildPush() in sendNotification.js has text for exactly these, and 095 seeds push on for exactly
// these. Push on any other type would have nothing to say, so admin refuses to switch it on.
export const PUSH_TEXT_TYPES = new Set(['order_placed_baker', 'quote_accepted_baker', 'delivery_digest_baker', 'trial_ending']);

export const PHONE_CHANNELS = new Set(['sms', 'whatsapp']);

// ── Which phone channels a CUSTOMER may be reached on ──────────────────────────────────────────────
// ⚠️ PER CHANNEL, because the two rules differ — and both are now open. Kept as a map rather than
// deleted: it is the one seam where "may we message a customer here at all" is answered, and the
// answer is a policy decision that has already changed once.
//
//   sms       yes. A message about the customer's OWN order is a service message — DLT category
//             Service Inferred — and needs no separate opt-in. Sandeep's decision (2026-09-15):
//             SMS for all communication, to baker and customer alike.
//
//   whatsapp  yes, from 2026-09-17. Sandeep's decision, and the reason is the LINK. Three customer
//             notifications exist to hand over a URL — design_updated_customer, quote_issued_customer,
//             customer_invite — and on SMS that URL is close to unsendable: DLT whitelists a CTA per
//             DOMAIN bound to a header, our storefront is a different subdomain per baker, and the
//             invite id is a uuid, so a real link is 69-86 characters against a 160-character
//             message. WhatsApp has no DLT. The full per-baker link fits and is tappable.
//
//             ⚠️ THE OPT-IN IS NOT SATISFIED, IT IS ACCEPTED AS A RISK. Meta asks for one and we hold
//             none for a customer. What we do hold: these are Utility-category templates about the
//             recipient's own order, never marketing. Meta does not refuse an unconsented send — it
//             scores it. Recipients tapping Block or Report drop the number's quality rating, and a
//             low rating cuts the messaging limit and can disable the number. So a send that succeeds
//             is NOT evidence the policy is fine; the quality rating in Meta's manager is.
//
//             ⚠️ AND THE CUSTOMER IS OFTEN NOT THERE TO ASK. `POST /orders/manual` is a baker
//             typing an order in for someone — a walk-in, a phone call — and it takes
//             `customer.phone OR customer.email`, so a phone-only customer is the NORMAL case on
//             that route, not an edge. They never load a storefront, never do an OTP, and reach
//             quote_issued_customer, order_confirmed_customer, order_ready_customer and
//             order_completed_customer having agreed to nothing. Sandeep, 2026-09-17. So there is no
//             screen of ours to put a consent line on: the only person who can ask is the BAKER, at
//             the counter or on the phone, and Meta does accept an opt-in collected that way.
//
//             `customers.source` separates the two — 'online_order' came through a storefront,
//             'manual' was typed in — but it is a PROXY and a leaky one: it is written on INSERT
//             only, so it records how we first met someone, not whether they ever agreed. Recording
//             consent properly is its own column, set at whichever moment it actually happens.
//
// Allowing a channel sends nothing by itself: every customer channel row is still off until someone
// switches it on in Admin → Notifications against an approved template.
export const CUSTOMER_CHANNELS = { sms: true, whatsapp: true };
export const customerMayReceive = channel => CUSTOMER_CHANNELS[channel] === true;

/* What a type does when it has no rows: today's behaviour. Used for a type added after 095 ran, and
   for the window before 095 runs at all — so a missing table can never mean "send nothing". */
export function defaultChannels(typeSlug) {
  const row = channel => ({ channel, enabled: true, template_ref: null, config: {}, fallback_for: null });
  return PUSH_TEXT_TYPES.has(typeSlug) ? [row('email'), row('push')] : [row('email')];
}

// PostgREST's answer for a table it does not know (PGRST205), or Postgres's own (42P01).
export const isMissingTable = (error, table) =>
  error?.code === 'PGRST205' || error?.code === '42P01' || new RegExp(table).test(error?.message ?? '');

export async function loadChannels(typeId, typeSlug) {
  const { data, error } = await supabase
    .from('notification_channels')
    .select('channel, enabled, template_ref, config, fallback_for')
    .eq('type_id', typeId);
  if (error) {
    if (isMissingTable(error, 'notification_channels')) return defaultChannels(typeSlug);
    throw new Error(`Failed to load notification channels: ${error.message}`);
  }
  return data?.length ? data : defaultChannels(typeSlug);
}

/* The enabled channels in the order they are tried: every channel that stands on its own first, then
   the fallbacks, so a fallback always knows whether the channel it covers delivered. */
export function orderChannels(rows) {
  const enabled = (rows ?? []).filter(r => r.enabled);
  const rank = r => CHANNELS.indexOf(r.channel);
  return [
    ...enabled.filter(r => !r.fallback_for).sort((a, b) => rank(a) - rank(b)),
    ...enabled.filter(r => r.fallback_for).sort((a, b) => rank(a) - rank(b)),
  ];
}

/* Channels that get ONE try. Push, because a retry cannot revive a dead device token. And any channel
   something falls back from: if it were retried later, the fallback would already have gone out and
   the person would get both. */
export function singleAttemptChannels(rows) {
  return new Set(['push', ...orderChannels(rows).map(r => r.fallback_for).filter(Boolean)]);
}

// ── Filling a template's gaps from the payload ───────────────────────────────────────────────────
// ⚠️ A gap with no value is REPORTED, never sent blank. An approved template with an empty
// variable reads as a broken message to the person who gets it, and nobody here would ever see it.

function fieldValue(payload, field) {
  const v = payload?.[field];
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return null;   // a list or an object cannot fill a line of text
  return String(v);
}

export function smsVariables(row, payload) {
  const variables = {};
  const missing = [];
  for (const [key, field] of Object.entries(row?.config?.variables ?? {})) {
    const v = fieldValue(payload, field);
    if (v === null) missing.push(field); else variables[key] = v;
  }
  return { variables, missing };
}

export function whatsappParams(row, payload) {
  const params = [];
  const missing = [];
  for (const field of Array.isArray(row?.config?.params) ? row.config.params : []) {
    const v = fieldValue(payload, field);
    if (v === null) missing.push(field); else params.push(v);
  }
  // The payload carries the stored KEY of an order's picture, not a URL; AiSensy has to fetch it.
  const imageField = row?.config?.image_field || null;
  const image = imageField ? fieldValue(payload, imageField) : null;
  if (imageField && !image) missing.push(imageField);   // an image-header template cannot send without one
  return { params, mediaUrl: image ? toPublicUrl(image) : null, missing };
}

/**
 * Fill one SMS or WhatsApp template from a payload and send it to one number. Never throws.
 *
 * ⚠️ THE ONE PATH both the notification sender and admin's "Send test" take. A test is only worth
 * having if it proves what a real notification does — the same gap-filling, the same provider call,
 * the same refusal to send a blank gap — and two copies of these lines would drift until it did not.
 *
 * @returns {{ status: 'sent'|'failed'|'skipped', recipient: string, detail?: string,
 *             providerMessageId?: string|null, response?: object, values: object }}
 *   `values` is what filled the gaps (SMS: by variable name; WhatsApp: params in order, and the image).
 */
export async function sendTemplateMessage({ channel, row, payload, phone, name = null }) {
  const isSms = channel === 'sms';
  const filled = isSms ? smsVariables(row, payload) : whatsappParams(row, payload);
  const values = isSms ? filled.variables : { params: filled.params, image: filled.mediaUrl };
  if (filled.missing.length) {
    return { status: 'skipped', recipient: phone, detail: `This notification has no ${filled.missing.join(', ')}`, values };
  }
  try {
    // WhatsApp delivers only JPEG or PNG in a template header, and our cake pictures are WebP. Converted
    // once and cached (services/whatsappMedia.js); a conversion that fails is a failed send, so it retries.
    const mediaUrl = !isSms && filled.mediaUrl ? await whatsappImageUrl(filled.mediaUrl) : null;
    if (mediaUrl) values.image = mediaUrl;   // report the picture actually sent
    const response = isSms
      ? await sendTemplateSms({ phone, templateId: row.template_ref, variables: filled.variables })
      : await sendWhatsAppCampaign({
          phone, campaignName: row.template_ref, userName: name, params: filled.params, mediaUrl,
        });
    const id = isSms ? response?.message : (response?.submitted_message_id ?? response?.messageId);
    return { status: 'sent', recipient: phone, providerMessageId: id ? String(id) : null, response, values };
  } catch (err) {
    return { status: 'failed', recipient: phone, detail: err.message, values };
  }
}

// ── Who a phone channel reaches ──────────────────────────────────────────────────────────────────
/**
 * The bakery person a baker notification's SMS or WhatsApp goes to: name, phone, WhatsApp number.
 *
 * ⚠️ NOT BY baker_id ALONE. Several baker notifications never recorded one (quote_accepted_baker,
 * quote_question_baker, every subscription mail), so the recipient's email is the other way in —
 * it is always there, because it is how the email was addressed. The primary app user is the person
 * bakerNotifyEmail() addressed in the first place.
 */
export async function bakerContact({ bakerId, email }) {
  const cols = 'first_name, phone, whatsapp_number';
  const primaryOf = id => supabase.from('baker_appusers').select(cols)
    .eq('baker_id', id).order('is_primary', { ascending: false }).limit(1).maybeSingle();

  let person = null;
  if (bakerId) person = (await primaryOf(bakerId)).data;
  if (!person && email) {
    person = (await supabase.from('baker_appusers').select(cols).eq('email', email).limit(1).maybeSingle()).data;
  }
  if (!person && email) {
    const { data: baker } = await supabase.from('bakers').select('id').eq('email', email).limit(1).maybeSingle();
    if (baker) person = (await primaryOf(baker.id)).data;
  }
  if (!person) return null;
  return {
    name:     person.first_name || null,
    phone:    person.phone || null,
    // The number they gave for WhatsApp, else their phone — for most people it is the same number.
    whatsapp: person.whatsapp_number || person.phone || null,
  };
}

/**
 * The customer a customer notification's SMS goes to: name and phone.
 *
 * The phone the notification already carries comes first (the order-placed payload has it). Otherwise
 * it is read off the order — every quote / confirmed / ready / completed / design-update payload
 * carries `orderId`, and the customer on that order is who it is about. A customer is scoped to one
 * bakery, so the order is the reliable way in; their email alone could match another bakery's customer.
 *
 * @returns {{ name: string|null, phone: string|null, whatsapp: string|null } | null}
 */
export async function customerContact({ payload }) {
  const p = payload ?? {};
  if (p.customerPhone) {
    return { name: p.customerFirstName ?? p.firstName ?? null, phone: p.customerPhone, whatsapp: p.customerPhone };
  }
  if (!p.orderId) return null;
  const { data } = await supabase
    .from('orders')
    .select('customers(first_name, phone)')
    .eq('id', p.orderId)
    .maybeSingle();
  const customer = Array.isArray(data?.customers) ? data.customers[0] : data?.customers;
  if (!customer?.phone) return null;
  return { name: customer.first_name ?? null, phone: customer.phone, whatsapp: customer.phone };
}

// ── What admin may save ──────────────────────────────────────────────────────────────────────────
/**
 * Check one channel row before it is saved. Returns an error sentence, or null when it is fine.
 *
 * type     { slug, audience }
 * channel  one of CHANNELS
 * row      { enabled, template_ref, config, fallback_for }
 * fields   payload fields this type is known to carry (from its latest notification), or [] when
 *          none has been sent yet — in which case field names cannot be checked and are accepted.
 */
export function validateChannel(type, channel, row, fields = []) {
  if (!CHANNELS.includes(channel)) return `Unknown channel "${channel}".`;
  const { enabled, template_ref: ref, config = {}, fallback_for: fallback } = row;

  if (fallback != null) {
    if (!PHONE_CHANNELS.has(channel)) return 'Only SMS or WhatsApp can be a fallback.';
    if (!CHANNELS.includes(fallback) || fallback === channel) return 'A channel cannot fall back to itself.';
  }
  if (!enabled) return null;   // anything may be saved switched off — that is how a draft is kept

  if (channel === 'push' && !PUSH_TEXT_TYPES.has(type.slug)) {
    return 'This notification has no push text written, so push cannot be switched on.';
  }
  if (PHONE_CHANNELS.has(channel) && type.audience === 'customer' && !customerMayReceive(channel)) {
    return `Customers may not be reached on ${channel === 'sms' ? 'SMS' : 'WhatsApp'} yet, so it stays off for customer notifications.`;
  }

  const unknown = f => fields.length > 0 && !fields.includes(f);
  if (channel === 'sms') {
    if (!ref?.trim()) return 'Enter the MSG91 template ID.';
    const vars = config.variables ?? {};
    if (typeof vars !== 'object' || Array.isArray(vars)) return 'SMS variables must map a template variable to a field.';
    for (const [key, field] of Object.entries(vars)) {
      if (!key.trim() || typeof field !== 'string' || !field.trim()) return 'Every SMS variable needs a name and a field.';
      if (unknown(field)) return `"${field}" is not a field this notification carries.`;
    }
  }
  if (channel === 'whatsapp') {
    if (!ref?.trim()) return 'Enter the AiSensy campaign name.';
    const params = config.params ?? [];
    if (!Array.isArray(params) || params.some(f => typeof f !== 'string' || !f.trim())) {
      return 'Every WhatsApp template variable needs a field.';
    }
    const bad = params.find(unknown);
    if (bad) return `"${bad}" is not a field this notification carries.`;
    if (config.image_field && unknown(config.image_field)) return `"${config.image_field}" is not a field this notification carries.`;
  }
  return null;
}
