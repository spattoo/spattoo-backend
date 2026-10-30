import { Router } from 'express';
import sharp from 'sharp';
import { UUID_RE } from '../lib/uuid.js';
import { serverError } from '../lib/httpError.js';
import { toPublicUrl } from '../lib/publicUrl.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { getObjectBuffer, putObject, deleteObject, objectStat } from '../services/r2.js';
import { encodeLogoWebp } from '../services/logoImage.js';

// ── Baker logos: what they weigh, and re-encoding the heavy ones ────────────────────────────────
// This began life as scripts/backfill-logo-webp.mjs, which was the wrong shape twice over. Sandeep:
// *"instead of making these mjs files and adding these env keys always, admin already has them. why
// dont we make it part of admin, so this can be used in future also"* — a script needs R2 and
// Supabase credentials pasted into somebody's shell, and it is reachable only by whoever remembers
// it exists. The API already holds both sets of credentials, and admin already has a door.
//
// ⚠️ AND MOVING IT HERE IS WHAT MADE IT CORRECT, not just reachable. The script OVERWROTE
// `<logoKey>-nobg.webp` in place. Every object putObject writes carries
// `public, max-age=31536000, immutable`, so overwriting a key means:
//   - Cloudflare keeps serving the old bytes until its own rule expires (a month)
//   - every browser that already has it keeps them for a year
// It would have written a smaller logo that nothing ever fetched. check:object-keys exists for
// exactly this and its reviewed list says so of the craft guide, which had the same problem: *"a
// guide is REBUILT, so the key must differ per generation or the immutable cache pins the old
// picture forever. The caller deletes the previous object."* So a re-encode MINTS A NEW KEY, points
// the baker row at it, and deletes the old object — and the saving is real the moment it is applied.
//
// Capability is `baker:onboard`, the same platform capability /admin/bakers and
// /admin/storefront-usage use. This reads and rewrites baker account assets; it is not a new kind
// of authority and does not deserve a new name for one.

const router = Router();

// The re-encode is a REBUILD, so the generation has to be in the key — see the note above. Built
// from the original upload key, which is itself minted once, so two re-encodes a millisecond apart
// cannot collide and a key still says which logo it belongs to when you are reading R2 by hand.
function nextTransparentKey(logoKey) {
  return `${String(logoKey).replace(/\.[^./]+$/, '')}-nobg-${Date.now()}.webp`;
}

// One read of a baker's logo state, shared by the list and the re-encode so they cannot disagree
// about what "current" means. HeadObject only — no bytes — because the list calls this for every
// baker at once and the sizes are the whole point of the screen.
async function describe(baker) {
  const key = baker.logo_transparent_key;
  const stat = key ? await objectStat(key) : null;
  return {
    bakerId:   baker.id,
    name:      baker.name,
    slug:      baker.slug ?? null,
    key,
    url:       toPublicUrl(key),
    originalUrl: toPublicUrl(baker.logo_url),
    bytes:     stat?.size ?? null,
    // Surfaced because it is the difference between a logo a browser re-fetches every visit and one
    // it keeps. Everything putObject writes has it; anything that arrived another way may not.
    immutable: /immutable/.test(stat?.cacheControl ?? ''),
    missing:   !!key && !stat,
  };
}

// ── GET /api/admin/baker-logos ──────────────────────────────────────────────────────────────────
// Every baker that has a cut-out logo, heaviest first. Heaviest first because the whole reason to
// open this screen is to find the heavy ones — a list in name order buries them, the same mistake
// storefront-usage deliberately avoids by putting the quietest shops on top.
router.get('/admin/baker-logos', requireAuth, requireCapability('baker:onboard'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bakers')
      .select('id, name, slug, logo_url, logo_transparent_key')
      .not('logo_transparent_key', 'is', null);
    if (error) return serverError(req, res, error);

    const rows = (await Promise.all((data ?? []).map(describe)))
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

    res.json({
      rows,
      summary: {
        logos: rows.length,
        bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
        missing: rows.filter(r => r.missing).length,
      },
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/admin/baker-logos/:bakerId/reencode ───────────────────────────────────────────────
// Body: { apply?: boolean, preview?: boolean }
//
// Without `apply` this writes NOTHING and answers "what would happen" — the before and after byte
// counts, and with `preview` the re-encoded image itself as a data URL. That is not a convenience:
// this is a LOSSY conversion on a baker's own brand mark, so the person pressing the button has to
// be able to see the result beside the original before they press it (INVARIANTS #11 — a control
// and what it changes are visible at the same time).
router.post('/admin/baker-logos/:bakerId/reencode', requireAuth, requireCapability('baker:onboard'), async (req, res) => {
  try {
    const { bakerId } = req.params;
    if (!UUID_RE.test(bakerId)) return res.status(400).json({ error: 'Invalid baker id.' });

    const apply   = req.body?.apply === true;
    const preview = req.body?.preview === true;

    const { data: baker, error } = await supabase
      .from('bakers')
      .select('id, name, logo_url, logo_transparent_key')
      .eq('id', bakerId)
      .single();
    if (error) return serverError(req, res, error);
    if (!baker?.logo_transparent_key) return res.status(404).json({ error: 'This baker has no cut-out logo.' });

    const current = await getObjectBuffer(baker.logo_transparent_key).catch(() => null);
    if (!current) return res.status(404).json({ error: 'The logo object is missing from storage.' });

    const next   = await encodeLogoWebp(current);
    const meta   = await sharp(next).metadata();
    const saving = 1 - next.length / current.length;

    const result = {
      bakerId,
      name:   baker.name,
      before: current.length,
      after:  next.length,
      saving,
      width:  meta.width,
      height: meta.height,
      // The encoder keeps whichever of the two encodes is smaller, so "no change" is a real and
      // correct outcome — a flat wordmark is already at its best as lossless. Saying so plainly
      // stops it reading as a failure.
      alreadyOptimal: next.length >= current.length,
      ...(preview ? { previewDataUrl: `data:image/webp;base64,${next.toString('base64')}` } : {}),
    };

    if (!apply) return res.json({ applied: false, ...result });

    if (result.alreadyOptimal) return res.json({ applied: false, ...result });

    // Order matters. Write the new object, point the row at it, and only then delete the old one:
    // a failure at any step leaves a baker with a logo that works. The reverse order can leave the
    // column pointing at bytes that are gone.
    const previousKey = baker.logo_transparent_key;
    const newKey = nextTransparentKey(baker.logo_url || previousKey);
    await putObject(newKey, next, 'image/webp');

    const { error: upErr } = await supabase
      .from('bakers')
      .update({ logo_transparent_key: newKey })
      .eq('id', bakerId);
    // The new object is orphaned rather than removed: deleting it here would race a retry, and an
    // unreferenced object costs storage while a broken logo costs a baker their brand.
    if (upErr) return serverError(req, res, upErr);

    // Best-effort. A leaked old object is a sweep job; a failed delete is not a reason to tell
    // somebody the re-encode did not happen, because it did.
    await deleteObject(previousKey).catch(() => {});

    res.json({ applied: true, previousKey, key: newKey, url: toPublicUrl(newKey), ...result });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
