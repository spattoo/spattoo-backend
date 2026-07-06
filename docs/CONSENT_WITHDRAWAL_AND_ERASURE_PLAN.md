# Consent Withdrawal & Account Erasure Plan — DPDP "Layer 3"

**Status:** BUILT on dev 2026-07-06 (API + jobs + core UI, all green) — NOT yet live: migration 020
must be applied to Supabase, core must be re-vendored into web, and `RETENTION_WINDOW_DAYS` +
`ERASURE_MANIFEST` need counsel/schema sign-off before the destructive path is enabled. Written
2026-07-06. Feature doc: `spattoo-docs/features/legal-consent.md`.
**Spans:** `spattoo-api` (withdrawal route + erasure job + retention config — the canonical
record), `spattoo-web/apps/app` (a **Privacy & Data** settings screen), `spattoo-accounting`
(untouched by erasure — statutory carve-out, see §5).

This is **Layer 3** of the legal system, building directly on:
- **Layer 1** — published, versioned legal docs (`spattoo-web/apps/marketing`, live).
- **Layer 2** — consent *capture* (acceptance): `legal_document_versions` + append-only
  `consent_events`, `POST /api/legal/consent`, the first-login gate + signup checkbox. See
  `CONSENT_CAPTURE_PLAN.md`. **Built for the accept direction only.**

Layer 3 adds the **rights the Data Principal exercises** under DPDP §6(4) (withdraw consent),
§12 (correction & erasure), and Rule 8 / Third Schedule (retention + 48-hour pre-erasure
notice). It reuses Layer 2's tables and enums verbatim — **no schema rework, no new consent
store**. A withdrawal is already anticipated by the data model (`CONSENT_ACTION.WITHDRAWN = 2`,
append-only log) and the read side already honours it (`legalConsent.js` → "latest event for a
version wins"). Only the **write path, the erasure lifecycle, and the UI** are missing.

---

## 1. Legal basis — why "withdraw" and "delete" are two different levers

DPDP §6(4): the Data Principal may withdraw consent **at any time, with ease comparable to the
ease with which it was given**. §6(6)/§8(7): on withdrawal, the Data Fiduciary (and processors)
must cease processing and erase, unless retention is required by law.

**But withdrawal only bites processing whose legal basis is *consent*.** Per
`CONSENT_CAPTURE_PLAN.md §1`, for a **baker** most processing rides on **contractual necessity /
legitimate use** (ToS = a contract; Privacy Policy = a notice). So the two levers are distinct
and must not be conflated in code or UI:

| Lever | Legal basis it addresses | DPDP § | Effect |
|---|---|---|---|
| **Withdraw consent** | *consent-based* processing (optional/marketing today; **customer** consent later) | §6(4) | Append a `WITHDRAWN` event; stop the consent-based processing |
| **Delete account (erasure)** | *contract-based* processing (the baker relationship) | §12 | Soft-delete → retention hold → scheduled erasure/anonymization |

The **required ToS+Privacy consent is bundled + necessary** — you cannot withdraw it and keep
using the product. So in the UI, "withdraw" of a *necessary* consent **routes into the account
deletion flow** (honest: withdrawing = closing). Only *optional* consents get independent
toggles. **Customer** (storefront) withdrawal is a separate surface (§7) — not baker settings.

---

## 2. Where the UI lives — `apps/app` → **Privacy & Data** settings screen

Mobile-first (bakers are on phones — `feedback_mobile_first`). One screen, three blocks, all
reading/writing the API (no local state, no doc copy — mirrors Layer 2):

1. **Your agreements** — the consent record: which doc + version accepted, when. Reads a new
   `GET /api/legal/consent/history`. A **Download** button (JSON/PDF) satisfies the
   "demonstrable, portable record" expectation. Read-only.
2. **Optional consents** — a list of *optional* consent toggles (marketing, etc.), each an
   independent unticked opt-in (never bundled). Toggling off → `POST /api/legal/withdraw`.
   Empty today (we collect no optional baker consent yet) — the block renders config-driven
   from `GET /api/legal/current` filtered to `required:false`, so it lights up automatically
   when the first optional doc is published. **No per-doc branching** (`feedback_dry_reuse_scan`).
3. **Delete my account** — the erasure entry point (§4). A guarded, typed-confirmation flow
   explaining the retention window and what survives (statutory invoices). Links to the
   **grievance officer** (§13) for anything the self-serve flow doesn't cover.

Reuse the existing settings shell/rows already in `apps/app`; do **not** build a parallel
settings chrome.

---

## 3. Withdrawal — API surface (reuses Layer 2 tables)

### `POST /api/legal/withdraw` (authed, `resolvePrincipal`)
Mirror of `POST /api/legal/consent` (`routes/legal.js`), opposite action. Body:
`{ doc_keys: ['<optional-doc-key>'], reason? }`.

- Resolve subject exactly as `/consent` does (`req.role` → `CONSENT_SUBJECT_TYPE`).
- **Guard: refuse to withdraw a *required* doc** (`CONSENT_REQUIRED_DOC_KEYS`) — return `409
  { error: 'necessary_consent', action: 'delete_account' }` so the client redirects to the
  deletion flow. This is the code-level enforcement of §1.
- For each *optional* key whose latest event is an acceptance, append one row with
  `action: CONSENT_ACTION.WITHDRAWN`, same `ip`/`user_agent`/`source` capture as accept.
- Idempotent: if the latest event is already `WITHDRAWN`, skip (don't stack duplicate rows).

Implement as `withdrawConsent(...)` in `services/legalConsent.js` — the **mirror of
`recordConsent`**, sharing `getCurrentVersions` + `acceptedVersionIds`. The read helpers already
compute "latest wins", so `pendingConsents` and the gate **automatically** re-trigger after a
withdrawal with zero changes. No second copy of the latest-event logic.

### `GET /api/legal/consent/history` (authed)
Returns the subject's own events (accept + withdraw), newest first, joined to
`legal_document_versions` for `{ docKey, version, action, at, source }`. Powers block 1 +
Download. Subject-scoped (a baker sees only their own).

**No new table. No new enum.** `action`, `source`, `subject_type` already exist.

---

## 4. Account deletion — soft-delete → retention hold → scheduled erasure

Neither pure soft nor pure hard delete is compliant alone: soft-only never erases; hard-now
violates the retention floor + statutory minimums (§6). The lifecycle (matches
`feedback_prefer_soft_delete` **and** the job-queue principle):

### Phase 1 — request → **soft-delete now** (synchronous)
`POST /api/baker/account/delete` (authed, owner-only — a new `account:delete` capability;
staff cannot delete the baker). Effects, in a transaction:
- `bakers.deletion_status = 'pending_erasure'`, `bakers.deletion_requested_at = now()`,
  `bakers.erase_after = now() + RETENTION_WINDOW` (§6).
- Deactivate: `storefront_published = false` (storefront goes offline immediately), sessions
  revoked (`supabase.auth.admin` sign-out), login blocked for the baker's appusers.
- Append a `consent_events` `WITHDRAWN` row for the required docs **as the audit trail of the
  closure** (proof we acted on the request), plus a `deletion_requests` audit row
  (who/when/reason/ip).
- Reversible until `erase_after`: a **reactivate** path (like `customers/:id/reactivate`)
  clears `deletion_status`. Logging back in within the window cancels erasure (Rule 8 intent).

This reuses the existing **`is_active` / deactivate** pattern (`customers.js:133`) — extend it
to `bakers`, don't invent a new mechanism.

### Phase 2 — **retention hold** (passive)
Row stays soft-deleted for `RETENTION_WINDOW`. Nothing processes it (storefront off, no login).
This window satisfies the DPDP ~1-year floor (§6) and gives the 48-hour-notice room.

### Phase 3 — **48-hour pre-erasure notice** (queued)
A cron sweep (below) finds rows crossing `erase_after − 48h` with `notice_sent_at IS NULL`,
emails the data principal ("your data will be erased in 48h; log in to keep your account"),
sets `notice_sent_at`. Reuses `sendNotification` processor. (Rule 8 requirement.)

### Phase 4 — **scheduled erasure / anonymization** (queued)
A **BullMQ cron** `erase-expired-accounts` (new `src/jobs/schedules.js` entry, UTC, env
`ERASE_ACCOUNTS_CRON`, default `30 3 * * *`; new `processors/eraseExpiredAccounts.js` in the
worker map). For each `bakers` row past `erase_after` still `pending_erasure`:
- **Erase/anonymize personal data** in `bakers` + `baker_appusers` (names, emails, phones →
  nulled or tombstoned; `deletion_status = 'erased'`). Cascade personal fields in owned tables
  (designs, customers, invites) per a **per-table erasure manifest** (one declarative map, not
  ad-hoc deletes scattered per table — DRY).
- **Delete the Supabase Auth users** (`supabase.auth.admin.deleteUser`).
- **Keep** `consent_events` (proof of lawful handling) and the `deletion_requests` audit row.

Config-driven windows (§6) mean this job never hardcodes a number.

---

## 5. Statutory carve-out — erasure is **scoped**, `spattoo-accounting` is untouched

Erasure is **not** all-or-nothing. Records another law requires you to keep **override** the
erasure request:
- **GST/tax invoices** must be retained ~**8 years** (GST law) — these live in the **separate
  `spattoo-accounting` service** (immutable, gap-free register; `project_gst_invoicing`). The
  erasure job in this repo **must not touch the accounting DB**. It retains invoices for their
  statutory life; personal identifiers there are pseudonymized where the register allows.
- Net retention per data class (all **env-configurable**, not hardcoded — §6):

| Data class | Home | On deletion |
|---|---|---|
| Baker/appuser profile, designs, customers, invites | `spattoo-api` / Supabase | soft-delete now → **erase/anonymize** after `RETENTION_WINDOW` |
| Tax/GST invoices | `spattoo-accounting` | **retain ~8 yrs** (statutory), pseudonymize — never erased by this flow |
| `consent_events`, `deletion_requests` | `spattoo-api` | **kept** (evidence we handled the request lawfully) |

---

## 6. Retention windows — config, signed off by counsel

DPDP's own hard numbers (verified against the **notified DPDP Rules 2025**, in force 13 May
2027): the **3-year** inactivity-then-mandatory-erasure (Third Schedule) applies only to **large
fiduciaries** (e-commerce ≥2 cr users, gaming ≥50 lakh, social media ≥2 cr) — Spattoo is far
below, so it does **not** bind us yet; we design toward it. The **~1-year floor** = retain even
when erasure conditions are met, then erase. Other laws impose **minimums** (GST ~8 yrs).

So the window is a **per-class env config**, tunable without a deploy, defaulted conservatively
and **confirmed by legal counsel before launch** (this doc is engineering scope, not legal
advice):

```
RETENTION_WINDOW        default 365d   // profile/design erasure delay after a delete request
ERASE_ACCOUNTS_CRON     default '30 3 * * *' UTC
INVOICE_RETENTION_YEARS default 8      // accounting service; statutory
```

Add to `src/config.js` `jobs`/a new `retention` block, mirroring the existing `reconcileCron`
pattern.

---

## 7. Customers (storefront end-users) — same tables, later

The consent tables already serve `subject_type = 2 (customer)`, `source = 4 (quote)`. When
customer consent is captured at quote submission (Layer 2 §5, future), the **same**
`/api/legal/withdraw` + a storefront "Privacy" control cover their withdrawal — no new backend.
Explicitly **out of scope for this build**; noted so the API stays subject-agnostic.

---

## 8. Data model changes (minimal)

**No new consent tables.** Additions:

`bakers` (migration `020_account_erasure.sql`, highest existing is `019`):
```
deletion_status      smallint    NOT NULL DEFAULT 0   -- 0=active,1=pending_erasure,2=erased (compact enum)
deletion_requested_at timestamptz
erase_after          timestamptz
notice_sent_at       timestamptz
CREATE INDEX ON bakers (erase_after) WHERE deletion_status = 1;   -- hot: the sweep's exact query
```

`deletion_requests` — append-only audit (bounded by delete events, not hot):
```
id           bigserial PRIMARY KEY
baker_id     ... REFERENCES bakers(id)
requested_by uuid        -- auth_user_id
reason       text
ip           inet
requested_at timestamptz NOT NULL DEFAULT now()
erased_at    timestamptz
```

`deletion_status` is a **compact smallint enum** translated at the API boundary
(`feedback_schema_scale_surrogate`), and the partial index matches the sweep's access pattern —
not a scan of every baker.

---

## 9. Sequencing

1. **Migration `020`** — `bakers` erasure columns + `deletion_requests` + partial index.
2. **Withdrawal** — `withdrawConsent()` in `legalConsent.js`, `POST /api/legal/withdraw`,
   `GET /api/legal/consent/history`. (Pure additive; reuses Layer 2.)
3. **Deletion request** — `account:delete` capability, `POST /api/baker/account/delete` +
   reactivate, soft-delete + session revoke + audit row.
4. **Erasure lifecycle** — `erase-expired-accounts` cron + 48h-notice sweep + per-table erasure
   manifest + `processors/eraseExpiredAccounts.js`. Config windows in `config.js`.
5. **Web** — Privacy & Data settings screen (agreements + optional-consent toggles + delete
   flow), config-driven from `/api/legal/current` + `/consent/history`.
6. **Docs** — create the `spattoo-docs` feature doc for the legal/consent capability (or extend
   the existing one) with `owns:` covering `routes/legal.js`, `services/legalConsent.js`,
   `processors/eraseExpiredAccounts.js`, and the settings screen; add a Changelog row.

**Gating:** like Layer 2, keep binding withdrawal/erasure behind `LEGAL_STATUS='published'`.
The withdrawal endpoint is safe to ship early (no-op while no optional consent exists); the
**deletion** flow should not go live until counsel confirms `RETENTION_WINDOW` and the erasure
manifest is reviewed for completeness (miss a personal-data column → incomplete erasure).

## 10. Open decisions
- **`RETENTION_WINDOW` value** — counsel sign-off (365d is a placeholder).
- **Erasure vs anonymization** per table — hard-null personal columns vs keep an anonymized
  shell for referential integrity (e.g. an order's `customer_id`). Decide per table in the
  manifest.
- **Owner-only vs also-super-admin** deletion — admin-initiated erasure (support request) may
  also be needed; same service, different capability.
- **Download format** for the consent record — JSON now, PDF if counsel wants a signed artifact.
```

