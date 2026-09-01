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
  'customer/photos':      'image',   // customer-uploaded photo for a photo-cake frame (public → designer textures it)
  'meshy/source':         'image',   // uploaded 2D image for the image→3D wizard (public so Meshy can fetch it)
  'meshy/outputs':        'model',   // our copy of the Meshy-generated GLB (written server-side via putObject)
  // "Extract Elements": the uploaded cake photo we identify decorations in. Public so GPT-4o vision
  // can fetch it by URL. Crops + regenerated outputs are written SERVER-side via putObject (no signed
  // upload needed for those), but they share this folder tree — see routes/elementExtract.js.
  'elements/candidates':  'image',
  // The typeface a text_styles row shapes its placeholder glyphs with. The face is DATA, not a
  // hardcoded family — a new art style is a new font + config row, never a code change.
  'elements/fonts':       'font',
};

export const ALLOWED_FOLDERS = Object.keys(FOLDER_KIND);
