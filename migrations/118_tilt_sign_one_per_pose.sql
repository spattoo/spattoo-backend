-- Keep saved cakes looking the way they were left, now that the tilt sign is one per pose.
--
-- ── What moved in the app ──────────────────────────────────────────────────────────────────────
-- The designer's up/down arrows write `tiltAngle`, and the renderer used to NEGATE it for a piece
-- standing on a surface while a verge or inserted piece used it as written. One button therefore
-- meant opposite things on different poses, and on the common one it meant the opposite of its own
-- arrow: UP laid a butterfly flat and DOWN stood it up. Measured on a wired butterfly, UP held to
-- the limit left 64 lit pixels against 682 at centre; afterwards UP is 1364 and DOWN is 165.
--
-- spattoo-core now uses the un-negated sign everywhere — the one verge and insert already had. So a
-- STAND-posed sticker saved before that leans the other way from today, and negating its stored
-- `tiltAngle` restores the exact pose the baker left. The point of this file is that NOTHING changes
-- appearance. Sandeep, told it would re-pose saved designs: "i think there are only 2 or 3 cake
-- templates with butterflies in production. sure flip them."
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
-- ⚠️ ORDERS AND SESSIONS, NOT ONLY TEMPLATES. An order is a record of a cake somebody approved; if
-- its snapshot is left alone it will RENDER differently from what was agreed. Preserving the picture
-- is the whole reason to touch stored data.
--
-- ⚠️ THE TABLE LIST IS CHECKED, NOT ASSUMED. `design_sessions` and `order_design_versions` are not
-- created by any numbered migration in this repo — they predate the ledger — so their columns could
-- not be confirmed from source. Rather than guess and fail the migration in whichever environment
-- disagrees, each pair is skipped unless information_schema says it is there, with a notice saying
-- so. A migration that dies on a table it only assumed exists is worse than one that reports it.
--
-- ⚠️ MUST RUN BEFORE the designer bundle carrying the new sign reaches that environment, or there is
-- a window where old designs render with the new sign.

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
        -- makes that unreachable today (it requires at least one flippable sticker), but "unreachable
        -- by the current WHERE" is a worse guarantee than "cannot happen", for a row holding the only
        -- copy of somebody's cake.
        jsonb_set(x.%2$I, '{stickers}', coalesce((
          select jsonb_agg(
            case
              when jsonb_typeof(s->'tiltAngle') = 'number'
               and (s->>'tiltAngle')::numeric <> 0
               and coalesce(s->>'mode', '') <> 'verge'
               and (s->'insertDepth' is null or jsonb_typeof(s->'insertDepth') = 'null')
              then jsonb_set(s, '{tiltAngle}', to_jsonb(-((s->>'tiltAngle')::numeric)))
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
          where jsonb_typeof(s->'tiltAngle') = 'number'
            and (s->>'tiltAngle')::numeric <> 0
            and coalesce(s->>'mode', '') <> 'verge'
            and (s->'insertDepth' is null or jsonb_typeof(s->'insertDepth') = 'null')
        )
    $f$, spec.tbl, spec.col);

    get diagnostics moved = row_count;
    raise notice 'tilt sign: %.% — % design(s) re-posed', spec.tbl, spec.col, moved;
  end loop;
end $$;
