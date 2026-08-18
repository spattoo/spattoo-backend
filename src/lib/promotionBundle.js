// ── Promotion bundles: gathering everything a row needs to exist somewhere else ──────────────────
//
// See spattoo-docs/plans/element-preview-and-publish.md. Elements and templates are authored on dev
// and promoted to prod. The hard part is never the rows that were picked — it is the CLOSURE around
// them, and getting that wrong fails quietly rather than loudly.
//
// Shared by the element and template export routes so the two cannot drift: a template's bundle
// contains an element bundle, assembled by the same code that assembles a standalone one.

import { supabase } from '../services/supabase.js';
import { config } from '../config.js';
// The two deep walks live in lib/assetKeys.js, which imports nothing but the folder list — so the
// rollout script can run the SAME walk without dragging in a Supabase client or config.js's ten
// required env vars. Re-exported because the routes here import them from this module.
import { assetKeysIn, uuidsIn } from './assetKeys.js';
export { assetKeysIn, uuidsIn };

/**
 * The element ids a design actually references.
 *
 * Collect every uuid in the design and ask the database which of them are elements. Intersecting
 * beats reading known fields (`stickers[].elementId`, a piping layer's `id`) for the same reason the
 * asset walk does — and it cannot produce a false positive, because a uuid that is not an element id
 * simply does not come back.
 */
export async function elementIdsReferencedBy(designs) {
  const candidates = [...designs.reduce((acc, d) => uuidsIn(d, acc), new Set())];
  if (!candidates.length) return [];
  const { data, error } = await supabase.from('cake_elements').select('id').in('id', candidates);
  if (error) throw error;
  return (data ?? []).map(r => r.id);
}

/**
 * Elements plus everything they need in order to exist elsewhere: their types (element_type_id is a
 * FK — the insert fails without it), their parents (parent_id is a self-FK), their tags, the tag
 * joins, their craft guides, and every R2 object any of it names.
 *
 * Rows come back VERBATIM, ids included. That is the whole design: `cake_elements.id` is a uuid, so
 * prod holds the same value, and every reference to it — parent_id, element_tags, and the elementId
 * embedded inside template and shape designs — keeps pointing at the right row with nothing to remap.
 */
export async function elementClosure(ids) {
  const elements = new Map();
  let wanted = ids;
  // Loop rather than one hop: the UI only authors parent → child today, but a deeper chain must not
  // ship half-exported. Bounded so a cycle in the data cannot spin here.
  for (let hop = 0; hop < 8 && wanted.length; hop++) {
    const { data, error } = await supabase
      .from('cake_elements').select('*').in('id', wanted).is('baker_id', null);
    if (error) throw error;
    for (const el of data ?? []) elements.set(el.id, el);
    wanted = (data ?? []).map(e => e.parent_id).filter(pid => pid && !elements.has(pid));
  }

  const rows = [...elements.values()];
  if (!rows.length) {
    return { elements: [], element_types: [], element_categories: [], tags: [], element_tags: [], element_craft_guide: [], keys: new Set() };
  }
  const elementIds = rows.map(e => e.id);

  const typeIds = [...new Set(rows.map(e => e.element_type_id).filter(Boolean))];
  // Categories travel with the elements for the same reason types do: category_id is a uuid, and
  // each environment ran migration 065's own seed INSERT, so "Animals" exists on both sides under a
  // DIFFERENT id. Without the vocabulary in the bundle, an imported element points at an id the
  // target has never seen. Only the categories actually used — a bundle of two lions should not
  // carry the whole menu.
  const catIds  = [...new Set(rows.map(e => e.category_id).filter(Boolean))];
  const [types, categories, elementTags, craftGuides] = await Promise.all([
    typeIds.length ? supabase.from('element_types').select('*').in('id', typeIds) : { data: [] },
    catIds.length  ? supabase.from('element_categories').select('*').in('id', catIds) : { data: [] },
    supabase.from('element_tags').select('*').in('element_id', elementIds),
    supabase.from('element_craft_guide').select('*').in('element_id', elementIds),
  ]);
  for (const r of [types, categories, elementTags, craftGuides]) if (r.error) throw r.error;

  const tagIds = [...new Set((elementTags.data ?? []).map(t => t.tag_id).filter(Boolean))];
  const tags = tagIds.length ? await supabase.from('tags').select('*').in('id', tagIds) : { data: [] };
  if (tags.error) throw tags.error;

  // The three asset columns, plus anything nested in placement_config — found by the same deep walk
  // the designs use, so a nested asset added in core is picked up here without this file changing.
  const keys = new Set();
  for (const el of rows) {
    for (const k of [el.image_url, el.thumbnail_url, el.thumb_key]) {
      if (k && !/^https?:\/\//i.test(k)) keys.add(k);
    }
    assetKeysIn(el.placement_config, keys, config.r2.publicUrl);
  }

  // ── Categories travel by SLUG, never by id ─────────────────────────────────────────────────────
  // Migration 065 ran separately in each environment, so "Animals" has a different uuid on every
  // side and always will. An id in a bundle is an assertion about a database the bundle is not
  // running in: it either collides, or binds an element to the wrong row.
  //
  // So each element carries `category_slug` and NOT `category_id`, and the importer resolves it
  // against whatever the target holds — including a category the target's admin created by hand,
  // which is the case that made this obvious. The category rows still travel, without their ids, so
  // a slug the target has never seen can be created rather than silently dropping the element's
  // category on the floor.
  const bySlug = new Map((categories.data ?? []).map(c => [c.id, c.slug]));
  const outRows = rows.map(({ category_id, ...el }) => (
    category_id ? { ...el, category_slug: bySlug.get(category_id) ?? null } : el
  ));

  return {
    elements: outRows,
    element_types: types.data ?? [],
    // Vocabulary for anything the target lacks. `id` is stripped for the same reason it is stripped
    // from the elements — it means nothing there.
    element_categories: (categories.data ?? []).map(({ id, created_at, ...c }) => c),
    tags: tags.data ?? [],
    element_tags: elementTags.data ?? [],
    element_craft_guide: craftGuides.data ?? [],
    keys,
  };
}

/**
 * Templates plus their closure: parents (parent_template_id is a self-FK), tag joins, attrs, their
 * own thumbnails, every asset named inside their designs, AND the elements those designs reference.
 *
 * The elements travel by default, and that is the important decision. A template whose elements are
 * absent still RENDERS — the design carries a copy of everything it needs to draw — but the designer
 * is deliberately tolerant of a missing catalogue row, so move/resize caps quietly revert to
 * defaults and clustering stops working. It would look right and behave differently, with nothing
 * logged. Shipping the elements alongside is the only version of this that fails loudly or not at
 * all.
 */
export async function templateClosure(ids) {
  const templates = new Map();
  let wanted = ids;
  for (let hop = 0; hop < 8 && wanted.length; hop++) {
    const { data, error } = await supabase
      .from('cake_templates').select('*').in('id', wanted).is('baker_id', null);
    if (error) throw error;
    for (const t of data ?? []) templates.set(t.id, t);
    wanted = (data ?? []).map(t => t.parent_template_id).filter(pid => pid && !templates.has(pid));
  }

  const rows = [...templates.values()];
  if (!rows.length) return null;
  const templateIds = rows.map(t => t.id);

  const [templateTags, attrs] = await Promise.all([
    supabase.from('template_tags').select('*').in('template_id', templateIds),
    supabase.from('cake_template_attrs').select('*').in('template_id', templateIds),
  ]);
  for (const r of [templateTags, attrs]) if (r.error) throw r.error;

  const designs = rows.map(t => t.design).filter(Boolean);
  const elements = await elementClosure(await elementIdsReferencedBy(designs));

  // Tags reach a template two ways — through its own template_tags and through its elements'
  // element_tags. One set, or the same tag row would be exported twice and upserted twice.
  const tagIds = [...new Set([
    ...(templateTags.data ?? []).map(t => t.tag_id),
    ...elements.tags.map(t => t.id),
  ].filter(Boolean))];
  const tags = tagIds.length ? await supabase.from('tags').select('*').in('id', tagIds) : { data: [] };
  if (tags.error) throw tags.error;

  const keys = new Set(elements.keys);
  for (const t of rows) {
    if (t.thumbnail_url && !/^https?:\/\//i.test(t.thumbnail_url)) keys.add(t.thumbnail_url);
    // From the DESIGN, not from the elements it references: the design points at keys directly, so a
    // template made before an element's image was replaced still names the older object — which is
    // the correct object for that template, and one a walk through today's elements would miss.
    // With the public base: a design stores fully-qualified URLs, and without it the walk sees no
    // assets at all — the bundle would carry the template and none of its objects.
    assetKeysIn(t.design, keys, config.r2.publicUrl);
  }

  return {
    ...elements,
    tags: tags.data ?? [],
    cake_templates: rows,
    template_tags: templateTags.data ?? [],
    cake_template_attrs: attrs.data ?? [],
    keys,
  };
}
