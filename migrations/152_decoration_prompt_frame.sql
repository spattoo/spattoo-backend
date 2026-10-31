-- ── 152: what we ALWAYS say, whatever the baker typed ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Sandeep, after a "fondant flute" came back as a turned wooden baluster: *"its not only about the
-- questions- there could be few things that we always have to append in the prompt to narrow it.
-- likes its for a cake decoration, bakeability etc. and we dont rely on bakers answers alone. those
-- questions may not be sufficient."*
--
-- Right. Two questions cannot carry what we know and the baker should never have to type: that this
-- is a sugarcraft object someone has to MAKE, that it must stand on a cake, that thin fragile parts
-- break in fondant AND blow the triangle budget. That is domain knowledge, and it belongs in every
-- prompt regardless of what was answered.
--
-- ── WHY IT IS A TABLE AND NOT A CONSTANT ────────────────────────────────────────────────────────
-- It was a constant — `PROMPT_FRAME` in admin — and the argument for keeping it in code was that
-- every clause had been MEASURED rather than chosen. That is true of three of them and not of the
-- rest: "hand-modelled sugarcraft" is a judgement about how a decoration should read, and
-- judgements get revised the moment a real generation comes back wrong. Rule 3 applies to it for
-- the same reason it applies to the questions.
--
-- `note` is not decoration. Three of these clauses cost real money to discover, and an admin about
-- to delete one should see why it is there before they do.
--
-- ⚠️ AND IT CLOSES A CONTRADICTION SHIPPED THE SAME DAY. The constant appended "untextured, no fur
-- or hair, separate parts" to EVERY prompt — including the ready-to-use path, which asks Tripo for
-- `texture: true, pbr: true`. We were paying for a textured model and telling it not to texture.
-- `applies_to` is what makes that impossible to express.

create table if not exists decoration_prompt_frame (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,
  phrase     text not null,
  -- 'always' goes in every prompt. The other two are the two paths a generation can take, and a
  -- clause that belongs to one is WRONG in the other rather than merely unnecessary.
  applies_to text not null default 'always'
             check (applies_to in ('always', 'recolourable', 'ready')),
  -- 'lead' sits before the subject and says what KIND of object this is; 'tail' qualifies it after.
  -- Order matters to a generator: the first words set the category it searches in.
  position   text not null default 'tail' check (position in ('lead', 'tail')),
  note       text,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table decoration_prompt_frame is
  'Clauses appended to EVERY generation prompt regardless of what the baker answered. applies_to '
  'splits the two paths: a recolourable element must not be textured, a ready-to-use one must.';

grant all on decoration_prompt_frame to service_role;
revoke all on decoration_prompt_frame from anon, authenticated;

insert into decoration_prompt_frame (key, phrase, applies_to, position, sort_order, note) values
  -- ⚠️ THE LEAD IS THE ONE THAT WOULD HAVE HELPED THE FLUTE. "flute" alone let the generator pick
  -- a turned baluster; naming the CATEGORY first narrows what it is searching for. It does not fix
  -- the ambiguity — only the baker knows which flute — but it stops the answer being furniture.
  ('kind', 'a hand-modelled sugarcraft cake decoration', 'always', 'lead', 10,
   'Says what KIND of object this is before the subject. A "fondant flute" came back as a turned wooden baluster; the generator had nothing telling it this was a cake decoration at all.'),

  ('scale', 'sized to sit on top of a cake', 'always', 'tail', 20,
   'MEASURED: without it vendors return something proportioned like a statue, and the model arrives at the wrong scale for the designer.'),

  -- Bakeability and the triangle budget ask for the same thing, which is why one clause serves both.
  ('bakeable', 'simplified rounded forms with soft edges, no thin fragile parts', 'always', 'tail', 30,
   'Two reasons at once: a baker has to MAKE this and thin sugar parts snap, and fine detail is what blows the triangle cap. MEASURED: the run that kept its parts AND came in under 25,000 triangles carried "simple rounded shapes".'),

  ('standable', 'a single solid closed shape with a flat base', 'always', 'tail', 40,
   'MEASURED: without a flat base the model floats, and a decoration that cannot sit on a cake is not a decoration. "Closed" because interior holes do not survive either fondant or our relief path.'),

  -- ── Recolourable only ─────────────────────────────────────────────────────────────────────────
  ('no_texture', 'untextured, plain matte surface', 'recolourable', 'tail', 50,
   'A Spattoo element only recolours when its meshes carry NO map — CakeCanvas does `if (!mat.map) mat.color = …`. ⚠️ Belongs to this path ONLY: the ready-to-use path asks the vendor for texture and pbr, so saying this there is paying for a model and telling it not to make one.'),

  ('no_fur', 'no fur, hair or feathers', 'recolourable', 'tail', 60,
   'MEASURED: fur cannot exist without a texture, so asked for on an untextured model it becomes GEOMETRY — one run returned 501,326 triangles against a 25,000 cap. Not on the ready path, where a peacock feather legitimately wants feathers.'),

  ('parts', 'separate parts for each coloured area', 'recolourable', 'tail', 70,
   'The whole reason to generate rather than buy: a part is what a baker can recolour on its own.')
on conflict (key) do update
  set phrase = excluded.phrase, applies_to = excluded.applies_to, position = excluded.position,
      note = excluded.note, sort_order = excluded.sort_order, updated_at = now();
