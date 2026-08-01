import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { suggestCraftGuide, suggestBuildGuide } from '../services/openai.js';
import { renderStageImage, elementStagesKey } from '../services/decorationStages.js';
import { withAiCredits, AI_ACTION, InsufficientCreditsError } from '../services/aiCredits.js';
import { assertBakerOwns } from '../lib/tenantScope.js';
// cake_elements.image_url holds an R2 object KEY, not a URL — every read path wraps it before the
// value leaves the API (elements.js withPublicUrls). OpenAI fetches the image over HTTP, so it
// needs the same treatment; handing it the raw key is a hard failure, not a degraded result.
import { toPublicUrl } from './elements.js';

const router = Router();

// Bump when the prompt changes in a way that could move the output. Kept as 'build-guide-v1'
// though the feature is now called decoration steps: this string is STAMPED ON STORED ROWS, and
// renaming it would split one prompt's history into two versions that were never different.
const PROMPT_VERSION = 'build-guide-v1';

// The formats OpenAI's vision endpoint accepts. Anything else comes back as a hard
// invalid_image_format, not a degraded answer.
const VISION_FORMATS = /\.(png|jpe?g|gif|webp)(\?|$)/i;

// Which stored key do we hand the model?
//
// NOT image_url, which is the SOURCE asset: for a library element that is frequently a .glb or an
// .svg, and OpenAI rejects both outright. thumbnail_url and thumb_key are always raster — written
// by services/thumbnails.js as WebP with an image/webp content-type — which is why autoTag, the
// one OpenAI-by-URL path already proven in production, feeds the thumbnail rather than the source.
//
// Ordered best-detail-first: the source when it happens to be a usable raster (a baker's own
// uploaded decoration is a PNG, and it is sharper than any thumbnail we derive), then the master
// thumbnail, then the size-suffixed one. Extension-checked rather than assumed, so a new asset
// type added later degrades to the thumbnail instead of failing at the provider.
function visionImageKey(el) {
  return [el.image_url, el.thumbnail_url, el.thumb_key].find(k => k && VISION_FORMATS.test(k)) ?? null;
}

const CRAFT_FIELDS = 'element_id, guide_type, nozzle_recs, consistency, technique, guide, stages_key, status, model, prompt_version, generated_at, updated_at';
const CONSISTENCIES = ['stiff', 'medium', 'soft'];
const RANKS = ['primary', 'secondary', 'alternative'];

// Validate + normalize a nozzle_recs payload into
// [{ nozzle_id, brand, number, name, rank, confidence }].
//   nozzle_id  — optional link to the nozzles catalog (null for free-typed recs)
//   rank       — presentation tier; defaults to 'primary'
//   confidence — optional GPT match score, clamped to 0..1 (null when unset)
// Returns { ok: true, value } or { ok: false, error }.
function normalizeNozzleRecs(input) {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'nozzle_recs must be an array' };

  const value = [];
  for (const rec of input) {
    if (!rec || typeof rec !== 'object') {
      return { ok: false, error: 'each nozzle rec must be an object' };
    }
    const brand = String(rec.brand ?? '').trim();
    const number = String(rec.number ?? '').trim();
    const name = String(rec.name ?? '').trim();
    if (!brand || !number) {
      return { ok: false, error: 'each nozzle rec needs a brand and a number' };
    }

    const nozzle_id = rec.nozzle_id ? String(rec.nozzle_id) : null;
    const rank = RANKS.includes(rec.rank) ? rec.rank : 'primary';
    let confidence = null;
    if (rec.confidence != null && rec.confidence !== '') {
      const n = Number(rec.confidence);
      if (!Number.isNaN(n)) confidence = Math.min(1, Math.max(0, n));
    }

    value.push({ nozzle_id, brand, number, name, rank, confidence });
  }
  return { ok: true, value };
}

// Stage images are stored as R2 KEYS (the public base is deployment config and would rot every
// stored row), so the API expands them on the way out — the same contract every other asset column
// has, and spattoo-core never learns the bucket. Returns a COPY: an expanded URL round-tripping
// back into storage is exactly the rot the key was chosen to avoid.
function withStageUrl(row) {
  if (!row?.stages_key) return row;
  return { ...row, stages_url: toPublicUrl(row.stages_key) };
}

// ── Read (any authenticated user — bakers viewing X-Ray, admins authoring) ─────

// GET /api/craft-guide?element_ids=id1,id2,...
// Batch fetch craft guides for a set of element ids. X-Ray collects the piping
// element ids from an order's design and asks for all of them at once.
router.get('/craft-guide', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const raw = req.query.element_ids;
    if (!raw) return res.json([]);

    const ids = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from('element_craft_guide')
      .select(CRAFT_FIELDS)
      .in('element_id', ids);

    if (error) return serverError(req, res, error);
    res.json((data ?? []).map(withStageUrl));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// POST /api/admin/craft-guide/suggest
// GPT-suggest a craft guide from an element image, grounded on the nozzle catalog.
// Body: { imageBase64, mimeType } (pre-upload, e.g. AddElement) OR { image_url }
//       (e.g. backfill), plus optional { name, description }.
// Returns { nozzle_recs: [{ nozzle_id, brand, number, name, rank, confidence }],
//           consistency, technique } — recs hydrated from the catalog by id, so
// GPT can't introduce a tip number that isn't real.
router.post('/admin/craft-guide/suggest', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { imageBase64, mimeType, image_url, name, description } = req.body;
    const imageUrl = image_url || (imageBase64 && mimeType ? `data:${mimeType};base64,${imageBase64}` : null);
    if (!imageUrl) {
      return res.status(400).json({ error: 'image_url, or imageBase64 + mimeType, is required' });
    }

    const { data: catalog, error: catErr } = await supabase
      .from('nozzles')
      .select('id, brand, number, name, category, description, is_common')
      .eq('is_active', true);
    if (catErr) return serverError(req, res, catErr);
    if (!catalog?.length) return res.status(400).json({ error: 'nozzle catalog is empty — seed it first' });

    const result = await suggestCraftGuide({ imageUrl, name, description, catalog });

    // Hydrate facts from the catalog by id; drop anything GPT returned that
    // isn't a real catalog entry.
    const byId = new Map(catalog.map(n => [n.id, n]));
    const nozzle_recs = (result?.nozzle_recs ?? [])
      .map(r => {
        const n = byId.get(r.nozzle_id);
        if (!n) return null;
        let confidence = null;
        const c = Number(r.confidence);
        if (!Number.isNaN(c)) confidence = Math.min(1, Math.max(0, c));
        return {
          nozzle_id: n.id,
          brand: n.brand,
          number: n.number,
          name: n.name,
          rank: RANKS.includes(r.rank) ? r.rank : 'secondary',
          confidence,
        };
      })
      .filter(Boolean);

    const consistency = CONSISTENCIES.includes(result?.consistency) ? result.consistency : null;
    const technique = result?.technique ? String(result.technique).trim() : null;

    res.json({ nozzle_recs, consistency, technique });
  } catch (err) {
    console.error('craft-guide suggest error:', err.message);
    serverError(req, res, err);
  }
});

// GET /api/admin/craft-guide/:elementId
// Single fetch for the authoring editor. Returns null if not yet authored.
router.get('/admin/craft-guide/:elementId', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_craft_guide')
      .select(CRAFT_FIELDS)
      .eq('element_id', req.params.elementId)
      // REQUIRED since migration 025 widened the key to (element_id, guide_type). Without it an
      // element carrying BOTH a nozzle guide and a decoration guide returns two rows and
      // maybeSingle() errors — so the authoring editor broke for exactly the elements that have
      // the most guidance. This endpoint is the NOZZLE editor; a decoration guide is read
      // elsewhere and must not be mistaken for one here.
      .eq('guide_type', 'piping_nozzle')
      .maybeSingle();

    if (error) return serverError(req, res, error);
    res.json(data); // null when no row exists yet
  } catch (err) {
    serverError(req, res, err);
  }
});

// PUT /api/admin/craft-guide/:elementId
// Upsert the craft guide for one element. Body: { nozzle_recs, consistency, technique }
router.put('/admin/craft-guide/:elementId', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { elementId } = req.params;
    const { consistency, technique } = req.body;

    const recs = normalizeNozzleRecs(req.body.nozzle_recs);
    if (!recs.ok) return res.status(400).json({ error: recs.error });

    if (consistency != null && consistency !== '' && !CONSISTENCIES.includes(consistency)) {
      return res.status(400).json({ error: `consistency must be one of ${CONSISTENCIES.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('element_craft_guide')
      .upsert(
        {
          element_id:  elementId,
          // Both REQUIRED since 025. The conflict target must name the FULL key or the upsert has
          // no unique constraint to match: the row would be inserted rather than updated, silently,
          // until a later read found two nozzle guides for one element.
          guide_type:  'piping_nozzle',
          nozzle_recs: recs.value,
          consistency: consistency || null,
          technique:   technique?.trim() || null,
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'element_id,guide_type' },
      )
      .select(CRAFT_FIELDS)
      .single();

    if (error) {
      const status = error.code === '23503' ? 404 : 500; // 23503 = FK violation (unknown element)
      return res.status(status).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/elements/:id/xray/decoration-steps ──────────────────────────────
// Generate a step-by-step build guide for ONE decoration, and keep it on the ELEMENT.
//
// Why per-element and not per-order: a lion topper is made the same way every time. Storing the
// guide on the order would charge a baker again for every cake that uses it; storing it on the
// element charges once and every future cake gets it free. The colours that DO vary per cake come
// from the design snapshot at render time, which is why the guide uses role tokens rather than
// colour names.
//
// GATED ON order:manage — the BAKER-only capability — and deliberately NOT on element:manage.
// The guard follows WHO PAYS, not what the object is. `element:manage` is about editing a
// decoration; this spends money. Someone will eventually notice the route is about an element and
// try to "correct" the guard: do not. (Customers hold only design:create + order:place today, so
// they cannot reach this either way — but the rule should not depend on that staying true.)
router.post('/elements/:id/xray/decoration-steps', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });

    // A baker may generate a guide for their OWN element, or for a global library one (baker_id
    // null) they used on a cake. Never for another bakery's private decoration.
    const { data: el } = await supabase
      .from('cake_elements').select('id, name, description, image_url, thumbnail_url, thumb_key, baker_id')
      .eq('id', req.params.id).maybeSingle();
    if (!el) return res.status(404).json({ error: 'Element not found' });
    if (el.baker_id && el.baker_id !== req.bakerId) {
      return res.status(404).json({ error: 'Element not found' });   // not "forbidden" — do not confirm it exists
    }
    // A 3D element whose thumbnails never rendered has nothing a vision model can read. Say so as
    // a 400 rather than letting the provider reject it as a 500 the baker cannot act on.
    const imageKey = visionImageKey(el);
    if (!imageKey) {
      return res.status(400).json({ error: 'This decoration has no image to read.', code: 'NO_ELEMENT_IMAGE' });
    }

    // Already generated → hand it back, charge nothing. This is the amortisation: the second cake
    // using this decoration, and every one after, is free.
    const { data: existing } = await supabase
      .from('element_craft_guide').select(CRAFT_FIELDS)
      .eq('element_id', el.id).eq('guide_type', 'fondant_figure').maybeSingle();
    if (existing) return res.json({ ok: true, reused: true, guide: withStageUrl(existing) });

    // ── WHO PAYS ────────────────────────────────────────────────────────────────────
    // A SPATTOO element must already carry its guide by the time a baker meets it — building it
    // belongs to publishing the element, not to the first baker who happens to open one. Charging
    // them would mean one bakery funding our catalogue for everyone else, and would make a
    // library decoration feel metered on first use when it should feel instant.
    //
    // Until every catalogue element is backfilled, this generates it FREE rather than refusing:
    // the cost is ours by the same rule, and it self-heals — each global element is generated at
    // most once, ever, so the total is bounded by the size of the catalogue and not by traffic.
    //
    // Credits are for what we could NOT know in advance: a photo we have never seen, or a
    // decoration the baker made themselves.
    const oursToPayFor = !el.baker_id;

    const out = await withAiCredits(
      {
        bakerId: req.bakerId,
        action:  AI_ACTION.ELEMENT_BUILD_GUIDE,
        idempotencyKey: `xray-steps:element:${el.id}`,
        free: oursToPayFor,
      },
      async () => {
        const { guide, usage, model } = await suggestBuildGuide({
          imageUrl: toPublicUrl(imageKey), name: el.name, description: el.description,
        });
        // No steps means the model judged this not hand-modelled (a printed decal, an acrylic
        // topper). That is a USEFUL answer, not a failure — but it is not worth a credit, and
        // charging for "we looked and there is nothing to make" would feel like a con.
        if (!guide || !Array.isArray(guide.steps) || guide.steps.length === 0) {
          return { keep: false, note: 'not a modelled decoration', value: { guide, model } };
        }

        // The build sequence. THIS is the case an image pays for itself in: an element guide is
        // generated once and every future cake using that decoration gets it free, so one image
        // call amortises across every baker who ever places the element — where a photo
        // decoration's picture belongs to one order and can never be reused.
        //
        // Best-effort, like the photo path: the words are the product, and an image failure must
        // not throw away steps the baker is about to be charged for.
        const stages = await renderStageImage({
          sourceKey: imageKey,                       // an element image IS the isolated decoration
          objectKey: elementStagesKey(el.id),
          title: guide.title || el.name,
          stepCount: guide.steps.length,
        }).catch(err => {
          console.warn('[xray] element stage image failed, steps kept:', err?.message);
          return null;
        });

        return {
          value: { guide, model, stagesKey: stages?.key ?? null },
          provider: 'openai', model, promptVersion: PROMPT_VERSION,
          calls: [{ model, usage }, ...(stages ? [{ model: stages.model, usage: stages.usage }] : [])],
        };
      },
    );

    // Discarded, so nothing was charged. Two very different reasons, and the baker must be able
    // to tell them apart: the model looked and judged this piped/printed rather than modelled
    // (an ANSWER — a piped rosette's real instruction is the nozzle section above), or it gave
    // us nothing usable (a FAILURE). Collapsing both into "we couldn't read that decoration"
    // made the feature look broken on exactly the decorations it handled correctly.
    if (out.discarded) {
      if (out.discardedValue?.guide) {
        return res.status(200).json({ ok: true, notModelled: true, guide: out.discardedValue.guide, charged: false });
      }
      return res.status(422).json({ error: "We couldn't read that decoration.", code: 'GUIDE_FAILED' });
    }
    if (!out.value?.guide) {
      return res.status(422).json({ error: "We couldn't read that decoration.", code: 'GUIDE_FAILED' });
    }
    const guide = out.value.guide;

    // status stays 'draft' forever for a baker-generated guide: admin review cannot scale to every
    // baker's private decorations, so the sheet must show it as unreviewed rather than pretend a
    // model guess carries the same weight as a curated craft guide.
    // source_image_url stores the KEY, not the rendered URL, despite the column name: the key is
    // the stable identity of the image, while the public URL base is deployment config that can
    // change and would rot every stored row with it. Read it back through toPublicUrl().
    const row = {
      element_id: el.id, guide_type: 'fondant_figure', guide,
      // Who this belongs to, not who triggered it. A guide on OUR element is ours — the baker who
      // happened to open it first did not pay for it and does not own it.
      // baker_id below follows the same rule.
      source_image_url: imageKey, stages_key: out.value.stagesKey ?? null,
      model: out.value.model ?? null,
      prompt_version: PROMPT_VERSION, status: 'draft',
      baker_id: oursToPayFor ? null : req.bakerId, generated_at: new Date().toISOString(),
    };
    const { error: upErr } = await supabase.from('element_craft_guide').upsert(row, { onConflict: 'element_id,guide_type' });
    if (upErr) throw upErr;

    res.json({ ok: true, reused: false, charged: !oursToPayFor, guide: withStageUrl(row) });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.detail });
    }
    serverError(req, res, err);
  }
});

export default router;
