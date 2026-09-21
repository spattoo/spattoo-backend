import { config } from '../config.js';

// ── The ONE place a WhatsApp message is sent. ────────────────────────────────────────────────────
// AiSensy today, behind this file the same way MSG91 sits behind services/msg91.js: swapping the
// provider — to Meta's Cloud API directly, say — is a change here and nowhere else.
//
// AiSensy sends a CAMPAIGN, not a raw template. An admin creates an "API campaign" in AiSensy on top
// of a Meta-approved template and sets it Live; we name the campaign and fill its gaps. So the
// campaign name is the whole reference to what gets sent, and it is authored in admin
// (notification_channels.template_ref), never here.
const CAMPAIGN_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

export function whatsappConfigured() {
  return !!config.whatsapp.aisensyApiKey;
}

/**
 * Send one approved WhatsApp template to one number.
 *
 * @param {{ phone: string, campaignName: string, userName?: string, params?: string[],
 *            mediaUrl?: string|null, buttonSuffix?: string|null }} args
 *   `phone` in E.164 ("+919876543210"). `params` fill {{1}}, {{2}} … in order and must match the
 *   template's count exactly — AiSensy rejects the send otherwise. `mediaUrl` is the header image,
 *   and it must be publicly reachable: AiSensy fetches it, and rejects the send if it cannot.
 *   `buttonSuffix` fills a DYNAMIC URL BUTTON — see the note above the payload.
 * @returns {Promise<object>} AiSensy's parsed response body.
 * @throws  on any provider failure — the caller decides how to react.
 */
export async function sendWhatsAppCampaign({ phone, campaignName, userName, params = [], mediaUrl = null, buttonSuffix = null }) {
  // AiSensy takes the number with its country code and reads a bare number as Indian. Keeping the
  // '+' and dropping everything else absorbs the spaces a hand-typed number arrives with.
  const destination = String(phone ?? '').replace(/[^\d+]/g, '');
  if (!destination) throw new Error('sendWhatsAppCampaign: phone is required');
  if (!campaignName) throw new Error('sendWhatsAppCampaign: campaignName is required');

  const body = {
    apiKey:         config.whatsapp.aisensyApiKey,
    campaignName,
    destination,
    // Required. AiSensy files the recipient under this name as a contact on their side.
    userName:       userName || 'Spattoo user',
    templateParams: params,
    source:         'spattoo-notifications',
  };
  if (mediaUrl) {
    body.media = { url: mediaUrl, filename: mediaUrl.split('/').pop()?.split('?')[0] || 'image' };
  }

  /* ── A dynamic URL button is JUST ANOTHER TEMPLATE PARAM ─────────────────────────────────────────
   *
   * A Meta URL button is a STATIC BASE plus a variable SUFFIX, fixed when the template is approved —
   * `https://www.spattoo.com/o/{{1}}`. `buttonSuffix` is that {{1}}, and NOT a whole URL: passing one
   * would produce `https://www.spattoo.com/o/https://…`. The whole reason the customer link moved to
   * one fixed host (`lib/notificationFormat.js`) is that the base cannot vary, so for our order
   * templates the suffix is simply the order id.
   *
   * ⚠️ IT GOES ON THE END OF templateParams — NOT in a `buttons` component. This sent Meta's own
   * component format for a while, on the reasoning that AiSensy passes it through. It does not:
   * their API reference documents exactly nine body fields and `buttons` is not among them, and it
   * says "the length of the template params array should be equal to the number of params required
   * in the CAMPAIGN, otherwise the request will be rejected". A campaign built on a template with
   * three body variables and one URL button needs FOUR. We sent three and an unrecognised array, and
   * every send answered "Template params does not match the campaign".
   *
   * ⚠️ AND THE OLD SHAPE WAS "VERIFIED" — by intercepting our own outbound JSON and reading it. That
   * proves what we send, never that the other end accepts it. No WhatsApp with a button had ever
   * been delivered; the campaign's Sent counter was 0. A send is only proven by a send.
   * Found 2026-09-19, with Sandeep reaching the same conclusion from the AiSensy side: the button is
   * already configured in the approved template, so it only needs its value.
   *
   * The button's param comes LAST, after the body's, because that is the order Meta lists components
   * in and the order AiSensy flattens them.
   */
  if (buttonSuffix) body.templateParams = [...params, String(buttonSuffix)];

  const res = await fetch(CAMPAIGN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  // ⚠️ Never log `body` — it carries the API key.
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* not JSON — the status decides below */ }
  if (!res.ok || parsed?.success === false) {
    throw new Error(parsed?.errorMessage || parsed?.message || `AiSensy send failed (HTTP ${res.status})`);
  }
  return parsed;
}
