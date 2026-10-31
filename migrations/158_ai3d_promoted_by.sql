-- ── 158: who turned a generation into a decoration, and on whose behalf ──────────────────────────
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Sandeep: *"we should also know if baker promoted it or staff."*
--
-- 154 recorded WHAT a generation became (`promoted_element_id`). It did not record who decided, and
-- the two are different facts: a baker putting their own model on their own cakes is one event, and
-- Spattoo lifting that model into the shared catalogue is quite another.
--
-- ⚠️ THE SAME PAIR AS CREATION, ON PURPOSE. 157 established person + bakery for who MADE it; this is
-- person + bakery for who PROMOTED it, and `promoted_by_baker_id is null` means staff exactly as
-- `baker_id is null` does. One idea to learn, used twice, rather than a second way of saying it.
--
-- ⚠️ AND STORED FOR THE SAME REASON. "Was that a baker or one of us?" is derivable from the person
-- via `baker_appusers` — right up until that person leaves, because that table is a hard DELETE
-- (services/bakerProvisioning.js:224). Deriving it later is exactly the trap 157 was written to
-- avoid, and this is the question where it would hurt most: provenance matters most at the moment
-- something becomes visible to MORE people.
--
-- ⚠️ EVIDENCE, NOT A GATE — carried over verbatim from the upload promotion columns it mirrors
-- (supabase/baker_uploads.sql). Promotion is not reviewed and not consent-gated: Spattoo is an
-- intermediary and the baker has already accepted responsibility for what they publish. A tick
-- clicked on every promotion would be the habituated tick that is worthless as evidence. We record
-- who did it; we do not ask them to promise anything.
--
-- ⚠️ NOTHING WRITES THESE YET, and that is deliberate rather than premature. No promotion action
-- exists — `promoted_element_id` has been readable since 154 and is set nowhere. Adding the columns
-- with it means the action writes all four from its first line, instead of shipping, and then
-- needing a second migration and a backfill that can only guess.
BEGIN;

alter table ai3d_generations add column if not exists promoted_by uuid;
alter table ai3d_generations add column if not exists promoted_by_baker_id uuid references bakers (id);
alter table ai3d_generations add column if not exists promoted_at timestamptz;

comment on column ai3d_generations.promoted_by is
  'The person who turned this generation into a decoration. Evidence, not a gate.';
comment on column ai3d_generations.promoted_by_baker_id is
  'That person''s bakery, or NULL for an internal/staff promotion. Mirrors baker_id (157): stored '
  'rather than derived, because baker_appusers is a hard delete and the answer must outlive them.';
comment on column ai3d_generations.promoted_at is
  'When it was promoted. NULL together with promoted_element_id means "generated, never used".';

-- The baker's own list: their bakery's generations that nobody has turned into a decoration.
-- Partial, because the rows this question asks about are exactly the ones where it is NULL — so the
-- index stays small no matter how many generations are eventually promoted.
create index if not exists ai3d_generations_unpromoted
  on ai3d_generations (baker_id, created_at desc)
  where promoted_element_id is null;

COMMIT;
