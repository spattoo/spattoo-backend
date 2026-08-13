import { supabase } from './supabase.js';
import { embedText, suggestDescription } from './openai.js';
import { config } from '../config.js';

// Expand a stored R2 key to a public URL (pass-through if already a URL).
function publicUrl(key) {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  return `${config.r2.publicUrl?.replace(/\/+$/, '')}/${key}`;
}

// Make one element searchable: ensure it has a `description` (the comma-separated keyword string),
// then store a text embedding of `name + description` for KNN retrieval during inspiration matching.
// Idempotent; safe to call repeatedly. Returns { generatedDescription }.
export async function reindexElement(elementId) {
  const { data: el, error } = await supabase
    .from('cake_elements')
    .select('id, name, description, thumbnail_url, image_url, element_types(name)')
    .eq('id', elementId)
    .single();
  if (error || !el) throw error || new Error(`element ${elementId} not found`);

  let description = (el.description || '').trim();
  let generatedDescription = false;

  // Safety net: if the keyword field is empty, generate it from the element's image so the
  // library stays fully searchable even when an element was saved without a description.
  if (!description) {
    const imgUrl = publicUrl(el.thumbnail_url || el.image_url);
    if (imgUrl) {
      try {
        description = await suggestDescription(imgUrl, el.element_types?.name);
        generatedDescription = !!description;
      } catch { /* leave empty; we still embed the name below */ }
    }
  }

  const text = [el.name, description].filter(Boolean).join(' — ').trim();
  if (!text) return { generatedDescription }; // nothing to embed

  const { embedding } = await embedText(text);

  // pgvector accepts the '[a,b,c]' text form, which JSON.stringify of the array produces exactly.
  const updates = { description_embedding: JSON.stringify(embedding) };
  if (generatedDescription) updates.description = description;
  const { error: upErr } = await supabase.from('cake_elements').update(updates).eq('id', elementId);
  if (upErr) throw upErr;

  return { generatedDescription };
}
