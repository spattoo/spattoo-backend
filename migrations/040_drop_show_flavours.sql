-- ── 040: bakers.show_flavours goes ──────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ⚠ RUN THIS LAST. The API must already be deployed with the code that stops reading and
-- writing this column, or the first save from a running instance fails on a column that
-- is no longer there. The deploy is safe on its own — it ignores the field, including
-- from an older client still sending it — so the safe order is: deploy, then this.
--
-- ── WHY IT IS BEING REMOVED, ONE DAY OLD ────────────────────────────────────────────
-- It was added in 037 as one half of "who sees my flavours, and who sees my prices",
-- before it was clear the storefront already HAS a section system. Whether a storefront
-- displays the flavour list is a section being enabled or not — content, decided in the
-- customiser, alongside Cake photos and Our story. A second switch on the baker record
-- says the same thing from somewhere else, and two controls for one fact can disagree.
--
-- ── THE BUG IT CAUSED, WHICH IS THE REAL REASON ─────────────────────────────────────
-- `flavoursForCustomer` returned an EMPTY list when the flag was false — and
-- GET /api/flavours is what the order form's flavour picker reads. So a baker who hid
-- their menu also emptied the dropdown their customers use to choose a flavour when
-- ordering. Hiding marketing is a decision a baker might reasonably make; breaking their
-- own order form is not one they asked for, and nothing on screen would have explained
-- it.
--
-- Dropped rather than left in place and ignored: a column nothing reads is a trap for
-- whoever finds it next and assumes it means something. `price_visibility` stays — that
-- is a genuinely separate disclosure and it works.
--
-- PERSISTED SCHEMA IS FOREVER, so the moment to undo this is now, at one day old, with
-- no baker having relied on it.

BEGIN;

ALTER TABLE public.bakers DROP COLUMN IF EXISTS show_flavours;

COMMIT;
