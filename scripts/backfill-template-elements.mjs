#!/usr/bin/env node
/**
 * Rebuild `template_elements` from every template's design.
 *
 * The table is DERIVED — each row is the design walked for uuids and intersected with
 * cake_elements — so this can be run at any time, as often as you like. It is how the table is
 * first populated (migration 110 creates it empty) and how drift is repaired if a sync ever failed
 * quietly, which syncTemplateElements is deliberately allowed to do rather than fail a save.
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=... \
 *   node scripts/backfill-template-elements.mjs
 *
 * Options (env vars):
 *   DRY_RUN=1    — report what would be written, change nothing
 *   ONLY=<uuid>  — a single template, for checking one before doing all of them
 */

import { createClient } from '@supabase/supabase-js';
import { uuidsIn } from '../src/lib/assetKeys.js';

/* ⚠️ THE SAME TWO OUTPUTS THE RUNTIME WRITES. syncTemplateDerived maintains template_elements AND
   cake_templates.search_slugs from one walk of the design; a backfill that filled only the first
   would leave every existing template with null terms — searchable by nothing it contains, which
   is the gap this whole plan exists to close. The rules below mirror lib/templateElements.js:
   'Your Text' skipped, {name}/{number} slots stripped, deduped, sorted, lowercased. */
const stripSlots = (s) => s.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();

/* ⚠️ `writings` FIRST, because that is where a message on a cake actually lives — a `writings[]`
   entry with a `text` field. Reading only `texts[].content` produced zero text terms across the
   whole catalogue on the first dry run: every template's `texts` is empty. `texts` is still read
   for older saved designs. `nameBlocks` is skipped on purpose — it spells a person's name.
   Mirrors lib/templateElements.js exactly; the two disagreeing is what would make this table look
   right and be wrong. */
function textTermsIn(design) {
  const out = [];
  const add = (raw) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s === 'Your Text') return;
    const bare = stripSlots(s);
    if (bare) out.push(bare.toLowerCase());
  };
  for (const w of design?.writings ?? []) add(w?.text);
  for (const t of design?.texts ?? []) add(t?.content);
  return out;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN      = process.env.DRY_RUN === '1';
const ONLY         = process.env.ONLY || null;

for (const v of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
  if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(1); }
}

/* ⚠️ `uuidsIn` is IMPORTED, not reimplemented. It is the same walk elementIdsReferencedBy uses at
   runtime, and a second copy here would be a second answer to "what does this design reference" —
   the backfill and the live path drifting apart is the one failure that would make this table look
   right and be wrong. assetKeys.js imports only a constant list, so it is safe in a standalone
   script; the supabase CLIENT is this script's own, because the service module reads config the
   server's way. */
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

/** id → name, and id → [tag slugs and display names]. Read once; the catalogue is small. */
async function elementTermIndex() {
  const names = new Map();
  const tags  = new Map();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('cake_elements').select('id, name').range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) names.set(r.id, r.name ?? null);
    if (!data || data.length < PAGE) break;
  }
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('element_tags').select('element_id, tags(slug, name)').range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      const list = tags.get(r.element_id) ?? [];
      if (r.tags?.slug) list.push(String(r.tags.slug).toLowerCase());
      if (r.tags?.name) list.push(String(r.tags.name).toLowerCase());
      tags.set(r.element_id, list);
    }
    if (!data || data.length < PAGE) break;
  }
  return { names, tags };
}

async function allElementIds() {
  // One read, then set-membership in memory: the alternative is a query per template, and the
  // element catalogue is small next to the template list it is checked against.
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('cake_elements').select('id').range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

async function allTemplates() {
  const rows = [];
  const PAGE = 200;   // designs are large; a smaller page keeps the response sane
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('cake_templates').select('id, name, design').range(from, from + PAGE - 1);
    if (ONLY) q = q.eq('id', ONLY);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data ?? []));
    if (ONLY || !data || data.length < PAGE) break;
  }
  return rows;
}

const elementIds = await allElementIds();
const { names, tags } = await elementTermIndex();
const templates  = await allTemplates();
console.log(`${templates.length} template(s), ${elementIds.size} element(s) in the catalogue`);
if (DRY_RUN) console.log('DRY_RUN — nothing will be written\n');

let written = 0, empty = 0, failed = 0, terms = 0, noTerms = 0;
for (const t of templates) {
  // Every uuid in the design, kept only if it is an element id. Same rule as the runtime walk: a
  // uuid that is not an element simply does not come back, so a false positive is impossible.
  const referenced = [...uuidsIn(t.design ?? {})].filter(id => elementIds.has(id));

  const termList = [...new Set([
    ...referenced.flatMap(id => [names.get(id)?.toLowerCase(), ...(tags.get(id) ?? [])]).filter(Boolean),
    ...textTermsIn(t.design),
  ])].sort();
  terms += termList.length;
  if (!termList.length) noTerms++;

  if (DRY_RUN) {
    console.log(`  ${referenced.length.toString().padStart(3)} el  ${termList.length.toString().padStart(3)} terms  ${t.name}`
      + (termList.length ? `  [${termList.slice(0, 6).join(', ')}${termList.length > 6 ? ', …' : ''}]` : ''));
    if (!referenced.length) empty++;
    continue;
  }

  try {
    const { error: delErr } = await supabase
      .from('template_elements').delete().eq('template_id', t.id);
    if (delErr) throw delErr;

    if (referenced.length) {
      const { error: insErr } = await supabase
        .from('template_elements')
        .insert(referenced.map(element_id => ({ template_id: t.id, element_id })));
      if (insErr) throw insErr;
      written += referenced.length;
    } else {
      empty++;
    }

    // ⚠️ WRITTEN EVEN WHEN EMPTY. A template with no terms must end up with `[]`, not null —
    // otherwise a re-run cannot tell "nothing to record" from "never processed", which is the same
    // distinction migration 112's tail query exists to make.
    const { error: updErr } = await supabase
      .from('cake_templates').update({ search_slugs: termList }).eq('id', t.id);
    if (updErr) throw updErr;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}: ${err?.message ?? err}`);
  }
}

console.log(`\n${DRY_RUN ? 'would write' : 'wrote'} ${written} element row(s)`);
console.log(`${DRY_RUN ? 'would write' : 'wrote'} ${terms} search term(s) across ${templates.length} template(s)`);
console.log(`${empty} template(s) reference no catalogue element; ${noTerms} have no search terms at all`);
if (failed) console.log(`⚠️  ${failed} template(s) failed — re-run to retry, it is idempotent`);
