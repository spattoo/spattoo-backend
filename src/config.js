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
  openai:   { apiKey: process.env.OPENAI_API_KEY },
  removeBg: { apiKey: process.env.REMOVE_BG_API_KEY },
  // Meshy.ai image-to-3D. Not in `required[]` (like razorpay/smtp) so local boot
  // doesn't fail without a key — services/meshy.js throws a clear error at call time.
  // The completion webhook URL is configured once in the Meshy dashboard (account-global),
  // pointing at `https://<api-host>/api/webhooks/meshy`.
  meshy:    { apiKey: process.env.MESHY_API_KEY },
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
  storefront: { urlTemplate: process.env.STOREFRONT_URL_TEMPLATE || 'https://{slug}.spattoo.com' },
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
