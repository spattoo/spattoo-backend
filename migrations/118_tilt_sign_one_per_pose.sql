-- Keep saved cakes looking the way they were left, now that the tilt sign is one per pose and the
-- FLAT pose has a lean at all.
--
-- ── What moved in the app ──────────────────────────────────────────────────────────────────────
-- Two changes, both in the renderer, both of which give a stored `tiltAngle` a different meaning
-- than it had when it was written.
--
-- 1. THE SIGN. The designer's up/down arrows write `tiltAngle`, and the renderer used to NEGATE it
--    for a piece standing on a surface while a verge or inserted piece used it as written. One
--    button therefore meant opposite things on different poses, and on the common one it meant the
--    opposite of its own arrow: UP laid a butterfly flat and DOWN stood it up. spattoo-core now uses
--    the un-negated sign everywhere — the one verge and insert already had — so a STAND-posed
--    sticker saved before that leans the other way from today, and negating its stored `tiltAngle`
--    restores the exact pose the baker left.
--
-- 2. THE FLAT POSE NEVER LEANED AT ALL. A sticker whose pose is `hug` (or anything that is not
--    stand / perch / verge / insert) renders through CakeCanvas's Flat return, which applied Spin
--    and nothing else — `tiltAngle` and `rollAngle` were written, stored, shown in the readout,
--    saved into the template, and then dropped by the renderer. The catalogue Butterfly is exactly
--    that element (`{"top_surface": "hug", "side": "stand"}` with `tilt: true`), which is why the
--    arrows worked on the side of the cake and did nothing on the top. Flat now leans, pivoted on
--    the edge the piece tips away from.
--
--    So the flat values already in the database were typed into a DEAD control. Four of them are
--    ±69° — what you get holding an arrow to its limit because nothing is happening. They describe
--    no pose anybody chose, and left alone they would suddenly stand those butterflies on end. They
--    are ZEROED, which is the only value that keeps the cake looking the way it was left.
--
-- Sandeep, told this would re-pose saved designs: "i think there are only 2 or 3 cake templates with
-- butterflies in production. sure flip them." The point of this file is that NOTHING changes
-- appearance.
--
-- ⚠️ THE POSE IS IN `placementMode`, AND THE FIRST VERSION OF THIS FILE READ `mode`. That field does
-- not exist on a sticker — 0 of 1072 stickers in the dev database have it, 1072 have `placementMode`
-- — so the verge guard matched NOTHING and the migration would have negated every verge butterfly,
-- which is the exact thing its own warning said must never happen. It was caught by printing the
-- rows the WHERE would select instead of trusting it. Read the data before running the update.
--
-- ⚠️ VERGE AND INSERT MUST NOT BE TOUCHED. They were already on the new sign and did not move, so a
-- blanket negation would break the poses that were correct. The test is applied per sticker, from
-- the same two signals the renderer branches on — and `insertDepth: 0` is a REAL value meaning
-- flush, not an absent one, so the check is for the key being absent or JSON null, never falsy.
--
-- ⚠️ NEGATION HAS NO OLD-VALUE SIGNATURE, so the usual trick does not work here. 106 could re-run
-- safely because its WHERE looked for the colour it was replacing; a flipped angle looks exactly
-- like an unflipped one of the other sign, so a second pass would flip it back. Every design this
-- touches is therefore stamped `__tiltSign: 2`, and a stamped design is skipped. That stamp is the
-- only thing standing between a re-run and silent damage.
--
-- ⚠️ NOTHING IN THE APP WRITES THAT STAMP — only this file does. So a design SAVED after the new
-- bundle reaches an environment is already on the new sign and carries no stamp, and this migration
-- cannot tell it from an old one. Run it as close to the deploy as possible, and check `created_at`
-- against the release if there is any doubt.
--
-- ⚠️ ORDERS AND SESSIONS, NOT ONLY TEMPLATES. An order is a record of a cake somebody approved; if
-- its snapshot is left alone it will RENDER differently from what was agreed. Preserving the picture
-- is the whole reason to touch stored data.
--
-- ⚠️ THE TABLE LIST IS CHECKED, NOT ASSUMED. `design_sessions` and `order_design_versions` are not
-- created by any numbered migration in this repo — they predate the ledger — so their columns could
-- not be confirmed from source. Rather than guess and fail the migration in whichever environment
-- disagrees, each pair is skipped unless information_schema says it is there, with a notice saying
-- so. A migration that dies on a table it only assumed exists is worse than one that reports it.

do $$
declare
  spec   record;
  moved  integer;
begin
  for spec in
    select * from (values
      ('cake_templates',        'design'),
      ('orders',                'design_snapshot'),
      ('order_design_versions', 'design_snapshot'),
      ('design_sessions',       'design_snapshot')
    ) as v(tbl, col)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = spec.tbl and column_name = spec.col
    ) then
      raise notice 'tilt sign: %.% is not present here — skipped', spec.tbl, spec.col;
      continue;
    end if;

    execute format($f$
      update %1$I x
      set %2$I = jsonb_set(
        -- ⚠️ coalesce, because jsonb_agg over an EMPTY array returns NULL and jsonb_set with a NULL
        -- value returns NULL — which would blank the entire design rather than fail. The WHERE below
        -- makes that unreachable today (it requires at least one affected sticker), but "unreachable
        -- by the current WHERE" is a worse guarantee than "cannot happen", for a row holding the only
        -- copy of somebody's cake.
        jsonb_set(x.%2$I, '{stickers}', coalesce((
          select jsonb_agg(
            case
              -- Already on the new sign when they were written. Untouched.
              when coalesce(s->>'placementMode', '') = 'verge'
                or (s ? 'insertDepth' and jsonb_typeof(s->'insertDepth') <> 'null')
              then s

              -- Upright poses carried the OLD negated sign; negating restores the pose as left.
              when coalesce(s->>'placementMode', '') in ('stand', 'perch')
               and jsonb_typeof(s->'tiltAngle') = 'number'
               and (s->>'tiltAngle')::numeric <> 0
              then jsonb_set(s, '{tiltAngle}', to_jsonb(-((s->>'tiltAngle')::numeric)))

              -- Every other pose renders FLAT, where neither lean axis was ever drawn. The stored
              -- value describes nothing on screen, so zero is what keeps the picture the same.
              -- create_missing := false, so a sticker that never had the key does not grow one.
              when (jsonb_typeof(s->'tiltAngle') = 'number' and (s->>'tiltAngle')::numeric <> 0)
                or (jsonb_typeof(s->'rollAngle') = 'number' and (s->>'rollAngle')::numeric <> 0)
              then jsonb_set(
                     jsonb_set(s, '{tiltAngle}', to_jsonb(0), false),
                            '{rollAngle}', to_jsonb(0), false)

              else s
            end
            -- ⚠️ ORDER BY, or jsonb_agg may hand the stickers back in a different order than it got
            -- them. A sticker's position in this array is its DRAW ORDER: shuffle it and a piece
            -- that sat in front of another ends up behind it, and nothing errors. Same note as 106.
            order by ord
          )
          from jsonb_array_elements(x.%2$I->'stickers') with ordinality as a(s, ord)
        ), '[]'::jsonb)),
        '{__tiltSign}', to_jsonb(2)
      )
      where x.%2$I is not null
        and jsonb_typeof(x.%2$I->'stickers') = 'array'
        -- the stamp, and the only guard against a second pass undoing the first
        -- ⚠️ A CASE, not `typeof = 'number' and (...)::numeric`. Postgres does not promise to
        -- evaluate AND left to right, so a cast sitting beside its own type guard can still be
        -- reached with a non-numeric stamp and throw. This form has no unguarded cast in it.
        and (case when jsonb_typeof(x.%2$I->'__tiltSign') = 'number'
                  then (x.%2$I->>'__tiltSign')::numeric else 0 end) < 2
        and exists (
          select 1 from jsonb_array_elements(x.%2$I->'stickers') s
          where coalesce(s->>'placementMode', '') <> 'verge'
            and not (s ? 'insertDepth' and jsonb_typeof(s->'insertDepth') <> 'null')
            and ( (jsonb_typeof(s->'tiltAngle') = 'number' and (s->>'tiltAngle')::numeric <> 0)
               or (jsonb_typeof(s->'rollAngle') = 'number' and (s->>'rollAngle')::numeric <> 0) )
        )
    $f$, spec.tbl, spec.col);

    get diagnostics moved = row_count;
    raise notice 'tilt sign: %.% — % design(s) re-posed', spec.tbl, spec.col, moved;
  end loop;
end $$;
