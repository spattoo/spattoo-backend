import 'dotenv/config';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'OPENAI_API_KEY',
  'REMOVE_BG_API_KEY',
  'REDIS_URL',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
];

for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

export const config = {
  supabase: {
    url:        process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey:    process.env.SUPABASE_ANON_KEY,  // public key — for customer OTP (signInWithOtp/verifyOtp)
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Image model for "Extract Elements" decoration regeneration. Env-driven because this family
    // churns: dall-e-3 was REMOVED (2026-05-12) and gpt-image-1 is deprecated (2026-10-23).
    //
    // ⚠️ gpt-image-2 (2026-04-21) is now OpenAI's recommended default and this comment used to say
    // it "can't be swapped in blindly" because it has no transparent-background support. That was
    // true of the CODE, not of the model: the parameter was sent unconditionally, so the swap was a
    // rejected request. `modelSupportsTransparent` in services/openai.js now asks first, and the
    // swap is what it always claimed to be — set OPENAI_IMAGE_MODEL and nothing else.
    //
    // ⚠️ CHECK THE PRICE BEFORE SWITCHING. The figures below are gpt-image-1.5's, measured. Public
    // numbers for gpt-image-2 sit around $0.053 for a medium 1024x1024, which is CHEAPER than
    // gpt-image-1 (~$0.07) and DEARER than the 1.5 we run. Third-party sources contradict each
    // other and OpenAI's own pricing page is the only thing worth believing here, so confirm there
    // before this feeds a credit cost.
    // Quality on 1024x1024 (gpt-image-1.5): low ≈ $0.009, medium ≈ $0.034, high ≈ $0.133 per image.
    imageModel:   process.env.OPENAI_IMAGE_MODEL   || 'gpt-image-1.5',
    /* ── A better model where the BAKER pays, the cheaper one where WE do ────────────────────────
     *
     * Per INTENT, not one global, because the two jobs are not alike:
     *
     *   Extract Elements (sticker/relief/model) — admin building the catalogue. Spattoo pays, staff
     *   ask for several variants and pick the best, and a bad one is simply not saved.
     *
     *   print — a baker pressing "generate this" on their own order. Their credits, one attempt,
     *   and it goes straight onto a cake in front of a customer. Higher stakes per call, and the
     *   person bearing the cost is the one who gets the better model.
     *
     * The deciding factor is TEXT: half of what a baker prints is words, gpt-image-2 renders text
     * far more reliably, and a misspelt plaque is the way this feature embarrasses a bakery.
     *
     * ⚠️ Unset falls back to `imageModel`, so this is additive — an intent nobody has an opinion
     * about keeps whatever the global is, and no future intent needs an entry here to work.
     */
    imageModelByIntent: {
      print: process.env.OPENAI_IMAGE_MODEL_PRINT || 'gpt-image-2',
    },
    imageQuality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    // The GUIDE SHEET's quality. LOW BY DEFAULT, and deliberately not inheriting OPENAI_IMAGE_QUALITY
    // — the two do different jobs. An extracted element becomes a permanent library asset; a guide
    // sheet is a tutorial illustration a baker follows once and throws away.
    //
    // Low was CHOSEN, not defaulted to. Compared side by side at 1024x1536 (a monstera leaf,
    // 2026-08-02): the paper template, the Dresden tool, the cut edge and the captions are all
    // legible, and the information on this sheet is SHAPE rather than surface texture — which is
    // exactly what survives a lower budget.
    //
    // It is the single biggest lever on the feature's margin: ~R1.4 a sheet against ~R5.7 at
    // medium, which is a decoration guide at ~87% gross instead of ~62%. Raise it only with a
    // side-by-side comparison in hand, and knowing it quadruples the cost of every guide.
    guideImageQuality: process.env.OPENAI_GUIDE_IMAGE_QUALITY || 'low',
  },
  removeBg: { apiKey: process.env.REMOVE_BG_API_KEY },
  // Background removal for user uploads ("My Decorations"). `removebg` = the paid vendor (metered per
  // image); `self` = our own model on its own Render service (free per image, not built yet). Env-driven
  // so the switch is a config change per environment, instantly reversible — see
  // services/backgroundRemoval.js for why the model can't live in this process.
  bgRemoval: {
    provider:     process.env.BG_REMOVAL_PROVIDER || 'removebg',
    serviceUrl:   process.env.BG_REMOVAL_SERVICE_URL || '',      // Render internal host, e.g. http://spattoo-bgremover:3000
    serviceToken: process.env.BG_REMOVAL_SERVICE_TOKEN || '',    // must match the service's BG_SERVICE_TOKEN
    // Inference measured ~3s on Render. 20s is generous for a slow image and still well short of a
    // baker deciding the page is broken — the point is that SOME deadline exists, because a hung
    // service never fails and so never falls back.
    timeoutMs:    parseInt(process.env.BG_REMOVAL_TIMEOUT_MS || '20000', 10),
    // When our own service is down, let the paid vendor answer (see services/bgFallbackPolicy.js).
    // On by default: an outage otherwise means every upload fails. `off` to disable.
    fallbackToVendor: process.env.BG_REMOVAL_FALLBACK !== 'off',
    // Ceiling on vendor calls per IST day, so our downtime cannot become an unbounded invoice at
    // ~₹15 an image. 0 disables the fallback entirely.
    fallbackDailyCap: parseInt(process.env.BG_REMOVAL_FALLBACK_DAILY_CAP || '200', 10),
  },
  // Meshy.ai image-to-3D. Not in `required[]` (like razorpay/smtp) so local boot
  // doesn't fail without a key — services/meshy.js throws a clear error at call time.
  // The completion webhook URL is configured once in the Meshy dashboard (account-global),
  // pointing at `https://<api-host>/api/webhooks/meshy`.
  meshy:    { apiKey: process.env.MESHY_API_KEY },
  // AI metering. `usdInr` converts a provider's USD token cost into the provider_cost_inr stamped
  // on every debit — the MARGIN GUARDRAIL only. It is never a customer-facing price: retail is
  // credits, and those live in the credit_costs table (data, admin-editable, no deploy). So this
  // number does not have to be exact; it has to not be stale by 20%. Retune per-env from the Render
  // dashboard when the settlement rate drifts. See services/aiCredits.js + AI_CREDITS_PLAN.md §2.2.
  aiCredits: { usdInr: Number(process.env.AI_USD_INR || 90) },
  redis:    { url:    process.env.REDIS_URL },
  // Background job schedules (BullMQ repeatable, cron in UTC). Retime per-env from the Render
  // dashboard without a deploy. Consistent with the UTC convention (see DATETIME_CONVENTIONS).
  jobs: {
    reconcileCron: process.env.RECONCILE_CRON || '0 3 * * *',   // 03:00 UTC daily
    // Billing → accounting outbox relay. A repeatable job drains billing_outbox 'pending' rows and
    // publishes them to the accounting queue (GST_INVOICING_PLAN.md Wave 2). Runs every minute — the
    // outbox is the durability layer, so latency here only affects how quickly an invoice is issued,
    // not correctness. Retime per-env from the Render dashboard without a deploy.
    outboxRelayCron: process.env.OUTBOX_RELAY_CRON || '* * * * *',
    // Cross-service queue name the accounting consumer listens on (shared Redis). MUST match the
    // accounting service's ACCOUNTING_QUEUE_NAME. Never a per-tenant queue — one queue, N events.
    accountingQueueName: process.env.ACCOUNTING_QUEUE_NAME || 'accounting',
    // Scheduled sweep that sends the 48h pre-erasure notice + erases accounts past their window
    // (DPDP "Layer 3", CONSENT_WITHDRAWAL_AND_ERASURE_PLAN.md). UTC. Retime per-env without a deploy.
    eraseAccountsCron: process.env.ERASE_ACCOUNTS_CRON || '30 3 * * *',   // 03:30 UTC daily
    // The baker's morning "what's going out today" digest. UTC like every schedule here, so the
    // default is 01:30 UTC = 07:00 IST — early enough to shape the day, late enough not to be an
    // alarm clock. Retime per-env from the Render dashboard without a deploy.
    deliveryDigestCron: process.env.DELIVERY_DIGEST_CRON || '30 1 * * *',
    // The Spark trial countdown. 02:00 UTC = 07:30 IST — after the delivery digest, so a baker with
    // both gets the day's work first and the billing note second. Retime per-env without a deploy.
    trialReminderCron: process.env.TRIAL_REMINDER_CRON || '0 2 * * *',
    // Which zone "days left" is counted in. SEPARATE from the cron for the same reason the digest's
    // is: the cron says WHEN to look, this says WHICH DAY it is where the baker is. Every bakery on
    // dev is Asia/Kolkata, 5.5 hours from the UTC the job runs in — so for a third of every day a
    // server-clock answer is off by one, and "ends tomorrow" on the last morning is a lie.
    trialReminderTz: process.env.TRIAL_REMINDER_TZ || 'Asia/Kolkata',
    // Which timezone "today" means when the digest runs. SEPARATE from the cron, because they answer
    // different questions: the cron says WHEN to look, this says WHICH DAY to look at. Run at 01:30
    // UTC and ask the server what day it is and you get the right answer by luck — 01:30 UTC and
    // 07:00 IST are the same date. Move the cron an hour earlier and it silently becomes yesterday's
    // deliveries, with nothing failing.
    //
    // One value, not per-baker, because every baker is in India today. The day that stops being true
    // this becomes a column on bakers and the digest fans out per zone — which is why the job reads
    // it from config rather than hardcoding a string it would then have to find again.
    deliveryDigestTz: process.env.DELIVERY_DIGEST_TZ || 'Asia/Kolkata',
  },
  // Data-retention windows (DPDP storage-limitation). CONFIG, not hardcoded — tune per-env and get
  // counsel sign-off before launch (see plan §6). All in DAYS / HOURS.
  retention: {
    // Delay between a baker's delete request and irreversible erasure — the reversal + statutory
    // floor window. 365d is a conservative PLACEHOLDER pending counsel sign-off.
    accountWindowDays:     Number(process.env.RETENTION_WINDOW_DAYS || 365),
    // Lead time for the Rule-8 pre-erasure notice.
    preErasureNoticeHours: Number(process.env.PRE_ERASURE_NOTICE_HOURS || 48),
  },
  // The ceiling on a single signed upload, in MB, per KIND of asset. CONFIG, not a constant: this is a
  // number we will want to MOVE — a customer on a 200MP phone hits it, or an abuse pattern says tighten
  // it — and neither should cost a deploy. Retune it in the Render dashboard, restart, done.
  //
  // The API is the ONE source of truth: the browser needs the same number (to refuse a file at the
  // moment it is picked, rather than after an upload it will then reject), so it READS it from
  // GET /api/storage/limits. Hardcoding it in the client too would mean two numbers that silently
  // disagree — the client would go on accepting what the server 413s.
  //
  // 5MB for an image is measured against the file the user PICKS. What lands in R2 is far smaller: the
  // designer downscales to 2048 and re-encodes to WebP first (~200-500KB). The exception is a browser
  // with no canvas WebP encoder, where the original is uploaded untouched — which is exactly why the
  // server's ceiling and the client's pick limit must be the SAME number.
  uploads: {
    maxImageMb: Number(process.env.UPLOAD_MAX_IMAGE_MB || 5),
    maxModelMb: Number(process.env.UPLOAD_MAX_MODEL_MB || 75),   // GLB — admin-only today; no user path uploads one
    maxFontMb:  Number(process.env.UPLOAD_MAX_FONT_MB  || 5),
  },
  r2: {
    endpoint:        process.env.R2_ENDPOINT,
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket:          process.env.R2_BUCKET,
    publicUrl:       process.env.R2_PUBLIC_URL,
  },
  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID,
    keySecret:     process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    // Plan IDs are read dynamically from env using RAZORPAY_PLAN_{TIER}_{PERIOD}
    // e.g. RAZORPAY_PLAN_FLAME_MONTHLY, RAZORPAY_PLAN_BLAZE_QUARTERLY, etc.
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    // ── Who at Spattoo is copied on the emails we want to know about ──────────────────────────
    // A blind copy on a SHORT LIST of notifications (sendNotification.js `BCC_TYPES`), not on every
    // email — a BCC in mailer.js would copy us on every order, quote and reminder a customer gets,
    // which is a flood and somebody else's mail.
    //
    // A blind copy rather than a second message because the useful facts are already in the one the
    // baker gets: the To header names them, the body carries their bakery and their storefront
    // slug. A separate internal mail would restate all of it and be a template to keep in step.
    //
    // Configurable per environment, with a default so dev and prod both work the day this ships
    // rather than the day somebody remembers to set a variable. Set it empty to switch the copies
    // off entirely.
    internalBcc: process.env.INTERNAL_NOTIFY_EMAIL ?? 'sandeep@spattoo.com',
  },
  // Cloudflare Turnstile. The app's login has used the widget for a while, but Supabase verified
  // those tokens — this is the first SECRET we hold, for endpoints of our own with no such backstop.
  // Unset means not enforced (see services/turnstile.js), like smtp/razorpay/fcm.
  turnstile: {
    secretKey: process.env.TURNSTILE_SECRET_KEY,
  },
  // ── Demo requests from the public marketing site ────────────────────────────────────────────
  // Leads live in their OWN Supabase project, deliberately: they are prospect PII belonging to
  // people who are not customers, and keeping them out of the app database limits what a mistake in
  // either one can reach.
  //
  // The SERVICE key, and only ever server-side. The previous version of this feature put that
  // project's ANON key in the marketing site's browser bundle, which let anyone POST rows straight
  // to the table — bypassing the form, the validation and every limit. It was removed under
  // SEC-WEB-1 and must not come back; see routes/demoRequest.js.
  //
  // Optional, like smtp/razorpay: unset simply means the endpoint reports itself unavailable rather
  // than the server failing to boot.
  leads: {
    url:        process.env.LEADS_SUPABASE_URL,
    serviceKey: process.env.LEADS_SUPABASE_SERVICE_KEY,
    // `waitlist` — the table already there. It began as the pre-launch waitlist and now takes
    // demo requests too, which is why the row carries a `source`: without it the two kinds are
    // indistinguishable the moment anyone asks how many demos were requested.
    table:      process.env.LEADS_TABLE || 'waitlist',
    // Where the "someone asked for a demo" note goes. An address, not a person — so it can become a
    // shared inbox without a code change.
    notify:     process.env.DEMO_REQUEST_NOTIFY || 'sandeep@spattoo.com',
  },
  // Push notifications — Firebase Cloud Messaging. Optional (like razorpay/smtp/sms) so a
  // deployment without it simply never pushes; email is the durable channel either way.
  //
  // The WHOLE service-account JSON in one var, not split into project_id/client_email/private_key.
  // The private key is multi-line, and three vars is three chances to paste half of one — a single
  // blob either parses or it does not. Parsed lazily in services/fcm.js so a malformed value breaks
  // pushes rather than the API's boot.
  //
  // THIS IS THE SECRET. Everything the browser holds (apiKey, projectId, the VAPID public key) is
  // public by design and identifies the project without authorising anything. This authorises.
  fcm: { serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '' },
  // Outbound SMS — today MSG91, and ONLY ever a delivery pipe. The OTP itself is minted and
  // checked by Supabase, because verify-otp has to hand back a Supabase SESSION (storefront.js)
  // and POST /api/orders reads the verified contact off that token. A provider's own
  // generate-and-verify OTP product cannot produce that session, so adopting one would mean
  // rebuilding the whole trust chain to save a webhook. The provider lives behind
  // services/msg91.js, same as the mailer hides nodemailer.
  //
  // All optional (like razorpay/smtp) so local boot never fails without them; smsConfigured()
  // is what callers check. Nothing here is read unless Supabase's Send SMS hook fires, which
  // in turn only happens once STOREFRONT_OTP_CHANNELS includes `sms`.
  sms: {
    authKey:    process.env.MSG91_AUTH_KEY,
    // MSG91 OTP template. WITHOUT DLT clearance this is the default template from the panel's
    // channel settings — it delivers, but carries no branding and logs nothing in the OTP
    // section. See the STOREFRONT_OTP_CHANNELS note below for why `sms` stays off until DLT.
    templateId: process.env.MSG91_TEMPLATE_ID,
    // Shared secret from the Supabase dashboard (Authentication → Hooks), issued in the form
    // `v1,whsec_<base64>`. Stored verbatim; the `v1,whsec_` prefix is stripped at verify time.
    hookSecret: process.env.SEND_SMS_HOOK_SECRET,
  },
  // Error telemetry. DSN is optional (like meshy/razorpay) so local boot never
  // fails without it — telemetry falls back to structured console logging.
  // The vendor lives behind src/lib/telemetry.js; swapping Sentry for GlitchTip
  // (Sentry-API-compatible) or a self-hosted sink is a one-file change there.
  telemetry: {
    dsn:         process.env.SENTRY_DSN,
    // NOT NODE_ENV alone. Both Render services run NODE_ENV=production — the dev one deliberately,
    // because it is a production build — so deriving the Sentry environment from it labels every
    // dev error `production`. Sharing one Sentry project would then make dev noise
    // indistinguishable from a real incident, and even in a separate project every event reads as
    // production, which is worse than useless when you are trying to tell them apart at 2am.
    //
    // SENTRY_ENVIRONMENT is the override. Unset, behaviour is exactly as before.
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    // Release = git SHA for "which deploy introduced this error" + suspect-commits.
    // Render auto-provides RENDER_GIT_COMMIT, so no manual env needed in prod.
    release:     process.env.RELEASE_VERSION || process.env.RENDER_GIT_COMMIT,
  },
  // Customer storefront URL template; `{slug}` is replaced with the baker slug
  // (subdomain model). Invite link = `${template-with-slug}/?invite=<id>`.
  //   dev:  http://{slug}.localhost:5173
  //   prod: https://{slug}.spattoo.com
  storefront: {
    urlTemplate: process.env.STOREFRONT_URL_TEMPLATE || 'https://{slug}.spattoo.com',
    // Must a storefront visitor prove their phone by OTP before an enquiry sends?
    //
    // DEFAULTS TO TRUE, and the opt-out is deliberately noisy (an explicit env var, never a silent
    // default), because switching it off does two things at once:
    //
    //   1. the storefront collects a phone number nobody has checked, so a typo'd digit produces an
    //      enquiry the baker cannot answer — and they lose the attempt as well as the order
    //   2. POST /api/orders accepts ANONYMOUS requests again, which is what the OTP replaced. There
    //      is no rate limit standing behind it; the verified contact WAS the protection.
    //
    // Set STOREFRONT_OTP_REQUIRED=false only while SMS delivery is unavailable, and treat it as a
    // temporary state. One switch rather than two: the client reads this back from
    // GET /storefront/:slug/settings rather than carrying its own flag, so the two can never
    // disagree about whether an enquiry needs proving.
    otpRequired: process.env.STOREFRONT_OTP_REQUIRED !== 'false',
    // Which channels a storefront visitor may verify on. Comma-separated: sms | email.
    //
    // DEFAULTS TO EMAIL ONLY, and that is deliberate rather than timid. Sending an SMS to an Indian
    // number requires DLT registration — entity, header, and per-template approval — and telcos
    // scrub unregistered traffic at the network level. A channel offered but undeliverable is the
    // worst of both: the customer picks it, waits for a code that was blocked upstream, and
    // abandons. Better to offer only what is known to arrive.
    //
    // Add `sms` the day the provider is live and DLT has cleared:  STOREFRONT_OTP_CHANNELS=sms,email
    //
    // ORDER MATTERS — the first entry is what the client offers first, so this is also how you say
    // "prefer phone" once phone works. Served on /storefront/:slug/settings so the client offers
    // exactly what the server will accept; enforced in the handlers too, because a UI that only
    // shows one option is not a restriction.
    otpChannels: (process.env.STOREFRONT_OTP_CHANNELS || 'email')
      .split(',').map(c => c.trim().toLowerCase())
      .filter(c => ['sms', 'email'].includes(c)),
  },
  // Baker-facing app base URL, for deep links in lifecycle emails (billing/settings). Optional —
  // the email CTA is omitted when unset, so no broken links. e.g. https://app.spattoo.com
  app: { url: process.env.APP_URL || '' },
  // SEC-8 — CORS allowlist. `baseDomain` is derived from the storefront template so ALL storefront
  // subdomains ({slug}.<base>) + app/marketing match ONE wildcard rule (O(1) in tenants, never a
  // per-baker list). Override with CORS_BASE_DOMAIN if the API host differs. `allowLocalhost` keeps
  // local dev + the local admin tool working; set CORS_ALLOW_LOCALHOST=false to harden prod.
  // `extraOrigins` (CORS_ALLOWED_ORIGINS, comma-separated) is for any one-off exact origins.
  cors: {
    baseDomain: process.env.CORS_BASE_DOMAIN
      || (process.env.STOREFRONT_URL_TEMPLATE || 'https://{slug}.spattoo.com')
           .replace('{slug}.', '').replace(/^https?:\/\//, '').replace(/[:/].*$/, ''),
    allowLocalhost: process.env.CORS_ALLOW_LOCALHOST !== 'false',
    extraOrigins: (process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  },
  port:     parseInt(process.env.PORT || '3000', 10),
};
