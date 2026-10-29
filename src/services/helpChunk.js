/* ── Cutting help articles into the rows the assistant searches ──────────────────────────────────
 *
 * Pure: markdown in, rows out. No filesystem, no database, no network.
 *
 * ⚠️ IT LIVES HERE BECAUSE TWO CALLERS DO THIS, AND THEY MUST NOT DRIFT. The CLI backfill reads the
 * articles off disk; the admin Help Index screen uploads them from a browser (the deployed API has
 * no checkout of spattoo-docs, which is deliberate — the articles live in the docs repo). If those
 * two chunked differently, the index would depend on who rebuilt it, and nothing would say so.
 */

import { createHash } from 'node:crypto';

/* ⚠️ HASHED HERE, SERVER-SIDE, FROM WHAT WAS UPLOADED — never in the browser. Two hashers are two
   chances to disagree about encoding, and a hash that differs by environment would report every
   article as changed forever, which is the same as having no record at all. */
export const hashArticle = (text) =>
  createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);

/** Frontmatter is a flat `key: value` block between the first two `---` lines. */
export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text ?? ''));
  if (!m) return { meta: {}, body: String(text ?? '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: String(text).slice(m[0].length) };
}

/* ── The article's own provenance note is not help ───────────────────────────────────────────────
 *
 * 54 of the 58 baker articles end with an italic paragraph addressed to US, not to a baker:
 * *"Checked against the app on 26 October 2026 on a computer (1400px)…"*. It is how the writer
 * recorded that they drove the screen, and it is why `checked_against_app` exists — but indexed, it
 * became text the assistant could ANSWER WITH, printing our verification notes to a baker who
 * asked how to set up their shop. Found by looking at the rendered panel, not by reading files.
 * The preceding `---` goes with it: it is the rule that separated the note from the article. */
export function stripProvenance(body) {
  const lines = String(body ?? '').split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start--;
  const last = lines.slice(start, end).join(' ').trim();
  if (!(last.startsWith('*') && /hecked against the app/.test(last))) return String(body ?? '');
  let cut = start;
  while (cut > 0 && !lines[cut - 1].trim()) cut--;
  if (cut > 0 && lines[cut - 1].trim() === '---') cut--;
  return lines.slice(0, cut).join('\n');
}

/**
 * Cut an article into sections.
 *
 * ⚠️ `###` STAYS WITH ITS PARENT. "Results are grouped" under "Searching" is a detail OF searching,
 * not a separate answer, and splitting there produces fragments that make no sense alone.
 * ⚠️ THE `#` TITLE LINE IS DROPPED — it repeats `doc_title`, which every row already carries.
 */
export function sectionsOf(body) {
  const lines = stripProvenance(body).split('\n');
  const out = [];
  let heading = null, buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push({ heading, body: text });
    buf = [];
  };
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;
    if (/^##\s+/.test(line)) { flush(); heading = line.replace(/^##\s+/, '').trim(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

/* What gets embedded. The article title and the heading go in with the body because a question is
   usually phrased in their words — "how do I change the cake colour" is almost the title itself —
   and a body that says "tap the tier" names neither. */
export const embedTextFor = (docTitle, heading, body) =>
  [docTitle, heading, body].filter(Boolean).join('\n').slice(0, 6000);

/**
 * ⚠️ TWO AUDIENCES, BOTH NAMED EXPLICITLY — never "anything not forbidden". `baker` is the help
 * articles; `faq` is the website's own questions, generated from spattoo-web's lib/faq.ts. The
 * first cut of this filter accepted a MISSING audience and swallowed INDEX.md and README.md, and
 * plans/support-automation.md is blunt that spattoo-docs as a whole is not baker-safe.
 */
export const INDEXED_AUDIENCES = Object.freeze(['baker', 'faq']);

export function isIndexable(meta) {
  if (!INDEXED_AUDIENCES.includes(meta?.audience)) return false;
  if (meta.status && meta.status !== 'live') return false;
  return true;
}

/**
 * `[{ filename, text }]` → the rows that belong in `help_sections`, plus what was skipped and why.
 *
 * Takes files rather than a directory so a browser upload and a disk read produce the same thing.
 * `indexed` is `[{ filename, doc_slug, content_hash }]` — what a diff compares against.
 */
export function rowsFromFiles(files) {
  const rows = [];
  const indexed = [];
  const skipped = [];
  for (const { filename, text } of files ?? []) {
    if (!String(filename ?? '').endsWith('.md')) { skipped.push({ filename, why: 'not markdown' }); continue; }
    const { meta, body } = parseFrontmatter(text);
    if (!isIndexable(meta)) {
      skipped.push({ filename, why: meta?.audience ? `audience: ${meta.audience}` : 'no audience stated' });
      continue;
    }
    const slug = meta.id || String(filename).replace(/\.md$/, '');
    const title = meta.title || slug;
    const hash = hashArticle(text);
    indexed.push({ filename, doc_slug: slug, content_hash: hash });
    sectionsOf(body).forEach((sec, i) => rows.push({
      doc_slug: slug,
      doc_title: title,
      heading: sec.heading,
      body: sec.body,
      position: i,
      audience: meta.audience ?? null,
      checked_against_app: meta.checked_against_app || null,
      content_hash: hash,
      source_file: filename,
    }));
  }
  return { rows, indexed, skipped };
}
