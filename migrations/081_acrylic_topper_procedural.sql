-- ── 081: acrylic topper rows carry their routing key ─────────────────────────────────────────────
--
-- ⚠️ An acrylic topper saved before this added NOTHING to the cake, and did it silently.
--
-- The designer routes a click in the decorations menu through PROCEDURAL_TOOLS, keyed on
-- `placement_config.procedural`. The Acrylic Topper Studio never wrote that key. With no key the
-- element falls past the procedural branch and is added as an ordinary sticker — and an acrylic row
-- carries `image_url: null` ON PURPOSE, because the word is cut at render time rather than stored as
-- a picture. So the cake got a selection box with nothing inside it: a decoration you can move,
-- resize and remove, and cannot see.
--
-- Nothing errored anywhere. The row saved, the picker listed it, the click registered, the editor
-- panel opened with Colour, Placement, Size and Remove. Every surface reported success.
--
-- The studio is fixed to write the key. This is for the rows saved before that, because a fix that
-- only helps the NEXT save leaves the authored ones broken with no sign of why.
--
-- ── Why `writing` and not `acrylic` ──────────────────────────────────────────────────────────────
-- The routing key names WHAT IS ADDED, not what it is made of. What goes on the cake is a message;
-- acrylic is the Look, and `placement_config.acrylic` already carries it. Cream writing reaches the
-- same handler for the same reason — one way to add a message, whatever it is cut or piped from.
--
-- ── Identified by the acrylic config, not by name or type ────────────────────────────────────────
-- `placement_config ? 'acrylic'` is the only reliable signal. The name is free text an admin
-- chooses, and the element TYPE is Cake Topper, which the printed and fondant toppers share — both
-- of those legitimately have no `procedural` and must not be touched.
--
-- Idempotent, and it will not overwrite a key somebody set deliberately: only rows where the field
-- is genuinely absent are updated.

-- No `updated_at`: cake_elements does not have one, and that is the schema's normal state rather
-- than a gap — only 17 of 69 tables carry one. This table stamps `created_at` and then only
-- SPECIFIC events, `optimized_at` and `promoted_at`. A first draft set `updated_at = now()` here
-- out of habit and failed on the first run.
UPDATE public.cake_elements
   SET placement_config = jsonb_set(placement_config, '{procedural}', '"writing"'::jsonb, true)
 WHERE placement_config ? 'acrylic'
   AND placement_config->>'procedural' IS NULL;

-- Expect: every acrylic topper authored so far, and nothing else.
SELECT id, name, placement_config->>'procedural' AS procedural
  FROM public.cake_elements
 WHERE placement_config ? 'acrylic'
 ORDER BY created_at;
