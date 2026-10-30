-- ── 150: how a material should read TO A GENERATOR ──────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- 149 resolves the "Made of" question from `decoration_mediums` so no client can hold its own copy
-- of the material list. It derived the prompt phrase from the LABEL, which is a shortcut that fails
-- the moment a label is written for a human — and ours are:
--
--     "Wafer paper (shaped)"   → "wafer paper (shaped) finish"   ← parenthetical leaks into the prompt
--     "Cream — palette knife"  → "cream — palette knife finish"  ← em dash leaks
--     "Other"                  → "other finish"                  ← means nothing to a generator
--
-- A label answers "what do I pick"; a prompt phrase answers "what do I say to the model". They are
-- different sentences for the same row, so the row carries both rather than one being computed
-- badly from the other.
--
-- ⚠️ NULL MEANS "DO NOT OFFER THIS FOR GENERATION", and that is a separate claim from can_model.
-- `can_model` says a HUMAN can hand-make it — true of "Other", which is why X-Ray offers a
-- modelling guide for it. But there is no sentence that describes "Other" to a generator, and
-- inventing one spends a baker's credits on a material nobody named. One column, two honest
-- answers, neither derived from the other.
alter table decoration_mediums add column if not exists prompt_phrase text;

comment on column decoration_mediums.prompt_phrase is
  'How this material is described TO A 3D GENERATOR. NULL = not offered for generation (distinct '
  'from can_model, which is about hand-making). Authored, never derived from label.';

update decoration_mediums set prompt_phrase = 'smooth fondant finish'              where key = 'fondant';
update decoration_mediums set prompt_phrase = 'moulded chocolate finish'           where key = 'chocolate';
update decoration_mediums set prompt_phrase = 'modelling chocolate finish'         where key = 'modelling_chocolate';
update decoration_mediums set prompt_phrase = 'matte marzipan finish'              where key = 'marzipan';
-- Isomalt is cooked and poured, not modelled — so it reads as glass, not as paste.
update decoration_mediums set prompt_phrase = 'clear glossy sugar glass finish'    where key = 'isomalt';
-- Wafer paper is CUT, not sculpted: flat layered shapes, never rounded volume.
update decoration_mediums set prompt_phrase = 'thin flat layered paper shapes'     where key = 'wafer_paper';
update decoration_mediums set prompt_phrase = 'matte piped royal icing finish'     where key = 'royal_icing';
-- Palette-knife work is pressed: raised edges, scraped middle. Not a smooth modelled surface.
update decoration_mediums set prompt_phrase = 'thick palette-knife texture, raised edges' where key = 'cream_knife';
-- Deliberately left NULL: 'other', and every can_model = false row.
