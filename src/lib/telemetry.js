// ── Centralised error telemetry (backend) ────────────────────────────────────
// VENDOR-NEUTRAL: every caller uses captureError()/logError() from this module
// and NEVER imports a vendor SDK directly. The vendor (Sentry) is isolated to the
// `sentryTransport` below — to switch to GlitchTip (Sentry-API-compatible) or a
// self-hosted/DIY sink, replace ONLY that transport. Call sites never change.
//
// Activation is automatic and safe:
//   • SENTRY_DSN set + @sentry/node installed → events go to Sentry.
//   • otherwise → structured JSON to the console (works with zero deps).
// So Phase 0 runs today; you flip on Sentry later by setting the env var.
//
// Concurrency note: a Node server handles many requests at once, so we NEVER set
// global user/tag context (that would leak baker A's id onto baker B's error).
// All context is passed per-call and applied to an isolated scope.

import { config } from '../config.js';

const { dsn, environment, release } = config.telemetry;

let transport = consoleTransport();   // safe default until init() upgrades it

// ── Public API ────────────────────────────────────────────────────────────────

// Call once at process startup (index.js). Installs the chosen transport and
// last-resort process handlers so nothing crashes the server unobserved.
export async function initTelemetry() {
  if (dsn) {
    try {
      transport = await sentryTransport();
      console.log(`[telemetry] Sentry transport active (${environment})`);
    } catch (err) {
      console.warn(`[telemetry] Sentry init failed, using console transport: ${err.message}`);
    }
  } else {
    console.log('[telemetry] no SENTRY_DSN — using console transport');
  }

  process.on('unhandledRejection', (reason) => {
    captureError(reason instanceof Error ? reason : new Error(String(reason)), {
      action: 'unhandledRejection', severity: 'fatal',
    });
  });
  process.on('uncaughtException', (err) => {
    captureError(err, { action: 'uncaughtException', severity: 'fatal' });
  });
}

// The one call everything funnels through.
// context: { requestId, bakerId, customerId, role, route, method, screen, action, severity, extra }
export function captureError(error, context = {}) {
  try {
    transport.capture(error, context);
  } catch (e) {
    // Telemetry must never throw into the caller.
    console.error('[telemetry] capture failed:', e?.message, '| original:', error?.message);
  }
}

// Convenience for Express: pulls the standard fields off the request so routes
// and the error handler don't re-derive them. `req.bakerId`/`customerId`/`role`
// are populated by rbac.js; `req.id` by the requestId middleware.
export function logError(error, req, extra = {}) {
  captureError(error, {
    requestId:  req?.id,
    bakerId:    req?.bakerId ?? null,
    customerId: req?.customerId ?? null,
    role:       req?.role ?? null,
    route:      req?.originalUrl,
    method:     req?.method,
    screen:     req?.route?.path,          // matched express route, e.g. /admin/bakers
    ...extra,
  });
}

// ── Transports (vendor isolation boundary) ───────────────────────────────────

// Structured console fallback — also what you see in Render logs.
function consoleTransport() {
  return {
    capture(error, ctx) {
      const payload = {
        level: ctx.severity || 'error',
        message: error?.message || String(error),
        ...ctx,
        time: new Date().toISOString(),
        stack: error?.stack,
      };
      console.error('[error]', JSON.stringify(payload));
    },
  };
}

// Sentry transport — the ONLY place the vendor SDK is referenced.
async function sentryTransport() {
  const Sentry = await import('@sentry/node');   // dynamic: not a hard dependency
  Sentry.init({ dsn, environment, release, tracesSampleRate: 0 });

  return {
    capture(error, ctx) {
      Sentry.withScope((scope) => {            // isolated scope — no cross-request leak
        if (ctx.bakerId || ctx.customerId) {
          scope.setUser({ id: ctx.customerId || ctx.bakerId });
        }
        scope.setTags({
          surface:     'api',
          baker_id:    ctx.bakerId ?? 'none',
          customer_id: ctx.customerId ?? 'none',
          role:        ctx.role ?? 'none',
          screen:      ctx.screen ?? ctx.route ?? 'unknown',
          action:      ctx.action ?? 'unknown',
        });
        scope.setContext('request', {
          id: ctx.requestId, route: ctx.route, method: ctx.method,
        });
        if (ctx.extra) scope.setContext('extra', ctx.extra);
        if (ctx.severity) scope.setLevel(ctx.severity === 'fatal' ? 'fatal' : 'error');
        // A caller may pass a non-Error (e.g. a Supabase/PostgREST error is a plain
        // { message, code, details, hint } object). new Error(String(obj)) would capture
        // "[object Object]" and lose the message, so build the Error from `.message` and
        // carry the DB fields as context — otherwise every DB error groups as one useless issue.
        let ex = error;
        if (!(error instanceof Error)) {
          ex = new Error(error?.message || String(error));
          if (error?.code) ex.code = error.code;
          scope.setContext('cause', { code: error?.code, details: error?.details, hint: error?.hint });
        }
        Sentry.captureException(ex);
      });
    },
  };
}
