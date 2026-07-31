-- ── 029: decoration steps live inside xray_spec ─────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- NO NEW COLUMN. xray_spec already holds everything X-Ray reads for a photo order; the steps for
-- making each decoration are simply a second key in it:
--
--   { "design": {…design_snapshot-shaped…}, "decorations": { "<key>": { steps, model, … } } }
--
-- Rows written before this are a BARE design_snapshot with no wrapper. resolveXraySpec (core)
-- accepts both shapes, so nothing needs backfilling and an un-upgraded reader still works.
--
-- ── WHY A FUNCTION RATHER THAN AN UPDATE FROM JS ────────────────────────────────────
-- Steps are generated one decoration at a time and each takes ~10s at the provider. A baker who
-- clicks two decorations in a row has two writes in flight against the same column, and a
-- read-modify-write in JS would silently drop whichever finished first — the baker pays a credit
-- and gets nothing. Merging inside the statement makes that impossible.
--
-- Also promotes a bare row to the wrapper shape on first write, so callers never have to.
create or replace function xray_add_decoration_steps(
  p_order_id uuid,
  p_key      text,
  p_value    jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_spec jsonb;
  v_next jsonb;
begin
  select xray_spec into v_spec from orders where id = p_order_id for update;
  if v_spec is null then return null; end if;

  -- Bare (pre-029) rows ARE the design. Wrap before adding, so the shape converges on write
  -- rather than depending on a backfill nobody runs.
  if v_spec ? 'design' then
    v_next := v_spec;
  else
    v_next := jsonb_build_object('design', v_spec);
  end if;

  v_next := v_next || jsonb_build_object(
    'decorations',
    coalesce(v_next -> 'decorations', '{}'::jsonb) || jsonb_build_object(p_key, p_value)
  );

  update orders set xray_spec = v_next where id = p_order_id;
  return v_next -> 'decorations';
end;
$$;

comment on function xray_add_decoration_steps is
  'Atomically add one decoration''s steps to orders.xray_spec. Merges inside the statement (row-locked) because two decorations generated at once would otherwise clobber each other and the baker would pay for steps that vanish. Promotes a pre-029 bare design_snapshot to the { design, decorations } wrapper on first write.';
