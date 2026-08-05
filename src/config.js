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
    // churns: dall-e-3 was REMOVED (2026-05-12) and gpt-image-1 is deprecated (2026-10-23). The
    // successor gpt-image-2 does NOT support transparent backgrounds, so it can't be swapped in
    // blindly for cut-out assets — see services/openai.js generateDecorationImage.
    // Quality on 1024x1024: low ≈ $0.009, medium ≈ $0.034, high ≈ $0.133 per image.
    imageModel:   process.env.OPENAI_IMAGE_MODEL   || 'gpt-image-1.5',
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
    environment: process.env.NODE_ENV || 'development',
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
