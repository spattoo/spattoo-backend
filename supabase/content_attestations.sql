-- ── Content rights attestations (IP / copyright) ──────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- WHY THIS EXISTS. Bakers publish themed cakes, and cake themes are overwhelmingly third-party IP
-- (cartoon characters, films, clubs, brands). Spattoo is an intermediary (IT Act s.79): we do not
-- pre-screen, and liability for infringing content rests with the User who published it (ToS
-- 6.4/6.5, B5.4-B5.6). That defence only holds if, when a rights holder sends a notice, we can
-- produce WHO published, WHEN, and WHAT THEY VOUCHED. This table is that record.
--
-- ONE GATE: THE STOREFRONT PUBLISH BUTTON. This is the only moment content becomes visible to the
-- WORLD — until `bakers.storefront_published` is true, GET /api/storefront/:slug 404s, so even
-- gallery photos and the hero image are not public. Everything else (templates, shared designs,
-- quotes, customer photo uploads) is baker<->customer, invite-gated, and already the baker's
-- responsibility under the ToS. So we attest ONCE, at publish, over the storefront as a whole —
-- NOT per template and NOT per photo.
--
-- Why not per item: "Save as Template" is how a baker saves ANY design (it IS their design
-- library — the storefront gallery picker reads from it), so a per-save checkbox would fire
-- constantly. A tick clicked fifty times becomes reflex, and a habituated tick is WEAK evidence.
-- The value of an attestation is that it was considered. One considered affirmation at the moment
-- of publication beats fifty reflexive ones.
--
-- APPEND-ONLY, one row per PUBLISH EVENT. Re-publishing appends another row, so the trail reads
-- "published 3 Aug, re-published 20 Sep" — each with the statement version in force at the time.
-- NEVER updated, never deleted: it is evidence. Unpublishing does not erase who vouched (that is
-- exactly what a notice asks about after the fact). Photos added while ALREADY published go live
-- under the standing attestation; baker_storefront_photos.created_at dates each one.
--
-- REUSES legal_document_versions for the statement wording. The attestation sentence is just a
-- short published text a user agreed to, and that table already freezes text + sha256 + is_current,
-- immutably. So the wording is registered under doc_key 'content-rights' via the existing
-- POST /api/admin/legal/versions, and we FK to it — proving exactly which wording the baker saw.
-- No second lookup table. (It is NOT in CONSENT_REQUIRED_DOC_KEYS and is rejected by
-- POST /api/legal/consent, so it can never land in the DPDP consent trail.)

-- HOT-ish: grows with publish events (bakers x re-publishes), so the FKs are compact surrogates
-- (smallint/uuid ids), never text keys — schema-scale rule, CLAUDE.md.
create table if not exists content_attestations (
  id                  bigserial    primary key,
  subject_type        smallint     not null,           -- 1=baker_appuser (constants/legalDocuments.js)
  subject_id          uuid         not null,           -- auth_user_id of the human who clicked Publish
  baker_id            uuid         not null references bakers (id) on delete cascade,
  target_type         smallint     not null,           -- 1=storefront (the published surface)
  target_id           uuid         not null,           -- storefront => the baker's id
  document_version_id smallint     not null references legal_document_versions (id),
  attested_at         timestamptz  not null default now(),
  ip                  inet,
  user_agent          text
);

-- NO unique constraint on (target_type, target_id): each publish is a distinct EVENT and must
-- append. target_id is deliberately polymorphic (a future public surface — custom domain,
-- marketplace listing — is a new target_type, not a new column), so it carries no FK; a FK cannot
-- point at two tables. Every target keys on uuid, so the column stays compact and typed.

-- Hot access pattern — a notice names a baker: "everything they ever vouched for", newest first.
create index if not exists content_attestations_baker_idx
  on content_attestations (baker_id, attested_at desc);

-- A notice names a surface: "who attested THIS storefront?"
create index if not exists content_attestations_target_idx
  on content_attestations (target_type, target_id, attested_at desc);

-- The table was briefly shaped for per-item (template/photo) attestation before the gate moved to
-- the single storefront-publish chokepoint. Drop that unique index if an earlier run created it.
drop index if exists content_attestations_target_uk;
