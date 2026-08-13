#!/usr/bin/env node
// ── Schema scale gate ─────────────────────────────────────────────────────────
// Flags a foreign key that references a TEXT NATURAL KEY (key/slug/code/name/…)
// instead of a surrogate `id`. On a high-volume table that bloats every row + every
// index on the column — the exact mistake we re-did with orders.status. See the
// "PERSISTED SCHEMA IS FOREVER" principle in CLAUDE.md.
//
// A FK to a non-`id` column is allowed ONLY with an explicit opt-out on the same or
// previous line:  -- scale-ok: <reason>
//
// Heuristic, intentionally conservative (only the clear text-key pattern). Run via
// `npm run check:schema`; wire into your pre-commit hook.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
// Referenced columns that are clearly text natural keys (not a surrogate id).
const TEXT_KEY_COLS = /\b(key|slug|code|name|email|title)\b/i;
const REF_RE = /REFERENCES\s+\w+\s*\(\s*([a-z_]+)\s*\)/gi;

// Generated files, skipped. `schema.sql` is a pg_dump snapshot (scripts/dump-schema.mjs), and
// pg_dump does not carry inline `--` comments — so every `-- scale-ok:` opt-out in the authored
// files is absent from the dump, and scanning it would re-report decisions already made and
// justified, with no line to write the opt-out on. This gate's job is to catch a NEW text-key FK
// where it is authored; the dump is a mirror, not a place anyone declares one.
const GENERATED = new Set(['schema.sql', 'seed-sequences.sql']);

let violations = 0;
for (const file of readdirSync(SQL_DIR).filter(f => f.endsWith('.sql') && !GENERATED.has(f))) {
  const lines = readFileSync(join(SQL_DIR, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(line))) {
      const col = m[1];
      if (col === 'id' || !TEXT_KEY_COLS.test(col)) continue;
      const optOut = /--\s*scale-ok:/i.test(line) || /--\s*scale-ok:/i.test(lines[i - 1] ?? '');
      if (optOut) continue;
      violations++;
      console.error(`✗ ${file}:${i + 1}  FK references text natural key "(${col})" — use a surrogate id FK on high-volume tables.`);
      console.error(`    ${line.trim()}`);
    }
  });
}

if (violations) {
  console.error(`\n${violations} schema scale issue(s). A high-volume table must reference a lookup by a compact`);
  console.error('surrogate id, not its text key (CLAUDE.md "PERSISTED SCHEMA IS FOREVER"). If this FK is');
  console.error('genuinely fine (e.g. two bounded tables), annotate the line with:  -- scale-ok: <reason>');
  process.exit(1);
}
console.log('✓ schema scale gate: no text-natural-key foreign keys');
