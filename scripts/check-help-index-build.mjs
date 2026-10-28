#!/usr/bin/env node
/* ── The incremental rebuild does only the work that changed, and nothing worse ──────────────────
 *
 * ⚠️ EVERY FAILURE HERE IS SILENT AND EXPENSIVE. This code DELETES rows. Get the diff wrong and it
 * either re-embeds all 364 sections every time (two minutes, and a window where the assistant
 * answers "nothing is written about that yet" to everyone) or, far worse, deletes articles that
 * were simply not in a partial upload. Neither throws.
 *
 * Exercised against a stub client, so it needs no database and no network.
 *
 * Run by `npm run check` with the other gates.
 */

import { planHelpIndex } from '../src/services/helpIndexBuild.js';
import { hashArticle } from '../src/services/helpChunk.js';

let failed = 0;
const ok = (cond, what) => { if (!cond) { failed++; console.error(`  ✗ ${what}`); } };

const article = (id, body) =>
  `---\nid: ${id}\ntitle: ${id}\naudience: baker\nstatus: live\n---\n\n# ${id}\n\n${body}\n`;

/* A client that answers the one read planHelpIndex makes. Rows are whatever we say is indexed. */
const stub = (rows) => ({
  from: () => ({ select: async () => ({ data: rows, error: null }) }),
});

const file = (id, body) => ({ filename: `${id}.md`, text: article(id, body) });
const indexedRow = (id, text, n = 1) =>
  Array.from({ length: n }, (_, i) => ({ doc_slug: id, source_file: `${id}.md`, content_hash: hashArticle(text), position: i }));

// ── first run ───────────────────────────────────────────────────────────────────────────────────
{
  const files = [file('a', 'One.'), file('b', 'Two.')];
  const p = await planHelpIndex(files, stub([]));
  ok(p.firstRun === true, 'an empty index is reported as a first run, not as a diff');
  ok(p.added.length === 2 && !p.changed.length, 'everything is new on a first run');
  ok(p.embeddingsNeeded === p.rows, 'and every section needs embedding');
}

// ── nothing changed ─────────────────────────────────────────────────────────────────────────────
{
  const files = [file('a', 'One.'), file('b', 'Two.')];
  const rows = files.flatMap(f => indexedRow(f.filename.replace('.md',''), f.text));
  const p = await planHelpIndex(files, stub(rows));
  ok(p.unchanged.length === 2, 'identical articles are unchanged');
  ok(!p.changed.length && !p.added.length && !p.removed.length, 'and nothing is changed, added or removed');
  /* ⚠️ THE ONE THAT MATTERS MOST. If this is ever non-zero, every save re-embeds the whole corpus
     and the incremental build is incremental in name only. */
  ok(p.embeddingsNeeded === 0, 'an unchanged corpus needs ZERO embeddings');
}

// ── one article edited ──────────────────────────────────────────────────────────────────────────
{
  const before = [file('a', 'One.'), file('b', 'Two.')];
  const rows = before.flatMap(f => indexedRow(f.filename.replace('.md',''), f.text));
  const after = [file('a', 'One, edited.'), file('b', 'Two.')];
  const p = await planHelpIndex(after, stub(rows));
  ok(p.changed.length === 1 && p.changed[0].doc_slug === 'a', 'only the edited article is changed');
  ok(p.unchanged.length === 1, 'the other is untouched');
  ok(p.embeddingsNeeded > 0 && p.embeddingsNeeded < p.rows,
     'only the changed article needs embedding, not the whole corpus');
}

// ── an article absent from the upload ───────────────────────────────────────────────────────────
{
  const rows = [...indexedRow('a', article('a', 'One.')), ...indexedRow('gone', article('gone', 'Old.'))];
  const p = await planHelpIndex([file('a', 'One.')], stub(rows));
  /* ⚠️ REPORTED, NEVER DELETED BY planHelpIndex. An article missing from a PARTIAL upload has not
     been removed — it was not offered — and only a caller who knows it uploaded the whole folder
     may prune. Deleting on a partial upload would empty the index one upload at a time. */
  ok(p.removed.length === 1 && p.removed[0].doc_slug === 'gone', 'an article not in the upload is REPORTED as removed');
  ok(p.unchanged.length === 1, 'and the one that was uploaded is still unchanged');
}

// ── what must never be indexed ──────────────────────────────────────────────────────────────────
{
  const notes = { filename: 'INDEX.md', text: '# Notes to ourselves\n\nInternal.\n' };
  const draft = { filename: 'd.md', text: '---\nid: d\ntitle: D\naudience: baker\nstatus: draft\n---\n\n# D\n\nBody.\n' };
  const p = await planHelpIndex([file('a', 'One.'), notes, draft], stub([]));
  ok(p.articles === 1, 'a file with no audience and a non-live draft are both skipped');
  ok(p.skipped.length === 2, 'and both are reported rather than silently dropped');
  ok(p.skipped.some(s => s.filename === 'INDEX.md'), 'INDEX.md in particular — it got in once');
}

// ── the hash is of the file, and is stable ──────────────────────────────────────────────────────
ok(hashArticle('abc') === hashArticle('abc'), 'the same text hashes the same');
ok(hashArticle('abc') !== hashArticle('abd'), 'different text hashes differently');
ok(hashArticle('abc').length === 16, 'the hash is the 16 chars the column stores');

if (failed) { console.error(`\n✗ check:help-index-build — ${failed} case(s) wrong\n`); process.exit(1); }
console.log('✓ check:help-index-build — rebuilds only what changed, and never prunes on a partial upload');
