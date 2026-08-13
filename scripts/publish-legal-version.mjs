#!/usr/bin/env node
// ── Publish a legal document version (DPDP "Layer 2" — Layer 1 go-live) ────────
//
// Freezes the FINAL published text of a document into legal_document_versions and makes it the
// current version. Consent records + content attestations FK to the row this creates, so nothing
// can be accepted or attested until the relevant document is published here.
//
// "Author in git, freeze in the DB": git is a good editing store but a poor evidence store
// (rebase / squash / force-push / repo moves), so on publish we snapshot the exact bytes. Uses the
// SAME publishVersion() the admin route uses — immutable per (doc_key, version), idempotent on
// identical text, so re-running is safe.
//
//   node scripts/publish-legal-version.mjs \
//     --doc content-rights --version 1.0 --effective 2026-07-13 \
//     --file content/legal/content-rights.md
//
//   # tos/privacy are authored in the marketing repo; pass the FINAL text (tokens substituted —
//   # never raw {{PLACEHOLDER}} markdown, since the hash must reproduce from what the user saw):
//   node scripts/publish-legal-version.mjs --doc tos --version 1.0 --effective 2026-08-01 \
//     --file ../spattoo-web/apps/marketing/content/legal/terms-of-service.md \
//     --token REGISTERED_OFFICE="…" --token EFFECTIVE_DATE="1 August 2026"
//
// --dry-run prints the hash + a preview and writes nothing.

// Load .env BEFORE anything that reads process.env — the supabase service client is constructed
// at import time, so a late dotenv would leave it holding undefined creds.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLISHABLE_DOC_KEYS } from '../src/constants/legalDocuments.js';
import { legalContentHash } from '../src/lib/legalHash.js';
import { publishVersion } from '../src/services/legalConsent.js';

function parseArgs(argv) {
  const args = { tokens: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--token') {
      const [k, ...rest] = String(argv[++i] ?? '').split('=');
      if (k) args.tokens[k] = rest.join('=');
      continue;
    }
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { doc, version, effective, file, dryRun, tokens } = args;

if (!doc || !version || !effective || !file) {
  console.error('usage: --doc <key> --version <v> --effective <YYYY-MM-DD> --file <path> [--token K=V]... [--dry-run]');
  process.exit(1);
}
if (!PUBLISHABLE_DOC_KEYS.includes(doc)) {
  console.error(`✗ unknown doc key "${doc}". Known: ${PUBLISHABLE_DOC_KEYS.join(', ')}`);
  process.exit(1);
}
if (Number.isNaN(Date.parse(effective))) {
  console.error(`✗ --effective "${effective}" is not a valid date`);
  process.exit(1);
}

let content = readFileSync(resolve(process.cwd(), file), 'utf8');

// Substitute {{TOKENS}} so the stored text is what a reader actually sees. Then FAIL if any
// placeholder survives — publishing "{{REGISTERED_OFFICE}}" as the frozen legal text would be
// worse than not publishing at all, and the hash would be evidence of a document nobody saw.
for (const [k, v] of Object.entries(tokens)) {
  content = content.replaceAll(`{{${k}}}`, v);
}
const unresolved = [...content.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => m[1]);
if (unresolved.length) {
  console.error(`✗ unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
  console.error('  pass each with --token NAME="value" — never publish raw placeholder text.');
  process.exit(1);
}

const hash = legalContentHash(content);

if (dryRun) {
  console.log(`doc:        ${doc}\nversion:    ${version}\neffective:  ${effective}`);
  console.log(`sha256:     ${hash}\nbytes:      ${Buffer.byteLength(content)}`);
  console.log(`\n--- preview ---\n${content.slice(0, 400)}${content.length > 400 ? '\n…' : ''}`);
  console.log('\n(dry run — nothing written)');
  process.exit(0);
}

const result = await publishVersion({ docKey: doc, version, effectiveAt: effective, content });
console.log(`${result.created ? '✓ published' : '✓ already published (identical text) — now current'}: ` +
            `${result.docKey} v${result.version}  id=${result.id}  sha256=${result.contentHash.slice(0, 16)}…`);
process.exit(0);
