import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendEmail, mailConfigured } from '../services/mailer.js';
import { verifyTurnstile, turnstileConfigured } from '../services/turnstile.js';
import { serverError } from '../lib/httpError.js';

// ── "Request a demo", from the public marketing site ─────────────────────────────────────────────
//
// The one UNAUTHENTICATED endpoint whose job is to write a row and send an email, which makes it the
// most attackable surface we have. Everything below is about that.
//
// ── WHY IT IS HERE AND NOT ON THE MARKETING SITE ────────────────────────────────────────────────
// The obvious alternative was SMTP credentials in the marketing app's Vercel env. Three reasons not
// to: mailer.js says in its own first line that it is THE one place email is sent (a second path
// means two credentials to rotate and two senders to keep aligned with SPF/DKIM); rateLimit.js
// already exists here and nothing equivalent exists there; and SMTP from a serverless function is
// flaky enough that it usually ends in adding a second provider too.
//
// ── WHAT THE PREVIOUS VERSION GOT WRONG ─────────────────────────────────────────────────────────
// It wrote leads from the BROWSER, with the leads project's anon key in the production bundle
// (lib/supabase-leads.ts, removed under SEC-WEB-1). Anyone could POST rows straight to the table,
// skipping the form, the validation and every limit here — and RLS was the only thing between the
// public and the lead list. The database being separate was never the problem; the browser holding
// a key to it was. This writes server-side with the service key and the browser holds nothing.
//
// ── THE THREAT, HONESTLY ────────────────────────────────────────────────────────────────────────
// The recipient is FIXED, so this can never relay spam to strangers — the damage a bot can do is
// flood one inbox and, worse, burn the sending reputation of the domain that also sends order and
// trial email. So the limits below protect deliverability more than they protect the inbox.
//
// Defence is layered because each layer is individually weak:
//   honeypot   — costs nothing, catches the dumb majority that fills every field
//   per-IP     — the blunt ceiling
//   per-email  — survives a rotating-IP botnet, which per-IP alone does not
//   validation — bounded lengths, so a row cannot become a megabyte of prose
//   store-then-email — a lead is never lost to an SMTP hiccup
//
//   captcha    — the layer that actually stops a script, because a script never loaded the page and
//                so never got a token. The honeypot only catches bots that fill every field; one
//                that reads this form and posts the right JSON walks past it and into Turnstile.
//
// The captcha is checked FIRST, before the honeypot and before any parsing: it is the cheapest way
// to end a request that was never going to be legitimate, and it keeps junk out of the rate
// limiters' counters as well.

const router = express.Router();

// Two windows on the same act, because they fail differently. A single IP hammering the form is
// caught by the first; a botnet with one address per request is only caught by the second.
const perIp = rateLimit({
  name: 'demo-request-ip', limit: 5, windowSec: 3600, key: req => req.ip,
  message: 'Too many requests. Please try again later, or email us directly.',
});
const perEmail = rateLimit({
  name: 'demo-request-email', limit: 3, windowSec: 86400,
  key: req => String(req.body?.email ?? '').trim().toLowerCase() || req.ip,
  message: 'We already have your request — we will be in touch shortly.',
});

// Bounded, trimmed, and never trusted. `max` is per field so a single request cannot carry a
// megabyte of prose into the database or the email body.
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// Deliberately loose. A rejected real address costs a lead; a bad one costs one bounced email, and
// the row is kept either way. Erring towards accepting is the cheaper mistake here.
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

// Escape everything that reaches the notification's HTML. The body is entirely attacker-controlled
// and lands in a mail client that will happily render markup.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let leadsClient = null;
function leadsDb() {
  if (leadsClient) return leadsClient;
  if (!config.leads.url || !config.leads.serviceKey) return null;
  leadsClient = createClient(config.leads.url, config.leads.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return leadsClient;
}

router.post('/public/demo-request', perIp, perEmail, async (req, res) => {
  try {
    const b = req.body ?? {};

    // ── Captcha, before anything else ───────────────────────────────────────────────────────────
    // Unlike the rate limiter this fails CLOSED — see services/turnstile.js for why the two differ.
    // Not configured is not the same as broken: with no secret key it does not enforce, and the
    // other layers carry the endpoint.
    if (!(await verifyTurnstile(b.captchaToken, req.ip))) {
      return res.status(400).json({ error: 'Could not verify you are human. Please try again.', code: 'CAPTCHA_FAILED' });
    }

    // ── Honeypot ────────────────────────────────────────────────────────────────────────────────
    // A field no human sees and no human fills. Answered with the SAME 200 a real submission gets:
    // telling a bot it was detected only teaches whoever wrote it to stop filling that field.
    if (clean(b.website, 200)) return res.json({ ok: true });

    const lead = {
      first_name:      clean(b.firstName, 80),
      last_name:       clean(b.lastName, 80),
      email:           clean(b.email, 160).toLowerCase(),
      mobile:          clean(b.mobile, 40),
      city:            clean(b.city, 120),
      brand_name:      clean(b.brandName, 160),
      cakes_per_month: clean(b.cakesPerMonth, 40),
      source:          'marketing-site',
    };

    // The minimum that makes a lead followable: a name, and a way to reach them.
    if (!lead.first_name || (!looksLikeEmail(lead.email) && !lead.mobile)) {
      return res.status(400).json({ error: 'Please give your name and an email or phone number.' });
    }

    const db = leadsDb();
    if (!db) {
      // Unconfigured is not the visitor's problem, and pretending it worked would lose them.
      console.error('[demo-request] LEADS_SUPABASE_URL / _SERVICE_KEY are not set — lead not stored');
      return res.status(503).json({ error: 'We could not record that just now. Please email us directly.' });
    }

    // ── Store FIRST, email second ───────────────────────────────────────────────────────────────
    // The row is the record; the email is a notification. Reversed, an SMTP hiccup would lose a
    // sales lead silently — the failure nobody notices, because nothing is there to be missed.
    const { error } = await db.from(config.leads.table).insert(lead);
    if (error) {
      console.error('[demo-request] insert failed:', error.message);
      return res.status(503).json({ error: 'We could not record that just now. Please email us directly.' });
    }

    // Best effort. The lead is already safe, so a mail failure must not turn a successful capture
    // into an error the visitor sees — they would submit again, and we would have two rows.
    if (mailConfigured()) {
      const rows = [
        ['Name',      `${lead.first_name} ${lead.last_name}`.trim()],
        ['Bakery',    lead.brand_name],
        ['City',      lead.city],
        ['Email',     lead.email],
        ['Phone',     lead.mobile],
        ['Cakes/mo',  lead.cakes_per_month],
      ].filter(([, v]) => v);
      sendEmail({
        to: config.leads.notify,
        subject: `Demo request — ${lead.brand_name || lead.first_name}`,
        text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
        html: `<h2 style="font-family:sans-serif">Demo request</h2><table style="font-family:sans-serif;font-size:14px">${
          rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')
        }</table>`,
      }).catch(e => console.error('[demo-request] notify email failed:', e.message));
    }

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
