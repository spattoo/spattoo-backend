import { config } from '../../config.js';
import { supabase } from '../../services/supabase.js';
import { sendEmail } from '../../services/mailer.js';
import { esc, escUrl } from '../../lib/htmlEscape.js';
import { sendPush, pushConfigured } from '../../services/fcm.js';
import { linkFor } from '../../lib/notificationLink.js';

function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Format an INSTANT (ISO timestamptz) as a calendar date in the recipient's timezone — NOT the
// server's UTC — so "renews on Aug 2" doesn't display as Aug 1 for an IST baker (the datetime
// convention: convert at the edge using the actor's zone). Falls back to Asia/Kolkata.
function formatDateTz(iso, tz) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz || 'Asia/Kolkata' });
  } catch {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}

const titleCase = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const rupees    = paise => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

// Branded, email-client-safe (table layout, inline styles) invite email. Returns
// { subject, text, html }. Kept here (with the other notification templates) so the
// invite flows through the same durable outbox pipeline as every other email.
function buildInviteEmail({ bakerName, firstName, link, brandColor, logoUrl, note, expiresAt }) {
  const brand = brandColor || '#2C4433';
  const greet = firstName ? `Hi ${esc(firstName)},` : 'Hi there,';
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const safeBaker = esc(bakerName);

  const subject = `You're invited to design your cake with ${bakerName}`;

  const text = [
    `${greet}`,
    ``,
    `${bakerName} invited you to design your cake. Use our interactive 3D designer to shape it, choose flavours, and add decorations — exactly the way you imagine it.`,
    note ? `\nA note from ${bakerName}: "${note}"` : ``,
    ``,
    `Start designing: ${link}`,
    expiry ? `\nThis private link is just for you and expires on ${expiry}.` : ``,
    ``,
    `If you weren't expecting this, you can safely ignore this email.`,
  ].filter(Boolean).join('\n');

  const header = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${safeBaker}" width="64" height="64" style="border-radius:50%;display:block;margin:0 auto;border:0;" />`
    : `<div style="width:64px;height:64px;line-height:64px;border-radius:50%;background:${brand};color:#ffffff;font-size:28px;font-weight:700;text-align:center;margin:0 auto;font-family:Arial,sans-serif;">${esc((bakerName || '?').slice(0,1).toUpperCase())}</div>`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#EDEAE2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDEAE2;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:'Helvetica Neue',Arial,sans-serif;">
        <tr><td style="padding:36px 36px 8px;text-align:center;">
          ${header}
          <h1 style="margin:20px 0 0;font-size:22px;color:${brand};font-weight:800;">${safeBaker} invited you to<br/>design your cake</h1>
        </td></tr>
        <tr><td style="padding:20px 36px 0;color:#3C4A40;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 14px;">${greet}</p>
          <p style="margin:0 0 14px;"><strong>${safeBaker}</strong> would love for you to create your perfect cake. Use our interactive 3D designer to shape it, choose flavours, and add decorations — exactly the way you imagine it.</p>
          ${note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-left:3px solid ${brand};background:#F7F5F0;padding:12px 16px;border-radius:6px;color:#55615A;font-style:italic;font-size:14px;">"${esc(note)}"<br/><span style="font-style:normal;font-size:12px;color:#9aa;">— ${safeBaker}</span></td></tr></table>` : ``}
        </td></tr>
        <tr><td style="padding:28px 36px 8px;text-align:center;">
          <a href="${esc(link)}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 34px;border-radius:12px;">Start designing &rarr;</a>
        </td></tr>
        <tr><td style="padding:8px 36px 32px;text-align:center;color:#9aa;font-size:12px;line-height:1.6;">
          ${expiry ? `<p style="margin:0 0 6px;">This private link is just for you and expires on <strong>${expiry}</strong>.</p>` : ``}
          <p style="margin:0;">If you weren't expecting this, you can safely ignore this email.</p>
        </td></tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;color:#9aa;font-size:11px;font-family:Arial,sans-serif;text-align:center;">Powered by Spattoo</p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

// Shared branded, email-client-safe shell for PLATFORM→baker emails (welcome, subscription
// lifecycle). Same card chrome as the verify email (auth-email.html) and the invite email — one
// place so every platform email reads as one system: #EDEAE2 page, white rounded card, Spattoo
// wordmark, brand-green (#2C4433) accents, footer. Callers pass only the inner body (headings,
// paragraphs, CTA); table layout + inline styles keep it Outlook/Gmail-safe. Do NOT re-paste this
// chrome per email — extend this one helper.
function platformShell(inner) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EDEAE2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDEAE2;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:'Helvetica Neue',Arial,sans-serif;">
        <tr><td style="padding:36px 36px 8px;text-align:center;">
          <div style="font-size:24px;font-weight:800;letter-spacing:0.5px;color:#2C4433;font-family:'Helvetica Neue',Arial,sans-serif;">Spattoo</div>
        </td></tr>
        <tr><td style="padding:12px 36px 32px;color:#3C4A40;font-size:15px;line-height:1.6;">
          ${inner}
        </td></tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;color:#9aa;font-size:11px;font-family:Arial,sans-serif;text-align:center;">Spattoo — the 3D cake designer for bakeries</p>
    </td></tr>
  </table>
</body></html>`;
}

function orderDetailsHtml(p) {
  const rows = [
    ['Customer',     p.customerName],
    p.customerEmail ? ['Email', p.customerEmail] : null,
    p.customerPhone ? ['Phone', p.customerPhone] : null,
    ['Delivery',     `${formatDate(p.deliveryDate)}${p.deliveryTime ? ' at ' + p.deliveryTime : ''}`],
    ['Mode',         p.deliveryMode === 'home_delivery' ? 'Home Delivery' : 'Pickup'],
    p.deliveryAddress ? ['Address', p.deliveryAddress] : null,
    p.weightKg ? ['Weight', `${p.weightKg} kg`] : null,
    p.flavours?.length ? ['Flavours', p.flavours.map(f => f.name ?? f.flavour ?? f).join(', ')] : null,
    p.specialInstructions ? ['Instructions', p.specialInstructions] : null,
  ].filter(Boolean);

  return `<table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;color:#333">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="padding:6px 0;color:#888;width:160px">${esc(label)}</td>
        <td style="padding:6px 0">${esc(value)}</td>
      </tr>`).join('')}
  </table>`;
}

function rawEmail(from) {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

// Exported for `check:email-design-claims`, the same reason buildPush is: these strings are the
// product, and the only way to assert what they say is to render them.
export function buildEmail(typeSlug, recipientEmail, payload) {
  const p = payload;

  const thumbUrl = escUrl(p.thumbnailUrl);
  const thumbnailHtml = thumbUrl
    ? `<img src="${thumbUrl}" alt="Cake design" style="display:block;max-width:100%;border-radius:8px;margin:16px 0" />`
    : '';

  // ── Is there a design to talk about? ────────────────────────────────────────────────────────
  // These templates were written when the only way to reach a baker was an INVITE into the 3D
  // designer, so every order had one and the copy said so: "thanks for designing your cake",
  // "review the design". The storefront changed that — an enquiry can now be a flavour and a date,
  // or a reference photo, with nothing designed at all — and those sentences went quietly false on
  // the majority of enquiries. A customer who picked Black Forest and a Saturday was thanked for
  // designing a cake they never opened a designer for.
  //
  // The thumbnail is the honest signal: it exists only when a design snapshot produced one. It is
  // used to CHOOSE THE SENTENCE, and the fallback is wording that is true either way — so a
  // designed cake whose thumbnail is missing gets a vaguer email, never a wrong one.
  const hasDesign = !!thumbUrl;

  if (typeSlug === 'order_placed_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `New quote request — ${p.customerName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">New quote request</h2>
        <p>You have a new cake quote request from <b>${esc(p.customerName)}</b>. ${hasDesign
          ? 'Review the design and send them a quote.'
          : 'Take a look at what they have asked for and send them a quote.'}</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px;color:#888;font-size:12px">Log in to your Spattoo dashboard to review and quote this request.</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_placed_customer') {
    // This fires when the customer places a request — every order starts at
    // 'requested' (quote-first flow). It is NOT a confirmation; the actual
    // confirmation is `order_confirmed_customer`, sent after the baker confirms.
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your cake request was sent to ${p.bakerName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Request sent!</h2>
        <p>Hi ${esc(p.customerFirstName)}, ${hasDesign
          ? `thanks for designing your cake with <b>${esc(p.bakerName)}</b>. Your request has been sent — <b>${esc(p.bakerName)}</b> will review your design and get back to you with a quote.`
          : `thanks for your cake request. It has been sent to <b>${esc(p.bakerName)}</b>, who will get back to you with a quote.`} Here's what you asked for:</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px">We'll email you as soon as your quote is ready. If you have any questions, contact your baker directly.</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'design_updated_customer') {
    const isReco = p.mode === 'recommendations';
    // Deep-link to THIS order, the way quote_issued_customer already does. The button said "View
    // your design" and went to the storefront's front page, leaving the customer to find their own
    // cake in a shop — a promise the link did not keep. `orderId` was in the payload all along
    // (services/notifications.js, notifyDesignUpdated) and simply unused.
    //
    // Falls back to the storefront root when there is no orderId, which is still better than no
    // link at all.
    const base = p.bakerSlug ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug) : null;
    const link = base && p.orderId ? `${base.replace(/\/+$/, '')}/orders/${p.orderId}` : base;
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: isReco
        ? `${p.bakerName} has design ideas for your cake`
        : `${p.bakerName} updated your cake design`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">${isReco ? 'A few ideas for your cake' : 'Your design was updated'}</h2>
        <p>Hi ${esc(p.customerFirstName)}, <b>${esc(p.bakerName)}</b> ${isReco
          ? 'has suggested some changes to your cake design'
          : 'has updated your cake design'}. Open the designer to take a look — you can keep refining it yourself.</p>
        ${thumbnailHtml}
        ${link ? `<p style="margin-top:24px"><a href="${escUrl(link)}" style="display:inline-block;background:#2C4433;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">View your design</a></p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_issued_customer') {
    // Deep-link to the customer's quote summary screen (review + accept), not the
    // storefront root.
    const base = p.bakerSlug ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug) : null;
    const link = base && p.orderId ? `${base.replace(/\/+$/, '')}/orders/${p.orderId}` : base;
    const priceLine = p.quotedPrice != null ? `Your quote: <b>₹${esc(p.quotedPrice)}</b>` : "Your quote is ready";
    const advanceLine = p.advanceAmount != null
      ? `<p style="font-size:14px;color:#444">Advance to confirm: <b>₹${esc(p.advanceAmount)}</b></p>` : "";
    const validLine = p.quoteValidUntil
      ? `<p style="color:#888;font-size:13px">Valid until ${formatDate(p.quoteValidUntil)}.</p>`
      : "";
    const noteLine = p.quoteNote
      ? `<p style="background:#f6f4ef;border-radius:8px;padding:12px 14px;font-style:italic;color:#444">&ldquo;${esc(p.quoteNote)}&rdquo; — ${esc(p.bakerName)}</p>` : "";
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `${p.bakerName} sent you a quote`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your quote is ready</h2>
        <p>Hi ${esc(p.customerFirstName)}, <b>${esc(p.bakerName)}</b> has priced your cake.</p>
        <p style="font-size:16px">${priceLine}</p>
        ${advanceLine}
        ${validLine}
        ${noteLine}
        ${link ? `<p style="margin-top:24px"><a href="${escUrl(link)}" style="display:inline-block;background:#2C4433;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">Review your quote</a></p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_accepted_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `Quote approved — ${p.customerName || 'a customer'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Quote approved</h2>
        <p><b>${esc(p.customerName || 'A customer')}</b> is happy with your quote${p.finalPrice != null ? ` of <b>₹${esc(p.finalPrice)}</b>` : ''}. Collect the advance and confirm the order to lock it in.</p>
        <p style="margin-top:24px;color:#888;font-size:12px">Open your Spattoo dashboard to confirm.</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_question_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `Question on your quote — ${p.customerName || 'a customer'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">A question on your quote</h2>
        <p><b>${esc(p.customerName || 'A customer')}</b> has a question about the quote you sent:</p>
        <p style="background:#f6f4ef;border-radius:8px;padding:12px 14px;font-style:italic;color:#444">&ldquo;${esc(p.message)}&rdquo;</p>
        <p style="margin-top:24px;color:#888;font-size:12px">Reply by revising the quote in your dashboard, or reach out to them directly.</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_confirmed_customer') {
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your order is confirmed by ${p.bakerName}!`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your order is confirmed by ${esc(p.bakerName)}</h2>
        <p>Hi ${esc(p.customerFirstName)}, <b>${esc(p.bakerName)}</b> has confirmed your order${p.finalPrice != null ? ` (<b>₹${esc(p.finalPrice)}</b>)` : ''} — it's all set, they're on it!</p>
        ${thumbnailHtml}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_ready_customer') {
    const isDelivery = p.deliveryMode === 'home_delivery';
    const when = p.deliveryDate ? ` on ${formatDate(p.deliveryDate)}${p.deliveryTime ? ' at ' + p.deliveryTime : ''}` : '';
    // Optional finished-cake photos the baker uploaded. Show these (the real cake!)
    // INSTEAD of the design thumbnail when present — a single column of inline images.
    const photoUrls = Array.isArray(p.photoUrls) ? p.photoUrls.filter(Boolean) : [];
    const photosHtml = photoUrls.length
      ? `<p style="font-size:14px;color:#444;margin:16px 0 8px">Here's how it turned out:</p>` +
        photoUrls.map(u => escUrl(u)).filter(Boolean).map(u => `<img src="${u}" alt="Your finished cake" style="display:block;max-width:100%;border-radius:8px;margin:0 0 10px" />`).join('')
      : thumbnailHtml;
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your order from ${p.bakerName} is ready!`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your order is ready</h2>
        <p>Hi ${esc(p.customerFirstName)}, your cake from <b>${esc(p.bakerName)}</b> is ready${isDelivery ? ` for delivery${esc(when)}` : ` for pickup${esc(when)}`}!</p>
        ${photosHtml}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_completed_customer') {
    const base = p.bakerSlug ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug) : null;
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Thank you from ${p.bakerName}!`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your order is complete</h2>
        <p>Hi ${esc(p.customerFirstName)}, your cake order from <b>${esc(p.bakerName)}</b> is complete — we hope it made the moment special!</p>
        ${thumbnailHtml}
        <p style="margin-top:16px">Thank you for ordering.${base ? ` Order another anytime from <a href="${escUrl(base)}" style="color:#2C4433;font-weight:700">${esc(p.bakerName)}</a>.` : ''}</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'customer_invite') {
    const { subject, text, html } = buildInviteEmail({
      bakerName:  p.bakerName,
      firstName:  p.firstName,
      link:       p.link,
      brandColor: p.brandColor,
      logoUrl:    p.logoUrl,
      note:       p.note,
      expiresAt:  p.expiresAt,
    });
    return {
      from: `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:   recipientEmail,
      subject,
      text,
      html,
    };
  }

  // ── Baker welcome (post-confirmation onboarding kit) ────────────────────────
  // The last step was "Invite your first customer to design a cake" — invite-era, and it pointed a
  // brand-new baker AWAY from the storefront the line above had just told them to publish. Sharing
  // the link is the primary path now: a customer can ask for a cake from it without an account and
  // without designing anything.
  //
  // Publishing and sharing are ONE step, not two. Splitting them left "Publish your storefront" and
  // "Share the link" as consecutive items, which reads as two jobs when it is one motion — and the
  // second half is the part that actually earns anything, so it should not be a line a reader can
  // finish the list without doing.
  //
  // ⚠️ The comment saying so lived INSIDE the html template literal for one commit, written as a
  // JSX `{/* … */}` block. This file is plain JS and that is not a comment — it is text, and it
  // rendered into the email a baker receives. Notes about the copy go out here; only copy goes in
  // there.
  if (typeSlug === 'baker_welcome') {
    const who          = esc(p.firstName || p.bakerName || 'there');
    const storefront   = p.slug ? config.storefront.urlTemplate.replace('{slug}', p.slug) : null;
    const storefrontLc = storefront ? storefront.replace(/^https?:\/\//, '') : null;
    const dashUrl      = config.app.url ? config.app.url.replace(/\/+$/, '') : null;
    return {
      from: config.smtp.from, to: recipientEmail,
      subject: `Welcome to Spattoo${p.bakerName ? `, ${esc(p.bakerName)}` : ''}!`,
      html: platformShell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Welcome to Spattoo, ${who}!</h2>
        <p style="margin:0 0 14px;">Your account is ready. Here's how to get your bakery live and taking orders:</p>
        <ol style="margin:0;padding-left:20px;line-height:1.9;">
          <li>Add your branding — logo &amp; colours</li>
          <li>Explore the 3D cake designer — visualise a cake in seconds</li>
          <li>Publish your storefront${storefrontLc ? ` at <b>${esc(storefrontLc)}</b>` : ''} and share the link — customers can ask for a cake straight from it</li>
        </ol>
        ${dashUrl ? `<p style="margin:24px 0 0;text-align:center;"><a href="${escUrl(dashUrl)}" style="display:inline-block;background:#2C4433;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 34px;border-radius:12px;">Open your dashboard &rarr;</a></p>` : ''}`),
    };
  }

  // ── Subscription lifecycle (baker-facing, Spattoo-branded) ──────────────────
  // from = Spattoo (config.smtp.from) — these are platform→baker, not baker-branded.
  const plan       = titleCase(p.planName) || 'your';
  const billingUrl = config.app.url ? `${config.app.url.replace(/\/+$/, '')}/settings/billing` : null;
  // Shared brand-green CTA button (matches the welcome/verify/invite look).
  const ctaBtn = (href, label) => `<p style="margin:24px 0 0;text-align:center;"><a href="${href}" style="display:inline-block;background:#2C4433;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 34px;border-radius:12px;">${label} &rarr;</a></p>`;
  const billingCta = billingUrl ? ctaBtn(escUrl(billingUrl), 'Manage your plan') : '';
  const shell  = platformShell;   // one branded shell for every platform email
  const hi     = p.bakerName ? `, ${esc(p.bakerName)}` : '';

  if (typeSlug === 'subscription_activated') {
    const renews = formatDateTz(p.nextBillingAt, p.timeZone);
    return { from: config.smtp.from, to: recipientEmail, subject: `Your ${plan} plan is active`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">You're all set${hi}</h2>
        <p>Your <b>${esc(plan)}</b> plan is now active${renews !== '—' ? ` and renews on <b>${renews}</b>` : ''}. Your storefront and 3D cake designer are ready to go.</p>
        ${billingCta}`) };
  }

  if (typeSlug === 'subscription_renewed') {
    const renews = formatDateTz(p.nextBillingAt, p.timeZone);
    return { from: config.smtp.from, to: recipientEmail, subject: `Payment received — ${plan} plan renewed`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Thanks${hi}</h2>
        <p>We've received your payment${p.amount != null ? ` of <b>${rupees(p.amount)}</b>` : ''} and renewed your <b>${esc(plan)}</b> plan${renews !== '—' ? `. Your next renewal is <b>${renews}</b>` : ''}.</p>
        ${billingCta}`) };
  }

  if (typeSlug === 'payment_failed') {
    const updateUrl = escUrl(p.shortUrl);
    return { from: config.smtp.from, to: recipientEmail, subject: `Action needed: payment issue on your ${plan} plan`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">We couldn't process your payment</h2>
        <p>Your latest payment for the <b>${esc(plan)}</b> plan didn't go through. To keep your storefront and designer running without interruption, please update your payment method.</p>
        ${updateUrl ? ctaBtn(updateUrl, 'Update payment method') : billingCta}`) };
  }

  if (typeSlug === 'subscription_cancelled') {
    const until = formatDateTz(p.accessUntil, p.timeZone);
    return { from: config.smtp.from, to: recipientEmail, subject: `Your ${plan} subscription is cancelled`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Your subscription is cancelled</h2>
        <p>Your <b>${esc(plan)}</b> subscription has been cancelled${until !== '—' ? ` — you'll keep full access until <b>${until}</b>` : ''}. Changed your mind? You can resubscribe anytime${until !== '—' ? ' before then' : ''}.</p>
        ${billingCta}`) };
  }

  if (typeSlug === 'subscription_expired') {
    return { from: config.smtp.from, to: recipientEmail, subject: `Your Spattoo subscription has ended`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Your subscription has ended</h2>
        <p>Your <b>${esc(plan)}</b> subscription has ended and access is now paused. Resubscribe to pick up right where you left off — your designs and storefront are saved.</p>
        ${billingCta}`) };
  }

  // ── AI credits — purchase receipt ───────────────────────────────────────────
  // Deliberately NOT "your payment was successful and nothing else". Someone reading this weeks
  // later is answering one of three questions, so all three are on the page: what did I buy, what
  // did it cost, and how many do I have now.
  //
  // "Never expire" is repeated here even though it is on the buy screen, because this is the
  // document that outlives the screen — and it is the promise most likely to be doubted later,
  // when a plan lapses or a month rolls over.
  //
  // The CTA goes to the designer rather than to billing: they bought credits to make something,
  // and billing is the screen we deliberately moved this purchase OUT of.
  if (typeSlug === 'credits_purchased') {
    const n       = Number(p.credits) || 0;
    const bought  = n.toLocaleString('en-IN');
    const wallet  = p.walletBalance != null ? Number(p.walletBalance).toLocaleString('en-IN') : null;
    const appUrl  = config.app.url ? config.app.url.replace(/\/+$/, '') : null;
    return { from: config.smtp.from, to: recipientEmail,
      subject: `${bought} Spattoo credits added`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Thanks${hi}</h2>
        <p>We've received your payment${p.amount != null ? ` of <b>${rupees(p.amount)}</b>` : ''} and added <b>${esc(bought)} credits</b> to your account.</p>
        ${wallet ? `<p>You now have <b>${esc(wallet)} bought credits</b>. They never expire, and they're only used once your monthly credits are gone.</p>`
                 : `<p>They never expire, and they're only used once your monthly credits are gone.</p>`}
        ${appUrl ? ctaBtn(escUrl(appUrl), 'Back to the designer') : ''}
        <p style="color:#6b6b6b;font-size:13px;margin:22px 0 0;">A GST invoice for this payment is sent separately.${p.paymentId ? ` Payment reference <b>${esc(p.paymentId)}</b> — quote it if you ever need to ask us about this charge.` : ''}</p>`) };
  }

  // ── AI credits — running low / used up ──────────────────────────────────────
  // The pill and the billing card already go amber at 70% and red at 100%, but those are PASSIVE:
  // they work only if the baker is looking at the screen they are on. Someone who spends a month's
  // credits across a busy week finds out on Saturday, by being refused. This is the one channel
  // that reaches them first.
  //
  // The reset date leads in both. It is the fact that turns "you are running out" into a decision
  // someone can actually make — "that's Tuesday, I'll wait" is a perfectly good answer, and an
  // email that hides it in order to sell a top-up would deserve to be ignored.
  if (typeSlug === 'credits_low' || typeSlug === 'credits_exhausted') {
    const gone    = typeSlug === 'credits_exhausted';
    const back    = formatDateTz(p.resetsOn, p.timeZone);
    const left    = Number(p.left) || 0;
    const wallet  = Number(p.walletBalance) || 0;
    const creditsUrl = config.app.url ? config.app.url.replace(/\/+$/, '') : null;

    // Bought credits change the situation completely: the monthly ones being gone is a
    // bookkeeping event, not a wall. Saying so is the difference between an accurate email and
    // one that reads as a scare.
    const wallLine = wallet > 0
      ? `You still have <b>${wallet} bought credits</b>, which don't expire — smart tools keep working.`
      : gone
        ? `Smart tools will pause until then.`
        : '';

    return { from: config.smtp.from, to: recipientEmail,
      subject: gone ? 'Your monthly Spattoo credits are used up'
                    : 'Your Spattoo credits are running low',
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">${
          gone ? `Your monthly credits are used up${hi}` : `You're running low${hi}`
        }</h2>
        <p>${gone
          ? `You've used all ${p.allowance ?? ''} credits included with your plan this month.`
          : `You have <b>${left} of ${p.allowance ?? ''} monthly credits</b> left.`}${
          back !== '—' ? ` They refresh on <b>${back}</b>.` : ''}</p>
        ${wallLine ? `<p>${wallLine}</p>` : ''}
        ${/* Offered only where it exists. A "buy more" button that leads to "your plan can't"
              is worse than not offering it — see notifyCreditsLow's canBuy. */''}
        ${p.canBuy && creditsUrl ? ctaBtn(escUrl(creditsUrl), 'Top up your credits')
                                 : creditsUrl ? ctaBtn(escUrl(creditsUrl), 'Open Spattoo') : ''}
        <p style="color:#6b6b6b;font-size:13px;margin:22px 0 0;">Everything else — your storefront, orders, and the designer — works as usual. Credits only apply to the smart tools.</p>`) };
  }

  // ── Account erasure — 48h pre-erasure notice (DPDP Rule 8) ──────────────────
  if (typeSlug === 'account_erasure_notice') {
    const when      = formatDateTz(p.eraseAfter, p.timeZone);
    const restoreUrl = config.app.url ? config.app.url.replace(/\/+$/, '') : null;
    return { from: config.smtp.from, to: recipientEmail,
      subject: `Your Spattoo account data will be erased soon`,
      html: shell(`<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Your account is scheduled for erasure${hi}</h2>
        <p>You requested deletion of your Spattoo account. Your data is scheduled to be permanently erased${when !== '—' ? ` on <b>${when}</b>` : ' soon'}.</p>
        <p><b>Changed your mind?</b> Simply log in and restore your account before then to keep everything. After erasure, this cannot be undone.</p>
        <p style="color:#6b6b6b;font-size:13px;">Note: records we're required by law to keep (such as tax invoices) are retained for their statutory period.</p>
        ${restoreUrl ? ctaBtn(escUrl(restoreUrl), 'Log in to restore') : ''}`) };
  }

  // ── The morning delivery digest ────────────────────────────────────────────────────────────────
  // The one notification here that is about a SET rather than a thing. The subject line carries the
  // whole message — a baker glancing at a phone on the way to the kitchen should not have to open
  // it to know whether today is a one-cake day or a five-cake day.
  if (typeSlug === 'delivery_digest_baker') {
    const n = p.count ?? 0;
    const rows = (p.orders ?? []).map(o => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:700;color:#2C4433;white-space:nowrap">
          ${esc(o.deliveryTime ?? '—')}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(o.customerName)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#6b6b6b;font-size:13px">
          ${esc(o.deliveryMode ?? '')}
        </td>
      </tr>`).join('');

    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      // "an order to deliver today" reads better than "1 order", and at n>1 the number is the
      // point. Naming the single customer is the whole value of the one-order case.
      subject: n === 1
        ? `You have an order to deliver today — ${p.orders?.[0]?.customerName ?? 'a customer'}`
        : `You have ${n} orders to deliver today`,
      html: shell(`
        <h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">
          ${n === 1 ? 'One delivery today' : `${n} deliveries today`}
        </h2>
        <p>Good morning${p.bakerName ? `, ${esc(p.bakerName)}` : ''}. Here's what's going out today.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">${rows}</table>
        <p style="color:#6b6b6b;font-size:13px;">Times shown are what's on each order; a dash means no time was set.</p>`),
    };
  }

  // ── The Spark trial countdown ─────────────────────────────────────────────────────────────────
  // Four sends across one trial (7 days, 2 days, the last day, the morning after) and they must not
  // read as four copies of the same email — somebody who ignored the first one is not persuaded by
  // receiving it again with a different number in it. So the shape changes as the deadline closes:
  // the early one is informational and names what they would lose, the last two are short, and the
  // after-email stops selling urgency it no longer has.
  //
  // ⚠️ The number comes from the PAYLOAD, never from the milestone. A run catching up after a missed
  // day is in the seven-day bucket while three days remain, and an email that says seven when three
  // are left is worse than one that never arrived — see services/trialReminders.js.
  if (typeSlug === 'trial_ending' || typeSlug === 'trial_ended') {
    const ended = typeSlug === 'trial_ended';
    const hiName = p.bakerName ? `, ${esc(p.bakerName)}` : '';
    const when   = esc(p.when ?? 'is ending');
    const last   = Number(p.days) <= 0;

    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      // The subject carries the deadline, because most of these are read in a notification shade
      // and never opened. No exclamation marks and no counting down in the subject of the first
      // one — a week away is information, not an emergency, and treating it as one spends the
      // urgency we actually need on the last day.
      subject: ended
        ? 'Your Spark trial has ended — pick a plan to carry on'
        : last
          ? 'Your Spark trial ends today'
          : `Your Spark trial ${when}`,
      html: shell(ended
        ? `<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">Your trial has ended</h2>
           <p>Hi${hiName} — your Spark trial finished on ${esc(p.endDate)}.</p>
           <p>Your cakes, templates, customers and orders are all still here and nothing has been
              deleted. Choosing a plan picks everything up exactly where you left it.</p>
           ${billingCta}
           <p style="color:#6b6b6b;font-size:13px;">If you have already chosen a plan, you can ignore this.</p>`
        : `<h2 style="margin:0 0 12px;font-size:22px;color:#2C4433;font-weight:800;">
             Your Spark trial ${when}
           </h2>
           <p>Hi${hiName} — your trial runs until <strong>${esc(p.endDate)}</strong>.</p>
           <p>${last
                ? 'After today the designer stops accepting new orders until a plan is chosen. Everything you have made stays exactly as it is.'
                : 'Choosing a plan before then means nothing pauses: your storefront keeps taking orders and your templates stay published.'}</p>
           ${billingCta}
           <p style="color:#6b6b6b;font-size:13px;">Already chosen a plan? Then this one is already out of date — ignore it.</p>`),
    };
  }

  throw new Error(`Unknown notification type: ${typeSlug}`);
}

// ── What a notification says on a lock screen ────────────────────────────────────────────────────
// Returns null for types that should NOT push, and that is the common case. Email can afford to tell
// a baker everything; a push interrupts them, so it has to earn it — which means the list here stays
// short on purpose rather than growing to match buildEmail.
//
// A push is roughly forty characters of title and a place to land. Both matter: an alert that says
// something useful but drops you on a dashboard makes the baker do the finding.
export function buildPush(typeSlug, payload) {
  const p = payload ?? {};

  // The one the whole push conversation started from: a customer asks for a quote and the baker's
  // phone lights up, wherever they are.
  if (typeSlug === 'order_placed_baker') {
    return {
      title: 'New quote request',
      body:  `${p.customerName ?? 'A customer'} wants a cake${p.deliveryDate ? ` for ${p.deliveryDate}` : ''}.`,
      url:   linkFor(typeSlug, p),
      // Collapses to the latest rather than stacking. Three enquiries overnight should be three
      // notifications; the tag is per-order so they do not eat each other.
      tag:   `order:${p.orderId ?? ''}`,
    };
  }

  if (typeSlug === 'delivery_digest_baker') {
    const n = p.count ?? 0;
    return {
      title: n === 1 ? 'One delivery today' : `${n} deliveries today`,
      body:  n === 1
        ? `${p.orders?.[0]?.customerName ?? 'A customer'}${p.orders?.[0]?.deliveryTime ? ` at ${p.orders[0].deliveryTime}` : ''}.`
        : (p.orders ?? []).slice(0, 3).map(o => o.customerName).join(', ') + (n > 3 ? ` and ${n - 3} more` : ''),
      url:   linkFor(typeSlug, p),
      // One digest per day, so a repeat is a correction and should replace rather than pile up.
      tag:   `digest:${p.date ?? ''}`,
    };
  }

  if (typeSlug === 'quote_accepted_baker') {
    return {
      title: 'Quote accepted',
      body:  `${p.customerName ?? 'A customer'} accepted your quote.`,
      url:   linkFor(typeSlug, p),
      tag:   `order:${p.orderId ?? ''}`,
    };
  }

  /* ── The trial deadline, at the two moments it can still be acted on ─────────────────────────
   *
   * ⚠️ THE FIRST PUSH HERE THAT DEPENDS ON THE PAYLOAD. Every other type is push-or-not by slug;
   * this one is the same slug at four different distances from the deadline, and only two of them
   * earn an interruption:
   *
   *   +7  email only — a week out is information, and a buzzing pocket would spend urgency we
   *       need later on something nobody has to act on today
   *   +2  push. Close enough to matter, far enough to do something about it.
   *    0  push. The last chance.
   *   -1  email only — it has already happened. A push cannot change the outcome, and interrupting
   *       somebody to tell them they missed a deadline is a poor way to ask for their money.
   *
   * ⚠️ Silent when `days` is missing rather than guessing. An unknown distance must not buzz a
   * phone — and a payload written before this field existed is exactly the thing that would.
   */
  if (typeSlug === 'trial_ending') {
    const days = Number(p.days);
    if (!Number.isFinite(days) || days < 0 || days > 2) return null;
    // Derived here rather than read from p.when: with the guard above this cannot render undefined,
    // and a payload from an older row may not carry the pre-shaped string at all.
    const label = days === 0 ? 'ends today' : days === 1 ? 'ends tomorrow' : `ends in ${days} days`;
    return {
      title: `Your Spark trial ${label}`,
      body:  days === 0
        ? 'After today your storefront stops taking new orders. Everything you have made stays as it is.'
        : 'Choose a plan and nothing pauses — your storefront keeps taking orders.',
      url:   linkFor(typeSlug, p),
      /* One tag for the whole trial, so the last-day push REPLACES the two-day one rather than
       * stacking beside it. They are the same deadline said twice; a baker who ignored the first
       * does not want both sitting on the lock screen, and the later one is strictly more urgent. */
      tag:   `trial:${p.endDate ?? ''}`,
    };
  }

  // Everything else is email-only. A customer has no app to be pushed to, and a baker does not need
  // their phone to buzz because an invite email went out — nor because a trial they already lost
  // has ended.
  return null;
}

export async function sendNotification({ notificationId }) {
  // Fetch notification with its type
  const { data: notification, error } = await supabase
    .from('notifications')
    .select('*, notification_types(slug)')
    .eq('id', notificationId)
    .single();

  if (error || !notification) throw new Error(`Notification ${notificationId} not found`);

  const typeSlug = notification.notification_types.slug;
  const mail = buildEmail(typeSlug, notification.recipient_email, notification.payload);

  try {
    const result = await sendEmail(mail);
    // 'sent' only means the provider ACCEPTED the message — not that it reached the inbox. Log
    // what the provider actually said (normalized id + response + any rejected recipients) so
    // deliverability problems (sandbox, SPF/DKIM, bounces) are diagnosable from Render logs
    // instead of being invisible behind status=sent.
    console.log('[notifications] sent', JSON.stringify({
      notificationId,
      type:      typeSlug,
      to:        mail.to,
      messageId: result.id,
      response:  result.response,
      accepted:  result.accepted,
      rejected:  result.rejected,
    }));
    await supabase.from('notifications').update({
      status:  'sent',
      sent_at: new Date().toISOString(),
    }).eq('id', notificationId);

    // ── Push, AFTER the email and never instead of it ────────────────────────────────────────────
    // Best-effort on purpose. Email is the durable channel and its status is what `sent` means; push
    // is the fast one. A dead token, an expired credential or a Firebase outage must not fail a
    // notification the baker has already received — and must not mark it for retry, which would
    // re-send the email to fix the push.
    //
    // Deliberately not awaited into the status: this runs, logs, and cannot change the outcome above.
    const push = buildPush(typeSlug, notification.payload);
    if (push && pushConfigured()) {
      try {
        const r = await sendPush({ email: notification.recipient_email, ...push });
        // ALWAYS logged, including the do-nothing outcomes. Logging only successes made the two
        // failures that actually happen — nothing configured, and nobody with a registered device —
        // look identical to push never having been attempted, which is a bad evening.
        console.log('[notifications] push', JSON.stringify({
          notificationId, type: typeSlug, to: notification.recipient_email, ...r,
        }));
      } catch (err) {
        console.error('[notifications] push failed (email already sent)', JSON.stringify({
          notificationId, type: typeSlug, error: err.message,
        }));
      }
    }
  } catch (err) {
    console.error('[notifications] send failed', JSON.stringify({ notificationId, type: typeSlug, to: mail.to, error: err.message }));
    const exhausted = notification.attempts >= notification.max_attempts;
    await supabase.from('notifications').update({
      status:        exhausted ? 'failed' : 'pending',
      error_message: err.message,
      ...(exhausted ? { failed_at: new Date().toISOString() } : {}),
    }).eq('id', notificationId);
  }
}
