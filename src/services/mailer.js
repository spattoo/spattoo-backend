import nodemailer from 'nodemailer';
import { config } from '../config.js';

// ── The ONE place email is sent. ─────────────────────────────────────────────
// Every app email (outbox notifications + the direct staff-welcome) goes through sendEmail().
// The PROVIDER lives behind this file — nodemailer/SMTP today; dropping in Resend (SMTP repoint
// OR the resend SDK) is a change to THIS file only, no caller touched. Same pattern as the
// telemetry vendor behind lib/telemetry.js.
//
// Callers pass a provider-neutral message { from, to, subject, html, text } (exactly the shape
// buildEmail already returns) and get back a normalized result { id, response, accepted, rejected }
// so send-logging never depends on the provider's response shape.

const transporter = nodemailer.createTransport({
  host:   config.smtp.host,
  port:   config.smtp.port,
  secure: config.smtp.port === 465,
  auth: { user: config.smtp.user, pass: config.smtp.pass },
});

// Is a sender configured? Direct (non-outbox) senders check this to no-op in envs without SMTP.
export function mailConfigured() {
  return !!(config.smtp.host && config.smtp.user);
}

// Send one email. Throws on provider failure — the caller decides how to react (the outbox
// records status + retries; fire-and-forget callers swallow). `from` defaults to the platform
// sender when omitted.
export async function sendEmail({ from, to, subject, html, text }) {
  const info = await transporter.sendMail({
    from: from || config.smtp.from,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
  });
  return {
    id:       info?.messageId ?? null,
    response: info?.response ?? null,
    accepted: info?.accepted ?? [],
    rejected: info?.rejected ?? [],
  };
}
