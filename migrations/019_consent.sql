-- ── 019: legal document versioning + consent log (DPDP Act 2023 "Layer 2") ──────────
-- Records which subject (baker app-user / customer) accepted which VERSION of which legal
-- document, when — the "demonstrable consent" requirement. Design + rationale:
-- docs/CONSENT_CAPTURE_PLAN.md.

-- legal_document_versions = BOUNDED lookup (a few docs × a few versions, ever). Stores the
-- FROZEN published text + an UNKEYED sha256 over its canonicalized bytes, so a consent record
-- resolves to the exact text the user saw and its integrity is independently verifiable.
-- IMMUTABLE: never UPDATE a published row's content/content_hash — a change is a NEW version
-- row + a flip of is_current. content lives in the row (not just the hash) because a hash
-- proves integrity only if you still hold the text.
create table if not exists legal_document_versions (
  id            smallserial  primary key,
  doc_key       text         not null,                  -- 'tos' | 'privacy' | 'refund' | 'grievance' (matches lib/legal.ts docKey)
  version       text         not null,                  -- e.g. '1.0'
  effective_at  timestamptz  not null,
  content_hash  text         not null,                  -- sha256 of the canonicalized published bytes (unkeyed)
  content       text         not null,                  -- frozen full published text (self-contained evidence)
  is_current    boolean      not null default false,
  published_at  timestamptz  not null default now(),
  unique (doc_key, version)
);
-- At most ONE current version per document (what the checkbox/gate compare against).
create unique index if not exists legal_document_versions_current_uk
  on legal_document_versions (doc_key) where is_current;

-- consent_events = HOT, append-only log (grows with users). One row per document
-- accepted/withdrawn. NEVER updated — a withdrawal is a NEW row (immutable audit trail).
-- References the version by a COMPACT SURROGATE FK (smallint id), never its text key
-- (schema-scale rule). subject_type/action/source are compact smallint enums translated at
-- the API boundary (see src/constants/legalDocuments.js).
create table if not exists consent_events (
  id                   bigserial    primary key,
  subject_type         smallint     not null,           -- 1=baker_appuser, 2=customer
  subject_id           uuid         not null,           -- auth_user_id
  document_version_id  smallint     not null references legal_document_versions (id),
  action               smallint     not null default 1, -- 1=accepted, 2=withdrawn
  source               smallint     not null,           -- 1=signup, 2=first-login-gate, 3=reconsent, 4=quote
  consented_at         timestamptz  not null default now(),
  ip                   inet,
  user_agent           text
);
-- Hot access pattern: "has subject X already accepted version Y?"
create index if not exists consent_events_subject_idx
  on consent_events (subject_type, subject_id, document_version_id);
