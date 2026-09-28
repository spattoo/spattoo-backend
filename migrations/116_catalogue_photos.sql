-- ── A catalogue entry can be a PHOTOGRAPH of a cake already made ────────────────────────────────
--
-- Sandeep: "a baker can also upload an existing cake image he made to catalogue… he does it only
-- when he is sure to show him prev work, he can add it to catalogue."
--
-- Until now every row in cake_templates was a 3D design: `design jsonb NOT NULL`. A photo has no
-- design — it is a picture of finished work, shown to say "I have made this", not opened on the
-- canvas. It belongs in the catalogue beside the designs because that is the one list a customer
-- sees, and splitting it into a second table would mean two sources for "what does this baker
-- offer" — the exact duplication lib/templateList.js exists to prevent.
--
-- ── WHY `type` AND NOT A NEW COLUMN ─────────────────────────────────────────────────────────────
-- `type` already exists, defaults to 'basic', and is selected and filterable end to end
-- (lib/templateList.js FIELDS, and the ?type= query on GET /api/templates). It was added for a
-- basic/premium split that never happened — Sandeep: "we might have thought basic and premium
-- templates previously. but thats not practical anyways. a premium template can be easily
-- constructed with the elements by the user, since we are not restricting on the elements." That
-- job now belongs to `offering` ('standard' | 'premium'), which is what the Premium badge reads.
--
-- So `type` is free, and better than inferring "photo" from a null design: a nullable column says
-- what is MISSING, a type says what a row IS. Measured on dev before reusing it: 35 rows, every one
-- 'basic', three write sites that hardcode it, zero read sites. Nothing to backfill.
--
--   type = 'basic'  a 3D design. Opens on the canvas. `design` is present.
--   type = 'photo'  an uploaded picture. Cannot be opened. `design` is null.
--
-- ⚠️ `?type=basic` NOW MEANS "things that can be opened", which is what the start chooser and any
-- future load-a-design path should ask for. It costs nothing to pass and it is already plumbed.

begin;

-- ── design: null for a photo ────────────────────────────────────────────────────────────────────
alter table public.cake_templates
  alter column design drop not null;

-- ── tier_count: NULLABLE rather than defaulted ──────────────────────────────────────────────────
-- ⚠️ DELIBERATELY NOT `default 1`. A photo's tier count is unknown, and a guessed 1 is not a
-- harmless placeholder: `cake_template_attrs` and the browse filters let a customer narrow by tiers,
-- so a wrong number puts a three-tier photograph in front of someone who asked for one tier. Null
-- means "not stated", which is the truth and which a filter can exclude honestly.
alter table public.cake_templates
  alter column tier_count drop not null;

-- ── The rule the two kinds must obey ────────────────────────────────────────────────────────────
-- ⚠️ A CHECK RATHER THAN A CONVENTION. Without it "a photo has no design" is a thing every writer
-- has to remember, and the first one that forgets creates a basic row with no design — which reads
-- as a template whose tap does nothing, the exact dead-tile this feature has to avoid. The database
-- is the only place this can be said once.
alter table public.cake_templates
  add constraint cake_templates_kind_shape check (
        (type = 'photo' and design is null)
     or (type <> 'photo' and design is not null)
  );

comment on column public.cake_templates.type is
  'What this row IS: ''basic'' = a 3D design (design present, opens on the canvas); ''photo'' = an '
  'uploaded picture of finished work (design null, cannot be opened). NOT the premium flag — that '
  'is `offering`.';

comment on column public.cake_templates.tier_count is
  'Tiers, when known. Null for a photo: unknown rather than one, so the browse filters can exclude '
  'it honestly instead of narrowing on a guess.';

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────────────────────────
-- Expect: every existing row still 'basic' with a design, and the constraint in place.
select type, count(*),
       count(*) filter (where design is null)      as no_design,
       count(*) filter (where tier_count is null)  as no_tier_count
  from public.cake_templates
 group by type
 order by 2 desc;
