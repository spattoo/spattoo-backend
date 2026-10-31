#!/usr/bin/env node
// ── R2 lifecycle: expire the derived WhatsApp media copies ───────────────────────────────────────
//
// WhatsApp accepts only JPEG or PNG in a template header and our cake pictures are WebP, so
// services/whatsappMedia.js converts one and caches it under `notifications/whatsapp-media/`. Those
// copies are DERIVED DATA — delete one and the next send regenerates it — but nothing was deleting
// them, so they accumulated for the life of the bucket beside originals that are kept anyway.
//
// A baker at 300 orders a month makes roughly a gigabyte of them a year. That is pennies, which is
// why this is a lifecycle rule and not code: the cost of the storage never justified a sweeper, and
// the folder was kept off lib/folders.js from the start precisely so a rule could own it.
//
// ⚠️ 90 DAYS, NOT 7. The copy is a cache, and the messages about one order cluster within days — but
// a re-send, a retried job or a baker reopening an old order after the window costs one download and
// one re-encode, not a failure. Short enough to bound the storage, long enough that expiry is never
// the reason something is slow.
//
// ⚠️ PutBucketLifecycleConfiguration REPLACES THE WHOLE CONFIGURATION. It is not an append. So this
// reads what is there, drops any earlier copy of our own rule by id, keeps every other rule
// untouched, and writes the union back. Getting that wrong would silently delete somebody else's
// retention policy, and the only symptom would be objects living longer than intended.
//
//   npm run r2:lifecycle           # dry run — prints what it WOULD write
//   npm run r2:lifecycle -- --apply
//
// Safe to re-run: the rule is replaced by id, never duplicated.

import {
  S3Client, GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
/* ⚠️ THE RETENTION WINDOWS COME FROM lib/folders.js, not from numbers typed here. The route that
   reports whether a stored key is still live reads the same map — typed separately they drift, and
   a row then promises a model R2 has already deleted. folders.js is dependency-free on purpose, so
   importing it does not drag config.js (and its ten env vars) into this script. */
import { FOLDER_RETENTION_DAYS } from '../src/lib/folders.js';

/* ⚠️ Reads the four R2 values from the environment directly, and deliberately does NOT import
   src/config.js. That module asserts EVERY required key at import — OPENAI_API_KEY, REMOVE_BG_API_KEY,
   REDIS_URL — so an operator with perfectly good R2 credentials was told "Missing required env var:
   REMOVE_BG_API_KEY" while trying to set a bucket rule. An ops script should need exactly what it
   uses and say so. */
const need = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = need.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`✗ missing: ${missing.join(', ')}`);
  console.error('   This script needs only those four. Run it where the R2 credentials live —');
  console.error('   the Render shell for the environment whose bucket you mean to change.');
  process.exit(1);
}
const config = { r2: {
  endpoint:        process.env.R2_ENDPOINT,
  accessKeyId:     process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket:          process.env.R2_BUCKET,
} };

/* ── The rules this script owns ──────────────────────────────────────────────────────────────────
 * Each is replaced by ID on every run and every OTHER rule in the bucket is kept untouched, so
 * adding one here is safe. Both prefixes hold data that can be regenerated or that nobody promised
 * to keep — never anything a baker's cake points at.
 */
const RULES = [
  {
    id: 'expire-whatsapp-media-copies',
    prefix: 'notifications/whatsapp-media/',
    days: FOLDER_RETENTION_DAYS['notifications/whatsapp-media'],
    why: 'derived JPEG copies of cake pictures for WhatsApp headers; deleting one makes the next send regenerate it',
  },
  {
    /* ⚠️ EVERY GENERATION IS KEPT, BUT NOT FOREVER. A baker pays credits for a 3D generation and
       the vendor's own URL expires, so the model MUST be mirrored here or the money buys something
       that evaporates — 7 of 8 runs had no copy at all when this was found. But most generations
       are rejects, and keeping every one forever fills the bucket with models nobody chose.
       So: mirror all of them, expire the ones nobody promoted. Promotion COPIES the file to the
       permanent element path, so an element is never left pointing at an expiring object. */
    id: 'expire-unpromoted-3d-generations',
    prefix: 'ai3d/runs/',
    days: FOLDER_RETENTION_DAYS['ai3d/runs'],
    why: 'generated models nobody turned into an element; promotion copies the file out of this prefix first',
  },
];

const apply = process.argv.includes('--apply');

const r2 = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
});

const ours = RULES.map(r => ({
  ID: r.id,
  Status: 'Enabled',
  Filter: { Prefix: r.prefix },
  Expiration: { Days: r.days },
  // A multipart upload that never completed is invisible and billable. Nothing here writes one today
  // (the copies are small single PUTs), but the rule costs nothing and a future large upload into
  // these prefixes would otherwise leak.
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
}));
const OUR_IDS = new Set(RULES.map(r => r.id));

let existing = [];
try {
  const got = await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: config.r2.bucket }));
  existing = got.Rules ?? [];
} catch (err) {
  // "no configuration" is the normal first run, not a failure.
  const code = err?.name || err?.Code || '';
  if (!/NoSuchLifecycleConfiguration/i.test(code)) {
    console.error(`✗ could not read the current lifecycle configuration: ${err.message}`);
    console.error('   Refusing to write — a blind PUT would replace whatever is there.');
    process.exit(1);
  }
}

const kept = existing.filter(r => !OUR_IDS.has(r.ID));
const Rules = [...kept, ...ours];

console.log(`bucket   ${config.r2.bucket}`);
console.log(`endpoint ${config.r2.endpoint}`);
console.log(`\nrules already present: ${existing.length}`);
for (const r of existing) {
  const mark = OUR_IDS.has(r.ID) ? '(ours — will be replaced)' : '(kept untouched)';
  console.log(`  · ${r.ID} ${mark}`);
}
console.log(`\nwriting: ${RULE_ID} — delete ${PREFIX}* after ${DAYS} days`);

if (!apply) {
  console.log('\nDRY RUN. Nothing was written. Re-run with --apply to write it.');
  process.exit(0);
}

await r2.send(new PutBucketLifecycleConfigurationCommand({
  Bucket: config.r2.bucket,
  LifecycleConfiguration: { Rules },
}));

// Read back rather than trusting the write — the whole risk here is clobbering, and the only
// honest confirmation is what the bucket says afterwards.
const after = await r2.send(new GetBucketLifecycleConfigurationCommand({ Bucket: config.r2.bucket }));
console.log(`\n✓ applied. The bucket now has ${after.Rules?.length ?? 0} rule(s):`);
for (const r of after.Rules ?? []) {
  console.log(`  · ${r.ID} — ${r.Status}, prefix "${r.Filter?.Prefix ?? ''}", expire ${r.Expiration?.Days ?? '—'}d`);
}
