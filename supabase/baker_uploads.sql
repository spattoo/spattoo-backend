-- ── Uploads: everything a baker or a customer puts INTO a tenant ─────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Design + the argument behind it: spattoo-docs/plans/baker-uploads.md
--
-- WHY THIS TABLE EXISTS AT ALL. Uploads used to be rows in `cake_elements`, scoped by a single
-- `customer_id` column that meant TWO things at once: "who may see this" AND "whose data is this".
-- Those coincide only when the uploader IS the owner. A baker uploading a photo his customer sent him
-- over WhatsApp got `customer_id = NULL` — the value that means "shared with the whole tenant" — so the
-- child's photo appeared in the decoration picker of EVERY OTHER CUSTOMER of that bakery.
-- The scoping code was correct; the MODEL was wrong. Hence three separate columns below.
--
-- EVERYTHING UPLOADED IS AN IMAGE. There is no photo/decoration distinction here, and no `kind` column:
-- a "photo" and a "decoration" differ by WHERE THEY SIT (private upload vs published library element),
-- which is a location, not a type. Nothing branches on it.
--
-- AN UPLOAD IS PRIVATE. There is no visibility column, because there are only three ways anyone else
-- ever sees it, and each is an explicit act with its own record:
--   1. a share row (baker_upload_shares) — a named counterparty, e.g. the baker, when a design goes
--      out for quotation;
--   2. PROMOTION — the baker releases the image into their library (a cake_elements row), where their
--      customers can use it. "All my customers" is therefore never an enumeration of share rows, so a
--      customer who signs up tomorrow needs no backfill.
-- An upload does NOT need promoting to be USED: its owner places it on their own cake (a photo-cake
-- frame, or as a decoration) straight from My Assets. Promotion is only about RELEASING it to others.

create table if not exists baker_uploads (
  id               bigserial   primary key,

  -- TENANCY — whose bakery's world this lives in. NOT authorship. (Same convention as baker_appusers:
  -- the prefix means "belongs to this tenant", not "the baker made it".)
  baker_id         uuid        not null references bakers (id) on delete cascade,

  -- AUTHORSHIP — who actually clicked upload. 1=baker_appuser, 2=customer (constants/uploads.js).
  -- Compact surrogate, not a text key: this table grows with every design (schema-scale rule, CLAUDE.md).
  uploaded_by_type smallint    not null,
  uploaded_by_id   uuid        not null,

  -- WHOSE UPLOAD IT IS — the customer whose design/order context it arrived in, or who uploaded it.
  -- NULL for the baker's own material (their logo, a motif they drew).
  --
  -- THIS IS NOT "WHO IS IN THE PICTURE", and there is deliberately no column for that. We cannot know:
  -- a customer may order a cake for a friend, and the face may belong to someone who is not a user and
  -- never will be. A column claiming to identify the depicted person would be FALSE DATA in the very
  -- table we would point at during a DPDP request — worse than no column. What we can know, and all we
  -- need, is whose upload it is: that is what erasure deletes and what attribution answers.
  for_customer_id  uuid        references customers (id) on delete cascade,

  storage_key      text        not null,

  -- CUTOUT — the background-removed version of storage_key, derived lazily the FIRST time the image is
  -- used as a DECORATION (promoted, or placed directly as a free-standing decoration) and cached here so
  -- it is cut at most once, ever. NULL until then.
  --
  -- KEPT SEPARATE FROM storage_key, NOT overwriting it, because an upload is DUAL-PURPOSE: the same image
  -- may be a photo-cake FRAME photo (the original, which must NEVER be cut — nobody wants their daughter
  -- cut out of her own birthday picture) AND a decoration (the cutout). Destroying the original on cut
  -- would break the photo path. So storage_key is forever the original as uploaded, cutout_key the derived
  -- decoration version. (Replaces the old destructive in-place remove-bg. CLAUDE.md: schema is forever.)
  cutout_key       text,

  name             text,
  created_at       timestamptz not null default now(),

  -- Soft delete: an upload can be removed for MODERATION (the baker must be able to drop an image they
  -- must not host) or for ERASURE. Both want a trail, and a hard delete leaves none.
  deleted_at       timestamptz
);

-- HOT PATH — "My Assets" for one tenant, newest first. Partial: deleted rows are never listed.
create index if not exists baker_uploads_tenant_idx
  on baker_uploads (baker_id, created_at desc) where deleted_at is null;

-- DPDP ERASURE — "everything belonging to this customer". The access pattern that must never be a scan.
create index if not exists baker_uploads_customer_idx
  on baker_uploads (for_customer_id) where for_customer_id is not null;

-- ── Shares — named counterparties only ───────────────────────────────────────────────────────────
-- A customer's image becomes visible to the BAKER when the design goes out for quotation. That is a
-- grant, and a grant is an EVENT: "who could see this image, and since when" must be a query, not an
-- ambient permission inferred from table membership.
--
-- "Shared with ALL of a baker's customers" is NEVER expressed here — that is promotion (see above).
-- Enumerating today's customers would silently exclude everyone who signs up tomorrow, and would grow
-- O(uploads x customers).
-- The target is POLYMORPHIC because the share we actually build is customer -> BAKER (she sends her
-- design for a quote; he must now see the photo in it). A `customer_id` column alone could not express
-- that — the one case the table exists for. Same shape as content_attestations.target_*: a typed id,
-- no FK (a FK cannot point at two tables), every target keyed by uuid so the column stays compact.
create table if not exists baker_upload_shares (
  upload_id        bigint      not null references baker_uploads (id) on delete cascade,
  shared_with_type smallint    not null,   -- 1=baker_appuser, 2=customer (constants/uploads.js)
  shared_with_id   uuid        not null,
  shared_at        timestamptz not null default now(),
  primary key (upload_id, shared_with_type, shared_with_id)
);

-- "What can this principal see?" — the read side of every picker/My-Assets query.
create index if not exists baker_upload_shares_grantee_idx
  on baker_upload_shares (shared_with_type, shared_with_id);

-- ── Promotion — an upload released into the baker's LIBRARY ──────────────────────────────────────
-- Promotion COPIES; it never moves. The upload row stays the source of truth, and the element points
-- back at it. Three things fall out of that, all of which a MOVE would have broken:
--
--   1. UNLINK is `cake_elements.is_active = false` — the image leaves every customer's picker at once,
--      the upload stays in My Assets, and CAKES ALREADY DESIGNED WITH IT KEEP RENDERING (a design holds
--      the image URL, not a foreign key). A move would have made "remove from my decorations" break
--      existing designs and orders.
--   2. ERASURE walks the link: deleting a customer's upload deactivates the promoted copies too.
--      Otherwise a deletion would not delete — the copy would live on in every picker.
--   3. PROVENANCE survives exactly when it matters most: the moment the image is visible to MORE people.
--
-- promoted_by/at are EVIDENCE, NOT A GATE. Promotion is not reviewed and not consent-gated: Spattoo is
-- an intermediary (ToS 6.5) and the baker has already accepted responsibility for what they publish
-- (ToS B5.4-B5.6). A tick clicked on every promotion would be the habituated tick that is worthless as
-- evidence. We record who did it; we do not ask them to promise anything.
-- Existing installs: the lazily-derived, cached background-removed version (see cutout_key above).
alter table baker_uploads add column if not exists cutout_key text;

alter table cake_elements add column if not exists source_upload_id bigint references baker_uploads (id);
alter table cake_elements add column if not exists promoted_by      uuid;
alter table cake_elements add column if not exists promoted_at      timestamptz;

-- Erasure needs "which library elements came from this upload?" — the reverse of the link.
create index if not exists cake_elements_source_upload_idx
  on cake_elements (source_upload_id) where source_upload_id is not null;

-- ── Placing an UN-PROMOTED upload on a cake ──────────────────────────────────────────────────────
-- An upload does not need promoting to be used: its owner places it on their own cake. But a
-- free-standing decoration (not one dropped into a photo-cake frame, where the FRAME owns placement)
-- still needs to know which zones it may go on and how it sits.
--
-- That comes from the element TYPE, exactly as it did before — the upload itself carries no placement
-- (behaviour is authored at promotion). So one uploadable type is marked as the default an upload
-- behaves as when placed directly. DATA, not a hardcoded slug in the designer: admin decides, and the
-- designer reads `placement_rules` off whichever type carries the flag.
alter table element_types add column if not exists default_for_uploads boolean not null default false;

-- At most one default. A second one would make "which type does an upload behave as?" ambiguous, and
-- the designer would silently pick whichever sorted first.
create unique index if not exists element_types_one_upload_default
  on element_types ((default_for_uploads)) where default_for_uploads;

-- ── What a baker may promote — a LICENCE boundary, not a privacy gate ────────────────────────────
-- ONLY the baker's OWN uploads (uploaded_by_type = 1) may be promoted. NOT a customer's.
--
-- This is not paternalism, and it is not us second-guessing the baker: it is that the licence does not
-- exist. ToS 6.2 — a customer, by uploading, grants Spattoo and the Baker a licence to use that Content
-- "solely to operate, provide, secure, and improve the Platform and to carry out THE ACTIONS YOU DIRECT
-- ... granted only so that we can carry out your instructions." A customer uploads a photo to order a
-- cake. Promoting it into the baker's library — where every OTHER customer can put it on their cake —
-- is not an action that customer directed. We never got that right, so we cannot hand it to the baker.
-- (A baker who genuinely wants a customer's logo asks for the file and uploads it himself: one
-- deliberate act, and ToS B5.4 covers it.)
--
-- Enforced in the route (routes/uploads.js → promote), where the ToS clause can be cited. A CHECK
-- constraint cannot see across to baker_uploads.uploaded_by_type on a cake_elements insert.
