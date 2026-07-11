-- Text styles: the DB-authored look of an editable text PLACEHOLDER on a template element
-- (the "scribble brown 2" on a plaque, a gold script name on a banner …).
--
-- Same shape and same data↔code seam as cake_textures: `algorithm` is a KEY into the renderer's
-- strategies (spattoo-admin/src/lib/textSlots.js → ALGORITHMS, ported to the designer) — a brand-new
-- look still needs a strategy in code, but tuning any existing one (colours, hatch, outline, font) is
-- pure config here, with no deploy.
--
-- WHY A TABLE AND NOT A STYLE-PER-TEMPLATE BLOB: a style is reused across many templates. Naming it
-- once means a new template is just artwork + slot rects + a style pick, and restyling one preset
-- updates every template that references it. A template's slot references a style by its stable `key`
-- and may carry a small `style_override` for one-off tweaks.
--
--   config: {
--     font:    { family, url, weight },   -- the face is DATA (an uploaded woff2), never hardcoded
--     fill:    '#5A3410',
--     hatch:   { color, angle, gap, width },   -- gap/width are fractions of glyph height
--     outline: { color, width, wobble },       -- width is a fraction of glyph height
--     tracking, fit
--   }
--
-- BOUNDED LOOKUP TABLE (a handful of curated styles), so a readable text `key` is the right identifier
-- here; it is what the high-volume side (cake_elements.placement_config.text_slots[].style_key) stores.

create table text_styles (
  id         uuid        primary key default gen_random_uuid(),
  key        text        not null unique,            -- stable reference, e.g. 'scribble_brown'
  label      text        not null,                   -- picker label, e.g. 'Scribble Brown'
  algorithm  text        not null default 'scribble',-- code strategy key: 'scribble' | 'flat'
  config     jsonb       not null default '{}'::jsonb,
  is_active  boolean     not null default true,
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index text_styles_active_idx on text_styles(is_active, sort_order);

alter table text_styles enable row level security;
create policy "text_styles_read"  on text_styles for select to authenticated using (true);
create policy "text_styles_write" on text_styles for all    to authenticated using (true) with check (true);
