#!/usr/bin/env node
// ── One-time backfill: current_period_start / current_period_end ──────────────────
// Populates the new instant boundaries on baker_subscriptions from Razorpay's authoritative
// current_start / current_end, for existing rows that have a Razorpay subscription but no
// instant yet. New rows get stamped by the subscription.charged webhook; this catches the
// back-catalog so access stops relying on the day-early `end_date` immediately.
//
// Run (Supabase creds come from .env; pass Razorpay keys inline):
//   RAZORPAY_KEY_ID=rzp_... RAZORPAY_KEY_SECRET=... node scripts/backfill-period-instants.mjs
//
// Idempotent: only touches rows where current_period_end IS NULL. Re-runnable.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Best-effort .env loader (does not override already-set vars) so SUPABASE_* come from .env
// while RAZORPAY_* can be passed inline.
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on the environment */ }

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env;
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET })) {
  if (!v) { console.error(`Missing required env: ${k}`); process.exit(1); }
}

const REST = `${SUPABASE_URL}/rest/v1`;
const sbHeaders = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
const rzpAuth = 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rows with a Razorpay sub but no instant boundary yet.
const rowsRes = await fetch(
  `${REST}/baker_subscriptions?billing_subscription_id=not.is.null&current_period_end=is.null` +
  `&select=id,billing_subscription_id,end_date`,
  { headers: sbHeaders },
);
if (!rowsRes.ok) { console.error('Supabase query failed:', rowsRes.status, await rowsRes.text()); process.exit(1); }
const rows = await rowsRes.json();
console.log(`Found ${rows.length} row(s) needing backfill.`);

let updated = 0, skipped = 0, failed = 0;
for (const row of rows) {
  const subId = row.billing_subscription_id;
  try {
    const rzpRes = await fetch(`https://api.razorpay.com/v1/subscriptions/${subId}`, {
      headers: { Authorization: rzpAuth },
    });
    if (!rzpRes.ok) {
      // 404 = mock/foreign sub (e.g. sub_mock_… from the no-keys dev path) — nothing to stamp.
      console.warn(`  skip ${subId}: Razorpay ${rzpRes.status}`);
      skipped++; await sleep(120); continue;
    }
    const sub = await rzpRes.json();
    if (!sub.current_end) { console.warn(`  skip ${subId}: no current_end (never charged?)`); skipped++; await sleep(120); continue; }

    const patch = {
      current_period_end: new Date(sub.current_end * 1000).toISOString(),
      ...(sub.current_start ? { current_period_start: new Date(sub.current_start * 1000).toISOString() } : {}),
    };
    const upd = await fetch(`${REST}/baker_subscriptions?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!upd.ok) { console.error(`  FAIL ${subId}: patch ${upd.status} ${await upd.text()}`); failed++; }
    else { console.log(`  ok   ${subId}: current_period_end=${patch.current_period_end} (was end_date=${row.end_date})`); updated++; }
  } catch (err) {
    console.error(`  FAIL ${subId}: ${err.message}`); failed++;
  }
  await sleep(120); // gentle on the Razorpay API
}

console.log(`\nDone. updated=${updated} skipped=${skipped} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
