-- ── 109: what a cake SAYS, and who it is FOR ────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — inserts are guarded.
--
-- ── WHY TWO NEW CATEGORIES ──────────────────────────────────────────────────────────────────────
-- Sandeep: *"right now we are only seaching based on the occassion not my emotion. a 'sorry' cake, a
-- 'feeling good' cake are not regular occasions."*
--
-- A sorry cake has no occasion. Neither does a thank-you cake, a get-well cake, or the one a friend
-- brings round when something has gone wrong. Today they all land in the customer's `other` → "Just
-- because", which carries no signal at all, and a baker filing a template has nowhere to put the
-- thing the cake actually means.
--
-- The evidence this dimension was missing is already in the codebase, written by whoever needed it
-- and had nowhere to put it. cakeDraft.js OCCASIONS carries:
--
--     ['love', 'To say I love you'],   -- "A MOTIVE, not an event"
--
-- An emotion smuggled into the occasion list, with a comment admitting it is not an event.
--
-- ── THE TEST EACH EMOTION HAD TO PASS ───────────────────────────────────────────────────────────
-- An emotion is what the cake SAYS, not when it is given. If it can sit alongside any occasion — a
-- birthday cake that says sorry — it belongs here. If it only ever REPLACES an occasion, it does
-- not. That test is what keeps this from becoming a second occasion list.
--
-- ── AND WHY RELATIONSHIP IS A SEPARATE AXIS, NOT MORE EMOTIONS ──────────────────────────────────
-- Asked for: "Love You, Mom", "Best Dad Ever", "For My Sister", "You're the Best Grandma". Those are
-- not emotions — they are an emotion plus a PERSON. Enumerating the phrases is 14 emotions × 13
-- relationships = 182 tags, nearly all of which nothing would ever carry. Two dimensions that
-- combine, per root CLAUDE.md rule 2: a second variant is a new row in a config table, never a
-- second component.
--
-- ⚠️ THIS IS NOT `RECIPIENTS`. cakeDraft.js already has child/adult/couple/family/friends/colleagues
-- — who the PARTY is for, steering flavour and occasion, behind a CHECK (migration 046) and policed
-- by check-occasions as a three-part contract. Different axis. Untouched here.
--
-- ⚠️ EVERYTHING HERE IS ai_assignable = false. The vision tagger can see a rainbow in a thumbnail.
-- It cannot see that a cake means SORRY — that intent is in the words piped on it, or in the head of
-- whoever ordered it. Offering these to the model would invite confident nonsense at 0.75.

-- ── 1. The category column has to admit them first ──────────────────────────────────────────────
-- ⚠️ A CHECK CANNOT BE EXTENDED IN PLACE. It is dropped and recreated — the same dance
-- check-occasions.mjs documents for orders_occasion_valid, and the reason that gate reads only the
-- NEWEST migration defining a constraint.
--
-- The seven existing values are repeated verbatim. Dropping one here would orphan every tag already
-- filed under it, with the failure surfacing as an insert error weeks later on an unrelated screen.
alter table tags drop constraint if exists tags_category_check;

alter table tags add constraint tags_category_check
  check (category = any (array[
    'occasion', 'style', 'color', 'material', 'theme', 'age_group', 'gender',
    'emotion', 'relationship'
  ]));

-- ── 2. The emotion vocabulary ───────────────────────────────────────────────────────────────────
-- ⚠️ GUARDED ON SLUG ALONE, NOT slug + category, AND THAT IS THE DIFFERENCE FROM 108.
-- 108 guards `where t.slug = v.slug and t.category = 'occasion'`, and its comment says the table has
-- "no unique constraint on slug to conflict against". That was already untrue when it was written:
-- `tags_slug_key UNIQUE (slug)` is in the schema dump of 2026-08-12, six weeks before 108. It got
-- away with it because every slug it inserts is an occasion slug, so it never met a cross-category
-- collision. This migration would: `welcome` and `congratulations` are plausible existing occasion
-- tags, and a category-scoped guard would fail to skip them and then fail the unique constraint.
--
-- Guarding on the slug alone is correct whether or not that constraint is still there.
--
-- ⚠️ NUMBERING: tens, so anything can be slotted between later without renumbering — 108's rule.
-- `appreciation` sits at 25 beside `thank-you` because that is the tag it must be told apart from,
-- and `with-you` at 75 inside the hard-times block.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'emotion', false, v.sort_order, true
from (values
  -- Apology and gratitude. `thank-you` is for something someone DID; `appreciation` is for what they
  -- ARE, or keep doing — ongoing, often institutional, and the one emotion here that a BUSINESS
  -- orders repeatedly (a teacher, a nurse, a long-serving cook, a team that shipped something). If
  -- that line is fuzzy, bakers file at random and both words become noise. It is not fuzzy: an act
  -- versus a standing.
  ('Sorry',               'sorry',             10),
  ('Thank you',           'thank-you',         20),
  ('Appreciation',        'appreciation',      25),
  -- Before and after. `congratulations` covers a win with no listed occasion — exam results, a
  -- match, a first salary; `good-luck` is the cake given BEFORE the thing. Not the same cake.
  -- `proud-of-you` is about the person rather than the achievement: a parent's cake.
  ('Congratulations',     'congratulations',   30),
  ('Good luck',           'good-luck',         40),
  ('Proud of you',        'proud-of-you',      50),
  -- Hard times. `cheer-up` says FEEL BETTER; `with-you` says YOU ARE NOT ALONE and does not try to
  -- fix anything — usually for something that cannot be fixed. Keeping both is deliberate; a cake
  -- shop sells both. (`thinking-of-you` was proposed and dropped: with these two in, it sat limply
  -- between them.)
  ('Get well soon',       'get-well',          60),
  ('Missing you',         'missing-you',       70),
  ('We''re with you',     'with-you',          75),
  ('Cheer up',            'cheer-up',          80),
  -- ⚠️ `breakup` IS ARGUABLY AN OCCASION — an event that happened, like farewell. Filed under
  -- emotion because it is the word people type and it belongs beside cheer-up and missing-you in a
  -- baker's head; under `occasion` it would be buried among birthdays and festivals. It also comes
  -- in two registers — defiant (moving on) and consoling (a friend brings cake) — and one tag puts
  -- both in the same result. If they need separating, the second tag is `moving-on`.
  ('Breakup',             'breakup',           85),
  ('Welcome',             'welcome',           90),
  ('Best wishes',         'best-wishes',      100),
  -- ⚠️ `i-love-you`, NOT `love`: slugs are unique across the whole table and `love` is a master-list
  -- occasion, so a tag of that slug either exists already or is owed to check-occasions' rule that
  -- every master-list occasion has a tag of the same slug.
  ('I love you',          'i-love-you',       110)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- ── 3. The relationship vocabulary ──────────────────────────────────────────────────────────────
-- ⚠️ LABELS ARE WHAT PEOPLE SAY, SLUGS ARE CANONICAL. "Mom" and "Dad", not "Mother" and "Father",
-- because that is what is piped on the cake — and search matches the display name AS WELL AS the
-- slug (matchesTemplateSearch), so "mom" and "mother" both find it. The slug stays formal because a
-- slug is pointed at by whatever already uses it and a rename buys nothing (108's rule).
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'relationship', false, v.sort_order, true
from (values
  ('Mom',       'mother',       10),
  ('Dad',       'father',       20),
  ('Sister',    'sister',       30),
  ('Brother',   'brother',      40),
  ('Grandma',   'grandmother',  50),
  ('Grandpa',   'grandfather',  60),
  ('Wife',      'wife',         70),
  ('Husband',   'husband',      80),
  ('Daughter',  'daughter',     90),
  ('Son',       'son',         100),
  ('Friend',    'friend',      110),
  ('Teacher',   'teacher',     120),
  -- Last, because it is the broad one: "Family Is Everything", "Just Because You're Family".
  ('Family',    'family',      130)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- ── 4. What landed ──────────────────────────────────────────────────────────────────────────────
select category, slug, name, sort_order
from tags
where category in ('emotion', 'relationship')
order by category, sort_order;

-- ── 5. What was SKIPPED, and who already owns the slug ──────────────────────────────────────────
-- ⚠️ RUN THIS AND READ IT. The guards above make a collision silent by design — a skipped row is
-- indistinguishable from a row that inserted, which is right for re-running and wrong for finding
-- out. 65 occasion tags exist and only 17 are seeded in any migration, so roughly 48 were created by
-- hand in admin and are invisible to anyone reading this repo. `welcome` and `congratulations` are
-- the likeliest to already exist.
--
-- Anything this returns did NOT get the category above. Decide per row: leave it where it is, or
-- move it — and moving one re-files every template already tagged with it.
select v.slug                as wanted_slug,
       v.intended_category   as wanted_category,
       t.category            as already_filed_under,
       t.name                as existing_label
from (values
  ('sorry','emotion'), ('thank-you','emotion'), ('appreciation','emotion'),
  ('congratulations','emotion'), ('good-luck','emotion'), ('proud-of-you','emotion'),
  ('get-well','emotion'), ('missing-you','emotion'), ('with-you','emotion'),
  ('cheer-up','emotion'), ('breakup','emotion'), ('welcome','emotion'),
  ('best-wishes','emotion'), ('i-love-you','emotion'),
  ('mother','relationship'), ('father','relationship'), ('sister','relationship'),
  ('brother','relationship'), ('grandmother','relationship'), ('grandfather','relationship'),
  ('wife','relationship'), ('husband','relationship'), ('daughter','relationship'),
  ('son','relationship'), ('friend','relationship'), ('teacher','relationship'),
  ('family','relationship')
) as v(slug, intended_category)
join tags t on t.slug = v.slug and t.category <> v.intended_category
order by v.intended_category, v.slug;
