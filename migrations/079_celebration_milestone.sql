-- ── 079: a milestone birthday is its own kind of celebration ─────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- The adult branch of "What kind of celebration?" offered exactly two answers — a grown-ups'
-- celebration, or one for elders. A 40th or a 60th is neither: it is the case people plan hardest
-- for and spend most on, and it had to be filed as an ordinary grown-ups' do.
--
-- ⚠️ "A milestone birthday", NOT "a big birthday". Big reads as a LARGE PARTY, which is the wrong
-- axis entirely for a field whose job is to steer the flavour — and milestone is the word people
-- already use for a round-number birthday.
--
-- ⚠️ A CHECK CANNOT BE EXTENDED IN PLACE. It is dropped and recreated, which is why 046 still
-- contains the original five and always will, and why check:occasions reads the NEWEST migration
-- that names the constraint rather than the earliest.
--
-- ⚠️ THREE LISTS, ONE CONTRACT. This constraint, `CELEBRATIONS` in spattoo-backend
-- src/routes/orders.js, and `CELEBRATIONS` in spattoo-core cakeDraft.js. Change them together or
-- the failure is one of two silent ones: a value the CHECK does not know reaches the insert and
-- returns an unreadable 500 at the moment the customer presses send, or the API refuses a value
-- every screen offers and names a vocabulary nobody has seen. Until this migration the celebration
-- vocabulary was ungated — occasions had a gate and this did not, though it is the same shape.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_celebration_valid;
ALTER TABLE public.orders ADD CONSTRAINT orders_celebration_valid CHECK (
  celebration IS NULL OR celebration IN
  ('first_birthday','kids_party','teen_party','grown_ups','milestone','elders'));

COMMENT ON COLUMN public.orders.celebration IS
  'The KIND of celebration the cake is for — never anybody''s age (see 046). Offered per recipient: child → first_birthday/kids_party/teen_party, adult → grown_ups/milestone/elders; not asked for a couple, the family, friends or the office.';
