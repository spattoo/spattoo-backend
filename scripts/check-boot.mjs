// Boot guard — every module under src/ must LOAD.
//
// WHY THIS EXISTS. `routes/bakers.js` once imported `publishError` from `services/contentAttestation.js`,
// which never exported it. ESM resolves imports at load time, so the API died with a SyntaxError on
// `yarn start` — but Render keeps the LAST GOOD instance serving on a failed deploy, so nothing looked
// broken from outside: the old build kept answering, silently missing the new route logic (storefront
// publishes wrote no attestation for days). A crash that leaves the old code serving is invisible unless
// something checks the boot itself.
//
// A missing/renamed export, a typo'd import path, or a circular import that leaves a binding undefined
// are all caught by simply IMPORTING the module — no test framework, no running server, no assertions.
// That is the whole check: import everything, report what won't load.
//
// NOT a substitute for a real integration test — it proves the process can start, nothing about
// behaviour. It is deliberately cheap so it can run in the pre-deploy gate on every commit.
//
// Runs WITHOUT secrets: config.js hard-fails on missing env vars, so absent ones are stubbed with
// placeholders. Nothing here connects — we import and exit. (jobs/queue.js constructs an IORedis at
// module scope, so the placeholder REDIS_URL is never dialled before we exit.)

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// Placeholders ONLY for vars the real environment supplies — never overwrite a real one, so running
// this locally with a populated .env behaves identically to CI without it.
const STUB = {
  SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_KEY: 'stub',
  OPENAI_API_KEY: 'stub',
  REMOVE_BG_API_KEY: 'stub',
  REDIS_URL: 'redis://127.0.0.1:6379',
  R2_ENDPOINT: 'https://stub.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'stub',
  R2_SECRET_ACCESS_KEY: 'stub',
  R2_BUCKET: 'stub',
  R2_PUBLIC_URL: 'https://stub.example',
};
await import('dotenv/config');
for (const [key, value] of Object.entries(STUB)) process.env[key] ||= value;

// index.js is EXCLUDED: it is the only module with side effects on import (starts the worker, awaits
// the Redis-backed job schedulers, then listens). It would hang here. Everything it pulls in —
// server.js and the entire route/service/job graph below it — IS covered, which is where load-time
// import errors actually live.
const EXCLUDE = new Set(['index.js']);

function* modules(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* modules(path);
    else if (entry.name.endsWith('.js') && !EXCLUDE.has(entry.name)) yield path;
  }
}

const failures = [];
for (const path of modules(SRC)) {
  try {
    await import(pathToFileURL(path).href);
  } catch (err) {
    failures.push({ path: path.slice(ROOT.length + 1), message: err.message });
  }
}

if (failures.length) {
  console.error(`\ncheck:boot — ${failures.length} module(s) failed to load:\n`);
  for (const f of failures) console.error(`  ${f.path}\n    ${f.message}\n`);
  console.error('The API would CRASH on start. Render would keep serving the previous build.\n');
  process.exit(1);
}

console.log('check:boot — all modules load.');
// Exit explicitly: importing the job graph constructs an IORedis client at module scope, whose open
// handle would otherwise keep the process alive.
process.exit(0);
