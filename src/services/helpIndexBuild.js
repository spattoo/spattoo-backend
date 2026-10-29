/* ── Rebuilding the assistant's index, only where it changed ─────────────────────────────────────
 *
 * Sandeep: *"i dont prefer running such mjs manually … build it in admin, so we can run from
 * there"*, then *"how do we know the differential?"* and *"is it like we need to rebuild the
 * complete index if there is a change?"*
 *
 * The work lives here and the CLI and the admin screen are two doors onto it. Chunking is in
 * helpChunk.js for the same reason — two callers that drift produce an index whose contents depend
 * on which door rebuilt it, with nothing saying so.
 *
 * ⚠️ PER ARTICLE, NOT WHOLESALE. The old pass deleted all 364 rows and re-embedded every one:
 * about two minutes, and a window where the table is empty and the assistant tells everybody
 * "nothing is written about that yet". That was a consequence of recording nothing about what the
 * index held, never a requirement. With `content_hash` on each row (migration 145) a typical edit
 * is one article — 6 sections, about two seconds — and nothing else is touched.
 *
 * ⚠️ STILL DELETE-THEN-INSERT WITHIN AN ARTICLE. A renamed heading or a removed section has to
 * stop being an answer, and an upsert would leave the old row behind to be retrieved forever. The
 * scope of the delete is what changed, not the scope of the problem it solves.
 */

/* ⚠️ openai.js IS IMPORTED LAZILY, INSIDE applyHelpIndex. It pulls in config.js, which refuses to
   load without every runtime secret — so a static import would make the PLANNING half, which never
   embeds anything, impossible to exercise without a Redis URL and an R2 key. Same reason
   helpRank.js is pure: a diff nobody can run is a diff that silently deletes the wrong articles. */
import { rowsFromFiles, embedTextFor } from './helpChunk.js';

/** What the index currently holds: one entry per article. */
async function currentState(client) {
  const { data, error } = await client
    .from('help_sections')
    .select('doc_slug, source_file, content_hash');
  if (error) throw new Error(`could not read the index: ${error.message}`);
  const byDoc = new Map();
  for (const r of data ?? []) {
    const e = byDoc.get(r.doc_slug) ?? { doc_slug: r.doc_slug, source_file: r.source_file, content_hash: r.content_hash, sections: 0 };
    e.sections++;
    byDoc.set(r.doc_slug, e);
  }
  return byDoc;
}

/**
 * What a rebuild from these files would do, without embedding or writing anything.
 *
 * ⚠️ THE CHEAP HALF, AND IT RUNS FIRST EVERY TIME. It catches the wrong folder, a missing
 * `audience:`, or an article that chunked to nothing — before an embedding is paid for or a row is
 * deleted.
 */
export async function planHelpIndex(files, client) {
  const { rows, indexed, skipped } = rowsFromFiles(files);
  const before = await currentState(client);

  const uploaded = new Map(indexed.map(a => [a.doc_slug, a]));
  const changed = [], added = [], unchanged = [], removed = [];

  for (const a of indexed) {
    const was = before.get(a.doc_slug);
    if (!was) added.push(a);
    else if (was.content_hash !== a.content_hash) changed.push({ ...a, was: was.content_hash });
    else unchanged.push(a);
  }
  /* ⚠️ ONLY WHEN THE UPLOAD IS THE WHOLE FOLDER. An article in the index and absent from a PARTIAL
     upload has not been removed — it simply was not offered — and deleting it would quietly empty
     the index one upload at a time. The caller decides; see `applyHelpIndex`. */
  for (const [slug, was] of before) if (!uploaded.has(slug)) removed.push(was);

  /* ⚠️ "59 CHANGED" WHEN NOTHING CHANGED IS A LIE THE FIRST SCREEN TELLS. An index built before
     migration 145 has no hashes at all, so every article compares as different — which is true in
     the sense that we cannot prove otherwise, and false in the sense anybody reads it. One run
     records the hashes and it never happens again, so it is worth naming rather than explaining. */
  const unhashed = before.size > 0 && [...before.values()].every(a => !a.content_hash);

  return {
    rows: rows.length,
    articles: indexed.length,
    changed, added, unchanged, removed, skipped,
    unhashed,
    /* An index that holds nothing yet is a first run, not a diff. Worth saying plainly, because
       "59 added" and "59 changed" mean very different things to whoever is about to press go. */
    firstRun: before.size === 0,
    embeddingsNeeded: rows.filter(r => {
      const a = uploaded.get(r.doc_slug);
      const was = before.get(r.doc_slug);
      return !was || was.content_hash !== a.content_hash;
    }).length,
  };
}

/**
 * Apply it. Embeds and writes only the articles whose content changed.
 *
 * @param pruneMissing  delete articles the upload did not contain. ONLY safe when the upload is
 *                      the whole help folder — see the note in `planHelpIndex`.
 */
export async function applyHelpIndex(files, client, { pruneMissing = false, onProgress } = {}) {
  const plan = await planHelpIndex(files, client);
  const { rows } = rowsFromFiles(files);

  if (!plan.articles) {
    /* ⚠️ REFUSES rather than clearing. An upload that parsed to nothing — the wrong folder, the
       wrong files — would otherwise delete a working index and report success, and the assistant
       would answer "nothing is written about that yet" to everything. */
    return { ok: false, reason: 'no indexable articles in what was uploaded', plan };
  }

  const touched = new Set([...plan.changed, ...plan.added].map(a => a.doc_slug));
  const todo = rows.filter(r => touched.has(r.doc_slug));

  const { embedText } = await import('./openai.js');

  /* ⚠️ EMBEDDINGS FIRST, INTO MEMORY, BEFORE ANYTHING IS DELETED. A failure partway through the
     OpenAI calls then leaves the existing index exactly as it was, rather than having removed an
     article it could not replace. */
  let done = 0;
  for (const r of todo) {
    const { embedding } = await embedText(embedTextFor(r.doc_title, r.heading, r.body));
    r.embedding = JSON.stringify(embedding);
    onProgress?.(++done, todo.length);
  }

  for (const slug of touched) {
    const { error } = await client.from('help_sections').delete().eq('doc_slug', slug);
    if (error) return { ok: false, reason: `clearing ${slug} failed: ${error.message}`, plan };
  }
  for (let i = 0; i < todo.length; i += 100) {
    const { error } = await client.from('help_sections').insert(todo.slice(i, i + 100));
    if (error) return { ok: false, reason: `insert failed: ${error.message}`, plan };
  }

  let pruned = [];
  if (pruneMissing && plan.removed.length) {
    for (const a of plan.removed) {
      const { error } = await client.from('help_sections').delete().eq('doc_slug', a.doc_slug);
      if (error) return { ok: false, reason: `removing ${a.doc_slug} failed: ${error.message}`, plan };
      pruned.push(a.doc_slug);
    }
  }

  return {
    ok: true,
    plan,
    embedded: todo.length,
    articlesWritten: touched.size,
    pruned,
    untouched: plan.unchanged.length,
  };
}
