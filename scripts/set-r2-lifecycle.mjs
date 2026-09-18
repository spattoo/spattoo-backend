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

const RULE_ID = 'expire-whatsapp-media-copies';
const PREFIX  = 'notifications/whatsapp-media/';
const DAYS    = 90;

const apply = process.argv.includes('--apply');

const r2 = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
});

const ours = {
  ID: RULE_ID,
  Status: 'Enabled',
  Filter: { Prefix: PREFIX },
  Expiration: { Days: DAYS },
  // A multipart upload that never completed is invisible and billable. Nothing here writes one today
  // (the copies are small single PUTs), but the rule costs nothing and a future large upload into
  // this prefix would otherwise leak.
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
};

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

const kept = existing.filter(r => r.ID !== RULE_ID);
const Rules = [...kept, ours];

console.log(`bucket   ${config.r2.bucket}`);
console.log(`endpoint ${config.r2.endpoint}`);
console.log(`\nrules already present: ${existing.length}`);
for (const r of existing) {
  const mark = r.ID === RULE_ID ? '(ours — will be replaced)' : '(kept untouched)';
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
