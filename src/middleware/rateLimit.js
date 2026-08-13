// SEC-4 — Redis-backed rate limiting.
//
// One reusable factory, applied per-route with route-appropriate keys/limits (DRY: no per-route
// copy of the counting logic). Fixed-window counter in Redis, incremented atomically so concurrent
// requests can't race past the limit or leave a key without a TTL.
//
// Design choices:
//  - Keyed on the STABLE abuse unit (invite id, auth user id, phone) where one exists, falling back
//    to client IP only when that's all we have — so limits hold behind shared IPs/NAT and can't be
//    dodged by rotating IPs. (Requires `trust proxy` so req.ip is the real client, not the proxy.)
//  - FAIL-OPEN: a limiter must never take the site down. If Redis is unreachable we log and allow —
//    the app already hard-depends on Redis (BullMQ jobs/email), so this doesn't widen the blast radius,
//    and it's strictly better than locking every legitimate user out on a transient blip.

import IORedis from 'ioredis';
import { config } from '../config.js';

// Dedicated client (module singleton → O(1) connections regardless of how many limiters exist).
// Separate from the BullMQ connection: that one sets maxRetriesPerRequest:null for blocking ops;
// a limiter wants commands to fail FAST on an outage so it can fail-open, not hang.
let client = null;
if (config.redis?.url) {
  client = new IORedis(config.redis.url, {
    tls: config.redis.url.startsWith('rediss://') ? {} : undefined,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,   // reject immediately while disconnected → fail-open, don't queue
    lazyConnect: false,
  });
  // Prevent an unhandled 'error' from crashing the process; the per-request catch fails open.
  client.on('error', (err) => console.warn('[rateLimit] redis error:', err.message));
}

// Atomic incr-and-expire: sets the TTL only on the first hit of a window, then reports the count and
// remaining TTL in one round-trip (so a failed EXPIRE can never leave a stuck, never-expiring key).
const SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('TTL', KEYS[1])}
`;

/**
 * @param {object}   opts
 * @param {string}   opts.name       stable bucket name (namespaces the redis key)
 * @param {number}   opts.limit      max requests allowed per window
 * @param {number}   opts.windowSec  window length in seconds
 * @param {(req)=>string|null|undefined} opts.key  identifier to bucket by; null/undefined → skip limiting
 * @param {string}  [opts.message]   429 body message
 * @param {object}  [opts.client]    injected redis client (tests); defaults to the module singleton
 */
export function rateLimit({ name, limit, windowSec, key, message, client: injected }) {
  const redis = injected ?? client;
  return async function rateLimitMw(req, res, next) {
    if (!redis) return next();                        // not configured → no-op (dev without Redis)
    try {
      const id = key(req);
      if (id == null || id === '') return next();     // nothing to key on → don't limit
      const redisKey = `rl:${name}:${id}`;
      const [count, ttl] = await redis.eval(SCRIPT, 1, redisKey, String(windowSec));
      if (count > limit) {
        const retryAfter = Math.max(Number(ttl) || windowSec, 1);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: message || 'Too many requests. Please try again shortly.',
          retryAfter,
        });
      }
      return next();
    } catch (err) {
      console.warn(`[rateLimit] bypass (${name}):`, err.message);   // fail-open
      return next();
    }
  };
}
