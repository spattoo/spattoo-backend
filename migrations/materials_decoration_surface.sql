-- Decoration surface finishes on the `materials` table (one catalog, gated by applies_to) ─────────────
--
-- A material now declares WHERE it may be used: config.applies_to = ['body'] (cake frosting) | ['element']
-- (placed decoration) | both. A decoration references a material by KEY (placement_config.material:"satin")
-- and the designer applies config.surface — a MeshPhysical finish (roughness/sheen/clearcoat/anisotropy/…).
-- fondant/chocolate can be BOTH (coat a cake OR a fondant bow) — authored ONCE, not duplicated.
--
-- config stays jsonb (no schema change); applies_to + surface live inside it. Idempotent (re-runnable).

-- Existing frostings apply to the cake BODY only (backfill; don't clobber a row that already set it).
update materials
   set config = config || '{"applies_to":["body"]}'::jsonb
 where config->'applies_to' is null;

-- Satin — an element-only decoration finish (anisotropic silk; the GLB must carry a baked TANGENT attribute
-- for the streak). surface keys map 1:1 to MeshPhysicalMaterial. Matches the code seed in
-- spattoo-core/src/designer/materials.js (DECOR_MATERIALS.satin); this row overlays/tunes it.
insert into materials (key, label, config, sort_order) values
  ('satin', 'Satin',
   '{"applies_to":["element"],"surface":{"roughness":0.28,"metalness":0,"anisotropy":1.0,"anisotropyRotation":1.57,"sheen":0.35,"sheenColor":"#ffffff","sheenRoughness":0.28,"clearcoat":0.12,"clearcoatRoughness":0.4,"envMapIntensity":0.45}}'::jsonb,
   10)
  on conflict (key) do update
    set config = materials.config || excluded.config,   -- merge (keep any styles already set), overlay surface/applies_to
        label  = excluded.label,
        updated_at = now();
