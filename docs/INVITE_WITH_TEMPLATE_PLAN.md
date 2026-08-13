# Invite with a Starting Design (baker shares a design to a customer)

Status: PLANNING (branch `feat/draft-share`; worktrees `spattoo-api-draft-share` + later `spattoo-web-draft-share`).
Extends the quote flow (`PRICING_AND_QUOTE_PLAN.md`). **The order flow does NOT change** — orders are still
created customer-side at submit and always have a customer.

## Model decision — snapshot the design ON THE INVITE (not a template row)
A shared "draft" is not a library template — it is *this invite's starting design*: created when the invite is
sent, frozen at that moment, never browsed, never reused, and it dies with the invite. So it lives on the
invite, exactly like `orders.design_snapshot` already snapshots a design (established precedent).

- **`cake_templates` is untouched** — it stays a purely curated library. The templates sidebar therefore
  never grows from sharing, so there is NO `listed` flag, NO partial index, NO quota exclusion, and NO GC job.
- **One resume path:** the customer always resumes from `customer_invites.design_snapshot`.
- We do NOT introduce a designs table, baker draft-orders, or a nullable `orders.customer_id`.

Rejected alternatives: (a) share-drafts as unlisted rows in `cake_templates` — needs a `listed` flag + partial
index + quota carve-out + GC to hide non-library rows from the library (scaffolding to make a table hold what
it isn't); (b) a separate `draft_templates` table — duplicates the whole template schema + a second loader for
the same isolation inline-on-invite already gives.

## What ALREADY exists (no work)
- `customer_invites` (baker→customer invite event; OTP-gated login; `?invite=<id>` link).
- Baker template authoring — designer "Save as Template" (`CakeDesigner.jsx:1518`; baker app uses the fallback
  → `cake_templates` row with session `baker_id`). Untouched by this feature.
- `GET /templates` (baker sees own + global) — untouched.
- Quote lifecycle (`initiated→requested→quoted→quote_approved→…`), design lock at `quote_approved`, baker
  post-order edits (`PATCH /orders/:id/design` → emails the customer), order version history.

## Schema — one table, additive
```sql
ALTER TABLE customer_invites
  ADD COLUMN IF NOT EXISTS design_snapshot      jsonb,   -- starting design, frozen at send (NULL = blank start)
  ADD COLUMN IF NOT EXISTS design_thumbnail_url text,    -- optional preview for the invite/landing
  ADD COLUMN IF NOT EXISTS template_id          uuid REFERENCES cake_templates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS customer_invites_template_idx ON customer_invites (template_id);
```
- `design_snapshot` NULL = today's "come design (blank)" invite, untouched. Set = "start from this design."
- `template_id` is **provenance only** (which library template it was seeded from, for analytics) — NOT read on
  the resume path. `ON DELETE SET NULL` so deleting a template never touches the invite/audit.
- jsonb is TOAST-ed off-heap: invite validity/list queries select scalar columns and never pull the design;
  only `GET /invite/:id` reads it, which is exactly when it's needed.

## Two baker entry points, ONE mechanism
Both just populate `design_snapshot` on the invite; the customer-resume path is identical.
- **(A) Invite with an existing template** — baker picks one of their own/global templates on the invite form;
  at invite-create we copy that template's `design` into `design_snapshot` and record `template_id`.
- **(B) "Share the draft" (one-tap, in the designer)** — a button next to "Order this cake" that snapshots the
  CURRENT design into `design_snapshot` and opens the invite popup prefilled. No template row created.

## The pieces to BUILD

### spattoo-api
- `POST /baker/customers/invite` (customers.js:162): accept optional `design_snapshot` + `design_thumbnail_url`
  (path B) OR `template_id` (path A → server copies that template's `design` after validating it is global or
  owned by `req.bakerId`). Store on the invite. Keep the existing customer-upsert + invite-insert + branded
  email path — extend it, don't fork it. (This single endpoint covers both A and B; no separate share route.)
- `GET /invite/:id` (storefront.js:148): when `design_snapshot` is set, return it (+ `design_thumbnail_url`) so
  the storefront preloads. Keep existing masked-contact/validity fields.

### spattoo-web
- Designer (baker mode): add **"Share the draft"** next to "Order this cake" → capture design + thumbnail
  (reuse `handleSaveTemplate`'s capture at CakeDesigner.jsx:1518, same snapshot shape) → POST the invite with
  `design_snapshot` → open the invite popup prefilled.
- Baker invite form (path A): optional template picker (`GET /templates`).
- Storefront `DesignerClient` (orderMode="customer"): when the opened invite has `design_snapshot`, seed the
  designer's initial design from it (reuse the designer's existing design-hydration path — confirm the seed
  prop in `useCakeDesign.js` before building). Customer edits → existing "Request a quote" → `POST
  /customer/orders` creates the order (customer-owned). Nothing downstream changes.

## Notifications
- Baker→customer "here's a design to start from" IS the invite email itself (already branded). No new type.
- Baker edits an existing order's design → customer emailed (`notifyDesignUpdated`) — already wired.
- Customer→baker on quote request — already wired via the order-placed/quote path.

## Non-goals
- Separate designs/draft_templates table; baker draft-orders; nullable `orders.customer_id`; `cake_templates`
  changes of any kind.
- Live simultaneous baker+customer editing (separate Live Co-design track).
