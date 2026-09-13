-- ── 093: Vertical Piping — the first cream style piped from a MESH ────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
-- The style ships in code (spattoo-core 0.1.528: `piped_modelled`, wall `strokes`), and
-- the designer renders it from the seed with no row at all. But a material only offers
-- the styles ITS OWN `materials` row lists — applyMaterialConfig REPLACES the in-code
-- list rather than merging it — so on any environment whose materials table is seeded,
-- the new style is invisible until this runs. That is correct (the enabled set is
-- admin's, not the code's); it is also why "it works in dev" proves nothing here.
--
-- Two statements, and only the first is strictly required:
--
--   1. materials      — offer it on buttercream and whipped.        REQUIRED.
--   2. cake_textures  — make it AUTHORABLE (label, sliders, mesh).  Optional.
--
-- ⚠️ STATEMENT 1 APPENDS, IT DOES NOT ASSIGN. A live row already reads something like
-- ['wave','ribbed'] — and `ribbed` is not in the code seed at all, so assigning the
-- seed's list would silently DELETE a style a baker is using. It is also guarded so a
-- re-run cannot duplicate the key.
--
-- ⚠️ STATEMENT 2 IS `do nothing` ON CONFLICT, deliberately. The row is the AUTHORABLE
-- overlay: once an admin has retuned the sliders, a re-run of this file must not stomp
-- them. To deliberately reset it to the code's values, delete the row and re-run.
--
-- ⚠️ `config.params` REPLACES the code schema wholesale — the designer reads
-- `Array.isArray(row.config.params) ? row.config.params : seed.params`, it does not
-- merge. A row carrying only the one slider someone wanted to retune DELETES the other
-- six. The array below is generated from the code seed for exactly that reason.
--
-- ⚠️ THE MESH IS NOT AN ELEMENT. `config.strokeGlb` is an R2 key under `code/`, beside
-- the env map — an asset the app needs to render, not a catalogue row a baker places.
-- Upload it before or after; without it the style renders a smooth wall, never a broken
-- one. An absolute URL is accepted here too, if the file lives somewhere else.
--
--   Asset: code/cream/piping-stroke-vertical.glb   (207,680 bytes, 8,908 triangles)
--
-- Docs: spattoo-docs/features/cream-textures.md

-- 1. Offer it on the cream materials (fondant and glaze stay smooth-only). ───────────
update materials
   set config     = jsonb_set(
                      config,
                      '{styles}',
                      coalesce(config->'styles', '[]'::jsonb) || '"piped_modelled"'::jsonb
                    ),
       updated_at = now()
 where key in ('buttercream', 'whipped')
   and not coalesce(config->'styles', '[]'::jsonb) @> '"piped_modelled"'::jsonb;

-- 2. Make it authorable: label, sliders and the mesh key, overlaid on the code seed. ──
insert into cake_textures (key, label, algorithm, config, sort_order) values
  ('piped_modelled', 'Vertical Piping', 'strokes', '
  {
    "strokeGlb": "code/cream/piping-stroke-vertical.glb",
    "params": [
      {
        "key": "width",
        "label": "Nozzle (in)",
        "min": 0.3,
        "max": 1.6,
        "step": 0.05,
        "default": 0.93,
        "user": true
      },
      {
        "key": "foot",
        "label": "Foot ends at",
        "min": 0,
        "max": 0.45,
        "step": 0.01,
        "default": 0.29,
        "user": false
      },
      {
        "key": "tip",
        "label": "Tip starts at",
        "min": 0.55,
        "max": 1,
        "step": 0.01,
        "default": 0.85,
        "user": false
      },
      {
        "key": "crown",
        "label": "Tips above rim",
        "min": 0,
        "max": 1.5,
        "step": 0.05,
        "default": 0.35,
        "user": true
      },
      {
        "key": "overlap",
        "label": "Overlap",
        "min": 0.1,
        "max": 0.6,
        "step": 0.02,
        "default": 0.39,
        "user": true
      },
      {
        "key": "press",
        "label": "Press in",
        "min": 0,
        "max": 1,
        "step": 0.05,
        "default": 0,
        "user": false
      },
      {
        "key": "vary",
        "label": "Hand variation",
        "min": 0,
        "max": 1,
        "step": 0.05,
        "default": 0.35,
        "user": true
      }
    ]
  }
'::jsonb, 60)
on conflict (key) do nothing;

-- ── Verify ─────────────────────────────────────────────────────────────────────────
-- select key, config->'styles' from materials where key in ('buttercream','whipped');
--   expect each array to END with "piped_modelled", everything else untouched.
-- select key, label, algorithm, config->>'strokeGlb' from cake_textures where key = 'piped_modelled';
