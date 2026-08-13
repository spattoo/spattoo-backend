-- ── Uploaded decorations must be resizable ───────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent jsonb merge).
--
-- WHY. The popup's Size dial is gated on the placed element's `allowed_actions.resize`
-- (CakeDesigner.jsx → buildToolbar `if (c.resize …)`). The uploadable decoration types — `image_topper`
-- and `top_side_decors` — shipped with `default_allowed_actions.resize = false`, and `POST
-- /uploads/:id/promote` COPIES that object onto every decoration it creates. So a promoted decoration
-- placed on a cake had no Size control at all, and a customer could not scale it. A decoration a customer
-- drops on a cake must be resizable; `resize = true` surfaces the existing 0.5–8 dial (no new UI).
--
-- Two writes: the TYPES (so every FUTURE promotion is resizable) and the already-promoted decorations
-- (so existing ones pick it up without a re-promote). Merge-only, so no other capability is touched.

update element_types
set default_allowed_actions = coalesce(default_allowed_actions, '{}'::jsonb) || '{"resize": true}'::jsonb
where slug in ('image_topper', 'top_side_decors');

-- Every promoted decoration links back to its upload (source_upload_id); global elements do not.
update cake_elements
set allowed_actions = coalesce(allowed_actions, '{}'::jsonb) || '{"resize": true}'::jsonb
where source_upload_id is not null;
