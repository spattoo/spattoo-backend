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
 * @param {{ phone: string, campaignName: string, userName?: string, params?: string[], mediaUrl?: string|null }} args
 *   `phone` in E.164 ("+919876543210"). `params` fill {{1}}, {{2}} … in order and must match the
 *   template's count exactly — AiSensy rejects the send otherwise. `mediaUrl` is the header image,
 *   and it must be publicly reachable: AiSensy fetches it, and rejects the send if it cannot.
 * @returns {Promise<object>} AiSensy's parsed response body.
 * @throws  on any provider failure — the caller decides how to react.
 */
export async function sendWhatsAppCampaign({ phone, campaignName, userName, params = [], mediaUrl = null }) {
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
