// ── The managed R2 folders ───────────────────────────────────────────────────────────────────────
//
// WHICH folders exist, and what KIND of asset each holds. Split out of signUpload.js so that asking
// "is this string one of our object keys?" does not require the upload policy — and therefore does
// not require `config.js`, which demands ten env vars including OpenAI, Redis and remove.bg.
//
// That mattered the moment a second consumer appeared: `scripts/migrate-master-to-prod.mjs` runs at
// rollout with dev Supabase credentials and nothing else, and `--dry-run` is meant to work against
// a bare .env. Importing the upload policy to learn the folder NAMES would have made the rollout
// script refuse to start without an OpenAI key.
//
// The list stays singular. signUpload.js derives FOLDER_POLICY from this map, so a new folder is
// added HERE, once, and the type/size policy and the key-recognition both pick it up.

// The byte ceilings and content-type allowlists live in signUpload.js (they are ENV-driven and
// security-critical); this map records only which of the four kinds each folder is.
export const FOLDER_KIND = {
  'elements/files/2D':    'image',
  'elements/files/3D':    'model',
  'elements/thumbnails':  'image',
  // A chocolate piece a baker drew in the garnish studio. Written SERVER-side (putObject) rather
  // than through a signed upload, so it needs no ceiling here — but it must be in this list, because
  // ⚠️ THIS LIST IS WHAT THE EXPORT WALK RECOGNISES AS ONE OF OUR OBJECTS. A folder missing from it
  // is invisible to `assetKeysIn`, so the row promotes to prod and its picture never travels: the
  // element arrives, renders, and has no thumbnail, with nothing failing anywhere.
  'garnishes/thumbs':     'image',
  // A browsing category's own menu picture — typically a hand-made collage of three or four of the
  // decorations in it, which says what the category holds better than the one borrowed element
  // thumbnail it falls back to. See migration 068.
  'categories/thumbnails': 'image',
  // A photograph of a piping nozzle and its tip, for the nozzle catalogue (migration 096). A baker
  // recognises a tip by its shape long before its model number, which is all the X-Ray report can
  // say today. ⚠️ Registered here for the reason spelled out above: without this line the catalogue
  // promotes to prod and every picture silently stays behind.
  'nozzles/images':       'image',
  'templates/files':      'model_or_json',
  'templates/thumbnails': 'image',
  // Front view of a cake shape, captured through the real designer renderer when admin saves the shape.
  // The New-cake picker shows these as <img> — one image per shape, rather than one WebGL context per
  // shape (browsers cap those around 16, so a live-3D grid blanks tiles once the catalog grows).
  'shapes/thumbnails':    'image',
  'logos':                'image',
  'portraits':            'image',   // baker portrait for the storefront "Our story" section
  'storefront/gallery':   'image',   // baker cake photos for the storefront slideshow
  'orders/thumbnails':    'image',
  'orders/photos':        'image',   // baker-uploaded finished-cake photos (public → inline in order-ready email)
  'orders/reference':     'image',   // customer reference photos — a manual order's picture, and the storefront photo door
  // A photograph of a cake the baker has ALREADY MADE, uploaded straight into their catalogue
  // (migration 116, type='photo'). ⚠️ THIS LINE WAS MISSING AND THE FEATURE WAS DEAD. The upload
  // control shipped in 0.1.610 signing into 'catalogue/photos', and signUpload 400s any folder that
  // is not in this map — so every upload failed at the signing step. `uploadThumbnail` catches and
  // returns null, and the route then answered "thumbnail_url is required for a photo": two failures,
  // neither visible, and zero photo rows ever created. The registry is the ONE place a folder is
  // declared, and not declaring it here is indistinguishable from not building the feature.
  'catalogue/photos':     'image',
  'customer/photos':      'image',   // customer-uploaded photo for a photo-cake frame (public → designer textures it)
  'meshy/source':         'image',   // uploaded 2D image for the image→3D wizard (public so Meshy can fetch it)
  'meshy/outputs':        'model',   // our copy of the Meshy-generated GLB (written server-side via putObject)
  // Our copy of a 3D generation, mirrored server-side the moment the vendor says SUCCEEDED — a
  // baker paid credits for it and the vendor's own URL expires. ⚠️ THE ONLY FOLDER WITH A RETENTION
  // WINDOW (see below): most generations are rejects, so they are kept while they matter and swept
  // after. Promotion to an element COPIES the file out of here first.
  'ai3d/runs':            'model',
  // "Extract Elements": the uploaded cake photo we identify decorations in. Public so GPT-4o vision
  // can fetch it by URL. Crops + regenerated outputs are written SERVER-side via putObject (no signed
  // upload needed for those), but they share this folder tree — see routes/elementExtract.js.
  'elements/candidates':  'image',
  // The typeface a text_styles row shapes its placeholder glyphs with. The face is DATA, not a
  // hardcoded family — a new art style is a new font + config row, never a code change.
  'elements/fonts':       'font',
};

/* ── Folders a lifecycle rule sweeps ─────────────────────────────────────────────────────────────
 *
 * ⚠️ ONE NUMBER, READ BY BOTH SIDES. `scripts/set-r2-lifecycle.mjs` writes the R2 rule and
 * `routes/ai3d.js` has to know when a stored key stops being true — and if those two numbers are
 * typed separately they drift, at which point a row claims `mirrored: true` for an object R2 has
 * already deleted. That is the same failure `check:medium-vocab` exists to prevent, one folder
 * wide. This module is dependency-free on purpose (see the header), so both can import it.
 *
 * Absent from this map = kept for ever, which is the right default for everything a cake points at.
 */
export const FOLDER_RETENTION_DAYS = {
  // Derived JPEG copies for WhatsApp headers — delete one and the next send regenerates it.
  'notifications/whatsapp-media': 90,
  /* Generated models. 90 days — Sandeep: *"we will keep them for 90 days."*
     ⚠️ WE STORE THESE BECAUSE THEY ARE OURS TO SERVE, NOT BECAUSE A VENDOR LINK EXPIRES. The
     original note here reasoned from Meshy's URLs timing out, and that is the wrong reason for the
     right behaviour: we serve our own assets from our own bucket behind our own CDN, so we would
     copy the file in even if the vendor kept theirs for ever. Sandeep: *"we are nothing to do with
     meshy or tripo url expiry. we anyways need to store them and cahe them in cloudflair."*
     ⚠️ AND SWEEPING THIS PREFIX NEVER TOUCHES A CONVERTED MODEL. An element does not reference the
     run file — GlbStudio uploads its own finished build to `elements/files/3D/`, a different object
     in a different prefix that nothing here expires. So this number governs exactly one population:
     generations nobody turned into a decoration (`promoted_element_id is null`). That is why one
     uniform rule is enough, and why no exception mechanism is needed for the ones that were kept.
     The ROW outlives the file either way, with its prompt and both seeds — so an expired generation
     is one regeneration away, which costs credits but not the idea. */
  /* ⚠️ NULL MEANS NOTHING SWEEPS THIS YET, AND THAT IS THE CURRENT DECISION. Sandeep: *"lets not
     worry about 90 days thing right now. there is a long time still to think of removal of things.
     we dont have any users in system yet :) ... as long as we can differentiate what elements are
     not used, we should be good."*

     ⚠️ IT IS NULL RATHER THAN 90-BUT-UNAPPLIED BECAUSE A NUMBER HERE IS A CLAIM THE API MAKES. The
     route dates every stored model from this value and stops serving one past it. Leaving 90 here
     while no lifecycle rule exists would, in 90 days, hide files that are still sitting in the
     bucket — the exact fault just fixed for `meshy/outputs/`, where a model had "expired" six weeks
     earlier and a GET still returned all 49.72 MB of it. An expiry asserted over a prefix nobody
     sweeps hides what we still have. So: no rule, no number, nothing hidden.

     The intended value when deletion is turned on is 90 days, and the reasoning is measured rather
     than guessed: a raw generation is ~49.7 MB, about 2 cents a year to store, against 40 cents to
     regenerate. Set it back to 90 and run `npm run r2:lifecycle -- --apply` together — the script
     skips a null, so the number and the rule can never disagree.

     What this does NOT affect is telling used from unused: that is
     `promoted_element_id is null` on the row, which has nothing to do with retention. */
  'ai3d/runs': null,
};

export const ALLOWED_FOLDERS = Object.keys(FOLDER_KIND);
