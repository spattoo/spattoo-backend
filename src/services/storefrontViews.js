import { supabase } from './supabase.js';
import { config } from '../config.js';

// Counting a storefront visit. Answers "is this baker's storefront being used at all" — see
// migrations/088_storefront_views.sql for why this is a first-party counter and not Google
// Analytics, and spattoo-docs/plans/analytics.md for the whole picture.
//
// ⚠️ THE ONE RULE: NOTHING IN HERE MAY EVER AFFECT THE STOREFRONT.
//
// This is internal bookkeeping riding along on the request that serves a customer their baker's
// shop. A counter that breaks a storefront has done far more damage than the number was ever worth.
// That is enforced STRUCTURALLY, not by being careful:
//
//   1. `recordStorefrontView` returns undefined and NEVER THROWS. Every path is inside a try/catch,
//      so a synchronous failure (a malformed request, an unset client) cannot escape to the caller.
//   2. The database call is NEVER AWAITED, so a slow or hanging Supabase cannot delay the response.
//   3. The promise carries its own `.catch`, so a rejection can never surface as an unhandled
//      rejection — which, depending on the Node flags this runs under, can take the whole process
//      down. This is the failure that would turn a counter bug into an outage.
//   4. The caller invokes it AFTER `res.json(...)`. Even in the impossible case that something did
//      escape, the customer's response has already been sent and cannot be affected.
//
// Failures are a `console.warn` and nothing more — deliberately NOT `logError`, which reports to
// telemetry. A Supabase blip would otherwise raise one alert per storefront visit, and this number
// is not worth waking anyone. Same fail-quiet posture as middleware/rateLimit.js.

// Automated clients that must not count as visits.
//
// Link-preview fetchers matter more than crawlers here: a baker sharing their storefront on WhatsApp
// makes ONE post and generates a fetch per recipient whose client unfurls it. Counted, a single share
// would look like a traffic spike, which is precisely the false signal this table exists to avoid.
//
// Search crawlers reach prod storefronts for real — apps/app/proxy.ts marks only spattoo.com hosts
// indexable, and Googlebot RENDERS JAVASCRIPT, so it does run the client fetch that calls this.
const AUTOMATED_UA = new RegExp(
  [
    'bot', 'crawl', 'spider', 'slurp',              // generic crawlers, incl. Googlebot/bingbot
    'facebookexternalhit', 'whatsapp', 'telegram',  // link-preview unfurlers
    'twitterbot', 'linkedinbot', 'slackbot', 'discordbot', 'embedly', 'preview',
    'headless', 'phantom', 'puppeteer', 'playwright', 'selenium',  // automation
    'lighthouse', 'pagespeed', 'gtmetrix',          // auditing
    'pingdom', 'uptime', 'monitor', 'curl', 'wget', 'python-requests',
  ].join('|'),
  'i',
);

/** Is this request from something that should not be counted as a person looking at a shop? */
export function isAutomated(userAgent) {
  // No user-agent at all is not a browser a customer is using.
  if (!userAgent) return true;
  return AUTOMATED_UA.test(userAgent);
}

/**
 * Today's date in the baker's timezone, as `YYYY-MM-DD`.
 *
 * NOT the server's date. The API runs in UTC, where the day rolls over at 05:30 IST — so for the
 * first five and a half hours of every Indian morning, a server-clock answer is YESTERDAY. The
 * evening traffic that matters most to a cake shop is fine either way; the early-morning rows would
 * silently land on the wrong day, and nothing would fail.
 *
 * `en-CA` is not decoration: its default date format IS `YYYY-MM-DD`, which is exactly a Postgres
 * `date` literal, so this needs no assembly and no padding.
 */
export function dayIn(timeZone = config.storefront.viewsTz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/**
 * Count one storefront visit. Fire-and-forget: returns immediately, never throws, never rejects.
 *
 * Call it AFTER the response has been sent. See the header comment for why each of those matters.
 *
 * @param {string} bakerId  the baker whose storefront was actually SERVED (not merely requested)
 * @param {import('express').Request} req
 */
export function recordStorefrontView(bakerId, req) {
  try {
    if (!bakerId) return;
    if (isAutomated(req?.headers?.['user-agent'])) return;

    // No `await` — the handler must not wait on this, ever.
    supabase
      .rpc('increment_storefront_view', { p_baker_id: bakerId, p_day: dayIn() })
      .then(({ error }) => {
        if (error) console.warn('[storefrontViews] increment failed:', error.message);
      })
      .catch((err) => console.warn('[storefrontViews] increment threw:', err?.message ?? err));
  } catch (err) {
    // Reached only if something failed BEFORE the promise existed (e.g. a malformed request object).
    console.warn('[storefrontViews] skipped:', err?.message ?? err);
  }
}
