import { supabase } from './supabase.js';
import { suggestBuildGuide } from './openai.js';
import { renderStageImage, elementStagesKey } from './decorationStages.js';
import { archiveObject } from './r2.js';
import { toPublicUrl } from '../routes/elements.js';
import { visionImageKey, decorationDimension } from './decorationPolicy.js';

// ── Building one element's decoration guide ──────────────────────────────────────────
// Shared by the two callers that produce the same artefact for different reasons:
//
//   admin publish   we generate it for our own catalogue, unprompted and at our cost, so that a
//                   library decoration already has its guide by the time any baker meets one
//   baker request   a baker asks for a decoration WE did not author — their own element — and
//                   pays for it
//
// The work is identical; only who pays differs, and that is decided by the caller (routes/
// craftGuide.js `oursToPayFor`). Keeping the generation here means the two can never drift into
// producing subtly different guides for the same kind of object.

// Bump when the prompt changes in a way that could move the output. Kept as 'build-guide-v1' though
// the feature is now called decoration steps: this string is STAMPED ON STORED ROWS, and renaming
// it would split one prompt's history into two versions that were never different.
export const GUIDE_PROMPT_VERSION = 'build-guide-v1';

// Generate and store the guide for ONE element.
//
// Returns { status, row } where status is:
//   'ok'          — a guide with steps, stored
//   'not_modelled'— the model looked and judged this printed / pre-made / piped. A real ANSWER,
//                   and the reason nothing is stored: there is no modelling process to record.
//   'no_image'    — nothing a vision model can read
//
// Never throws for 'not_modelled'. That distinction is what lets the caller charge for one and not
// the other, and what stops the UI reporting a correct answer as a failure.
export async function buildElementGuide(el, { ownerBakerId = null } = {}) {
  const imageKey = visionImageKey(el);
  if (!imageKey) return { status: 'no_image', row: null };

  // Flat or in the round. A sticker is flat by definition; anything else we do not claim to know.
  const dimension = decorationDimension(el);

  const { guide, usage, model } = await suggestBuildGuide({
    imageUrl: toPublicUrl(imageKey), name: el.name, description: el.description, dimension,
  });
  const calls = [{ model, usage }];

  if (!guide || !Array.isArray(guide.steps) || guide.steps.length === 0) {
    return { status: 'not_modelled', row: null, guide, model, calls };
  }

  // Best-effort: the words are the product and the picture is the improvement, so an image failure
  // must not throw away a guide that is otherwise complete — and, on the baker-paid path, one they
  // are about to be charged for.
  const stages = await renderStageImage({
    sourceKey: imageKey,                 // an element image IS the isolated decoration; no crop
    objectKey: elementStagesKey(el.id),
    title: guide.title || el.name,
    steps: guide.steps,
    // The picture must agree with the steps about what is being made — a flat cut-out drawn as a
    // standing figurine contradicts every instruction beside it.
    dimension,
  }).catch(err => {
    console.warn(`[decoration-guide] stage image failed for ${el.id}, guide kept:`, err?.message);
    return null;
  });
  if (stages) calls.push({ model: stages.model, usage: stages.usage, image: stages.image });

  const row = {
    element_id: el.id,
    guide_type: 'fondant_figure',
    guide,
    // source_image_url stores the KEY despite the column name: the key is the stable identity of
    // the image, while the public URL base is deployment config that would rot every stored row.
    source_image_url: imageKey,
    stages_key: stages?.key ?? null,
    model: model ?? null,
    prompt_version: GUIDE_PROMPT_VERSION,
    // 'draft' means UNREVIEWED BY A HUMAN, which is true of every generated guide including ours.
    // A catalogue guide can be promoted to 'approved' once someone has actually read it; doing
    // that automatically because we generated it would make the badge meaningless.
    status: 'draft',
    // Ownership, NOT who triggered it. A guide on a Spattoo element is Spattoo's even when a
    // baker's click produced it — they did not pay for it and it is not erasable with their account.
    baker_id: ownerBakerId,
    generated_at: new Date().toISOString(),
  };

  // Read the key we are about to replace, so the superseded picture can be removed. Read BEFORE
  // the upsert: afterwards the row points at the new one and the old key is unrecoverable.
  const { data: prev } = await supabase
    .from('element_craft_guide').select('stages_key')
    .eq('element_id', el.id).eq('guide_type', 'fondant_figure').maybeSingle();

  const { error } = await supabase
    .from('element_craft_guide').upsert(row, { onConflict: 'element_id,guide_type' });
  if (error) throw error;

  // Every generation writes a NEW key (the cache is immutable, so a reused key is never refetched),
  // which means a rebuild would otherwise leave the old picture behind forever. ARCHIVED rather
  // than destroyed: the picture cost real money and the model will not produce the same one twice,
  // so a rebuild that came out worse should be recoverable from the bin.
  //
  // After the upsert, never before: losing the object while the row still referenced it would turn
  // a stale picture into no picture.
  if (prev?.stages_key && prev.stages_key !== row.stages_key) {
    await archiveObject(prev.stages_key).catch(e =>
      console.warn(`[decoration-guide] superseded stage image ${prev.stages_key} not archived:`, e?.message));
  }

  return { status: 'ok', row, guide, model, calls };
}
