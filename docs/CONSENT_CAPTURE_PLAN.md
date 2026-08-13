# Consent Capture Plan — Baker agreement to Terms & Privacy (DPDP "Layer 2")

**Status:** planned (not built). Written 2026-07-05.
**Spans:** `spattoo-api` (schema + routes + version registry — the canonical record),
`spattoo-web/apps/app` (checkbox + first-login gate), `spattoo-web/apps/marketing`
(the single public `/terms` `/privacy` pages), `spattoo-admin` (no checkbox — see §6).

This is **Layer 2** of the legal system. Layer 1 (published, versioned legal docs) already
ships as public pages in `spattoo-web/apps/marketing` (`content/legal/*.md`, `lib/legal.ts`,
routes `/terms /privacy /refund /grievance`). Layer 2 records **which baker accepted which
version of which document, when** — the DPDP Act, 2023 "demonstrable consent" requirement.

---

## 1. Goal & legal basis

Make bakers agree to the **Terms of Service** and **Privacy Policy**, and keep a
reproducible, timestamped record of that agreement.

- **ToS = a contract** the baker is bound by. **Privacy Policy = a notice** + consent; most
  processing of *baker* data rides on **contractual necessity / legitimate use**, not
  standalone consent.
- **One checkbox, two records.** The UI shows a single **unticked** checkbox — "I agree to
  the **Terms of Service** and **Privacy Policy**" — because both are necessary and
  non-optional (bundling *necessary* docs is fine; only bundling *optional* consent is not).
  Under the hood we write **two** consent events (`tos` + `privacy`) so the audit trail is
  per-document and re-consent can trigger for just the doc that changed.
- **Unticked / affirmative** — DPDP requires a clear affirmative action; never pre-tick.
- **Optional consent stays separate** — any future marketing/non-essential consent gets its
  own separate, unticked opt-in, never folded into this checkbox.

---

## 2. Where the documents live (architecture decision)

Legal docs are shared content consumed by **three** surfaces (public marketing site, baker
app consent, storefront customers later). They are **not** owned by any one app, and they do
**not** belong in `spattoo-core`: core is the `@spattoo/designer` Vite library that is
re-vendored at versioned releases, so a ToS typo would force a designer re-vendor and would
make the marketing site depend on the designer lib — wrong coupling.

The app-neutral home that must exist for consent anyway is the **API/DB**. So:

| Concern | Home |
|---|---|
| **Canonical record of published versions** (frozen text + hash) — what consent points at | **API / Supabase** (`legal_document_versions`) |
| **The one public URL** (`spattoo.com/terms`, `/privacy`) — SEO, footer, shareable | **marketing** (`apps/marketing`, already built) |
| **Authoring / drafting** the doc text | git markdown (`apps/marketing/content/legal/*.md` for now; may move next to the API publisher later) |
| **Baker consent UI** (checkbox + gate) | `spattoo-web/apps/app` shell — **links to the marketing URLs + calls the API**; NO local doc copy |

Net: **API owns the versions, marketing serves the one public page, the app links + records.**
Nothing is duplicated into core or the app.

---

## 3. Version storage — guidelines

**Author in git, freeze in the DB.** Git is a great *editing* store but a poor *evidence*
store (rebases/squashes/force-push/repo moves). So on **publish**, snapshot the exact version
into the API-owned table.

1. **Freeze the text, not just a pointer** — store the full published `content` in the
   version row. A hash proves integrity only if you still hold the text. Table is a bounded
   lookup (a few docs × a few versions ever), so fat rows are free.
2. **`content_hash` = sha256 of the exact published (token-substituted) bytes** — the text a
   baker actually saw. Tamper-evidence **and** change-detector (same hash ⇒ not a new
   version).
   - **Unkeyed** SHA-256 — **no HMAC key, no salt, no pepper.** The hash must be
     **independently reproducible**: an auditor/court can re-hash the frozen `content` and
     confirm it matches. An HMAC would require our secret to verify (destroys independent
     verifiability) and buys no non-repudiation against ourselves since we own the store.
     No salt because the document isn't a secret and we *want* identical text ⇒ identical
     hash (that's what powers dedup/change-detection).
   - **Canonicalize before hashing** — this, not a key, is what matters: hash a fixed byte
     form (UTF-8, LF line endings, final substituted text, consistent trailing-whitespace).
     A small `canonicalize()` applied identically at publish and at re-verification so the
     recorded hash always reproduces.
   - **Notarization-grade proof is optional & later** — if we ever want tamper-proofing that
     survives "we could have edited our own DB," the tools are a **digital signature**
     (asymmetric) and/or an **RFC-3161 trusted timestamp** — *not* HMAC. Pure add-on
     (`signature` / `timestamp_token` column), no schema rework. For now: unkeyed sha256 +
     immutable append-only rows + reliable timestamps is the accepted bar.
3. **Immutable versions** — a published row is never mutated. Any change to in-force text ⇒
   new `version` = new row, flip `is_current`, add a Document History line to the `.md`. Old
   versions retained forever.
4. **One `is_current` per `doc_key`** — what the checkbox/gate compare against.
5. **Consent points at the version row** by surrogate FK ⇒ every acceptance resolves to
   exact reproducible text + effective date.

**Publishing = a deliberate registration step** (not silent). The API owns
`legal_document_versions`; a script/route reads the published markdown, computes the hash,
and **upserts a new version row iff the hash is new**, flipping `is_current`. Marketing
renders the current published version; the app links to it. `lib/legal.ts` stays the human
registry (`docKey`+`version`+`effectiveDate`) — the frozen text + hash get registered into
the DB at publish.

---

## 4. Data model (Supabase, API-owned)

New migration `019_consent.sql` (highest existing is `018`). Two tables — bounded lookup +
hot append-only, surrogate FKs (schema-scale rules, CLAUDE.md).

### `legal_document_versions` — bounded lookup, the record of *what was agreed to*
```
id             smallserial PRIMARY KEY
doc_key        text        NOT NULL     -- 'tos' | 'privacy' | 'refund' | 'grievance' (matches lib/legal.ts docKey)
version        text        NOT NULL     -- '1.0'
effective_at   timestamptz NOT NULL
content_hash   text        NOT NULL     -- sha256 of exact published (token-substituted) bytes
content        text        NOT NULL     -- FROZEN full published text — self-contained evidence
is_current     boolean     NOT NULL DEFAULT false
published_at   timestamptz NOT NULL DEFAULT now()
UNIQUE (doc_key, version);
CREATE UNIQUE INDEX ON legal_document_versions (doc_key) WHERE is_current;   -- ≤1 current per doc
```
Append-only / immutable — never UPDATE a published row's `content`/`content_hash`.

### `consent_events` — hot, append-only, grows with users
```
id                   bigserial   PRIMARY KEY
subject_type         smallint    NOT NULL     -- 1=baker_appuser, 2=customer (compact enum, not text)
subject_id           uuid        NOT NULL     -- auth_user_id (see §9)
document_version_id  smallint    NOT NULL REFERENCES legal_document_versions(id)
action               smallint    NOT NULL     -- 1=accepted, 2=withdrawn
source               smallint    NOT NULL     -- 1=signup, 2=first-login-gate, 3=reconsent, 4=quote (future)
consented_at         timestamptz NOT NULL DEFAULT now()
ip                   inet
user_agent           text
CREATE INDEX ON consent_events (subject_type, subject_id, document_version_id);  -- hot: "has X accepted current Y?"
```
Never updated — withdrawal is a **new row** (immutable log, like the GST register).
`subject_type`/`action`/`source` are compact smallint enums translated at the API boundary.
Serves **end-customers later** too (`subject_type=2`, `source=4`) — same tables, no rework.

---

## 5. Capture points

1. **Self-signup checkbox** — `spattoo-web/apps/app/app/BakerApp.tsx`, Stage A `BakerSignup`
   "Create account" form (`:720`). Unticked checkbox wired into `canSubmit` (`:574`); the
   labels link to `spattoo.com/terms` + `/privacy`. Acceptance rides in `signUp` metadata
   (like `role`/`first_name` at `:610`) and is recorded server-side when the baker is created
   (`bakerProvisioning.js:createBakerForUser`, the ONE shared path).
2. **First-login gate** — a full-screen gate in the `BakerApp` ladder, after `if (!baker)`
   and before `<CakeDesigner>` (`BakerApp.tsx:131-149`), **mirroring the existing
   `must_set_password` gate**. Blocks the app until the baker accepts the **current** version.
   This is what captures consent for **admin-onboarded bakers** (§6) and is the **re-consent**
   mechanism on version bumps. Self-signup bakers who already accepted the current version pass
   through silently.
3. **Re-consent on version bump** — when a doc's `is_current` moves to a new version, the gate
   re-prompts for **just that doc** ("our Privacy Policy was updated") and logs a fresh event;
   the unchanged doc is not re-collected. (Enabled by the two-records design.)
4. **Customer (future)** — same tables, `source=quote`, at storefront quote submission.

---

## 6. Admin onboarding — no checkbox

`spattoo-admin/OnboardBaker.jsx` creates the account **on the baker's behalf** (admin
supplies details, hands over a temp password — baker not present). An admin ticking "I agree"
is **not valid consent**. So **no checkbox in the admin form.** Admin-onboarded bakers are
captured by the **first-login gate** (§5.2) the first time they log in. Both creation flows
funnel through `createBakerForUser`, but only self-signup carries the baker's own affirmative
action into it; the admin flow relies on the gate.

---

## 7. API surface

- **Registration (publish):** `POST /api/admin/legal/versions` (or a seed script, capability-
  gated) — upsert a `legal_document_versions` row {doc_key, version, effective_at,
  content_hash, content}; flips `is_current`.
- **Current versions:** `GET /api/legal/current` → `[{docKey, version, id, effective_at}]`
  for the gate/checkbox. (App reads this instead of importing marketing's `lib/legal.ts`.)
- **Published text (optional, for in-app modal):** `GET /api/legal/:docKey` → current
  `{version, content}` so the app can render terms without leaving the app.
- **Record consent:** `POST /api/legal/consent` (authed) — body `{docKeys:['tos','privacy'],
  source}`; server resolves current version ids, writes one `consent_events` row per doc with
  `ip`/`user_agent`. Idempotent per (subject, version).
- **Profile flag:** extend `GET /api/baker/profile` (`bakers.js:277`) with
  `pending_consents: ['privacy']` (docs whose current version this user hasn't accepted) so
  `BakerApp` knows whether to show the gate without an extra round-trip.

---

## 8. Web

- **Checkbox:** `BakerSignup` — add `agreed` state (unticked); `canSubmit = … && agreed`;
  render below the fields with links to `spattoo.com/terms` + `/privacy` (cross-subdomain
  links, open in new tab). Pass acceptance through `signUp` metadata.
- **Gate:** an `AcceptTerms` full-screen component in the `BakerApp` ladder, shown when
  `profile.pending_consents.length > 0`; single Agree button → `POST /api/legal/consent` →
  refetch profile → proceed. Mirrors `SetStaffPassword`.
- **No doc copy in the app/core** — links + API only.

---

## 9. Sequencing & open decisions

**Sequence:**
1. Migration `019_consent.sql` + registration route/script + seed current v1.0 rows.
2. `GET /api/legal/current`, `POST /api/legal/consent`, profile `pending_consents`.
3. Web: first-login gate (covers everyone incl. admin-onboarded) — highest coverage first.
4. Web: self-signup checkbox (affirmative-action capture at the signup moment).
5. (Later) customer consent at quote submission.

**Open decisions:**
- **Publish gating:** docs are still `LEGAL_STATUS='draft'`. Don't collect *binding* consent
  against draft terms — sequence Layer 2 go-live **after** legal review +
  `LEGAL_STATUS='published'` + filled company blanks. Build the plumbing now, flip on at
  publish.
- **`subject_id` type:** use `auth_user_id` (uuid) — stable, present before the appuser row
  in some flows.
- **Existing bakers backfill:** on first login after launch the gate collects consent for all
  pre-existing bakers (no retroactive assumption of consent).
