// Shared client + guards + state for the scheduled-cancel validation harness.
// See README.md. Test-mode ONLY — every entry point refuses non-test keys.
import 'dotenv/config';
import Razorpay from 'razorpay';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE_PATH = join(HERE, '.state.json');
export const LOG_PATH   = join(HERE, 'observe-log.jsonl');

// Refuse to touch anything unless we're on rzp_test_ keys. This harness CREATES plans,
// subscriptions and (at authorization) real test charges — never let it run on live keys.
export function razorpay() {
  const keyId = process.env.RAZORPAY_KEY_ID || '';
  if (!keyId) {
    console.error('No RAZORPAY_KEY_ID in env. Add the TEST keys to spattoo-api/.env first.');
    process.exit(1);
  }
  if (!keyId.startsWith('rzp_test_')) {
    console.error(`Refusing to run: key is "${keyId.slice(0, 8)}…" — this harness is TEST-mode only.`);
    process.exit(1);
  }
  return new Razorpay({ key_id: keyId, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

export const KEY_ID = () => process.env.RAZORPAY_KEY_ID;

export function saveState(patch) {
  const cur = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
  const next = { ...cur, ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}
export function loadState() {
  if (!existsSync(STATE_PATH)) {
    console.error('No .state.json — run 1-create.mjs first (or pass a sub id as arg).');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}
export function appendLog(entry) {
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

// Unix-seconds → readable local string (Razorpay timestamps are Unix seconds).
export const ts = s => (s ? new Date(s * 1000).toISOString() : null);

// The lifecycle fields we care about, pulled off a fetched subscription.
export function subView(s) {
  return {
    status:                s.status,
    paid_count:            s.paid_count,
    remaining_count:       s.remaining_count,
    total_count:           s.total_count,
    charge_at:             ts(s.charge_at),
    current_start:         ts(s.current_start),
    current_end:           ts(s.current_end),
    end_at:                ts(s.end_at),
    ended_at:              ts(s.ended_at),
    has_scheduled_changes: s.has_scheduled_changes,
  };
}
