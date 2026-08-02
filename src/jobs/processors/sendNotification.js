import { config } from '../../config.js';
import { supabase } from '../../services/supabase.js';
import { sendEmail } from '../../services/mailer.js';
import { esc, escUrl } from '../../lib/htmlEscape.js';

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

function buildEmail(typeSlug, recipientEmail, payload) {
  const p = payload;

  const thumbUrl = escUrl(p.thumbnailUrl);
  const thumbnailHtml = thumbUrl
    ? `<img src="${thumbUrl}" alt="Cake design" style="display:block;max-width:100%;border-radius:8px;margin:16px 0" />`
    : '';

  if (typeSlug === 'order_placed_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `New quote request — ${p.customerName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">New quote request</h2>
        <p>You have a new cake quote request from <b>${esc(p.customerName)}</b>. Review the design and send them a quote.</p>
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
        <p>Hi ${esc(p.customerFirstName)}, thanks for designing your cake with <b>${esc(p.bakerName)}</b>. Your request has been sent — <b>${esc(p.bakerName)}</b> will review your design and get back to you with a quote. Here's what you requested:</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px">We'll email you as soon as your quote is ready. If you have any questions, contact your baker directly.</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'design_updated_customer') {
    const isReco = p.mode === 'recommendations';
    const link = p.bakerSlug
      ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug)
      : null;
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
        <p style="margin-top:16px">Thank you for ordering.${base ? ` Design another anytime with <a href="${escUrl(base)}" style="color:#2C4433;font-weight:700">${esc(p.bakerName)}</a>.` : ''}</p>
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
          <li>Publish your storefront${storefrontLc ? ` at <b>${esc(storefrontLc)}</b>` : ''}</li>
          <li>Invite your first customer to design a cake</li>
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

  throw new Error(`Unknown notification type: ${typeSlug}`);
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
