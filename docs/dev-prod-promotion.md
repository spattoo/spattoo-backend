# Dev → Prod Environment Separation & Master-Data Promotion

> Status: **design / not yet implemented.** Prod does not exist yet (target go-live ~Aug 2026). This documents the agreed approach so it can be built at prod standup.

## Decision

Run **fully separate dev and prod stacks**: distinct Supabase projects + distinct R2 buckets
(`spattoo-assets-dev` today; `spattoo-assets-prod` to be created). Today everything points at the
single dev project + dev bucket.

### Why separate (not a single DB with a draft/published flag)

A single store with a status flag was considered and rejected. Separation was chosen because of:

1. **Audit isolation** — prod must be cleanly isolated for product audits.
2. **Experimentation blast radius** — optimizing/experimenting on an existing asset must never touch
   prod.
3. **Least privilege for future developers** — devs will get dev credentials; those must never be
   able to reach prod assets/data. Separate stacks make this enforceable (scope the dev R2 token to
   `spattoo-assets-dev` only; keep prod tokens isolated).

## Promotion model: human export/import artifact (NOT an automated job)

A human-in-the-loop export/import flow was chosen over an automated sync job because it is explicit,
auditable, and lets the prod admin **preview and confirm** before anything is written — which is the
main guard against admin mistakes.

### Elements

1. **Export (dev admin app).** Admin exports a *single* element to a JSON artifact. No surrogate ids
   in the artifact — identity is a stable uuid, and the type is referenced by its natural key.

   ```jsonc
   {
     "schemaVersion": 1,
     "publicId": "uuid",            // stable, env-independent identity — never the surrogate id
     "name": "Gold Star Topper",
     "elementTypeKey": "topper",    // natural key; resolved to the prod type id on import
     "placement": { /* placement json */ },
     "zone": { /* zone json */ },
     "assets": [
       { "role": "model",     "bucket": "spattoo-assets-dev", "key": "elements/files/3D/...",   "contentHash": "..." },
       { "role": "thumbnail", "bucket": "spattoo-assets-dev", "key": "elements/thumbnails/...", "contentHash": "..." }
     ]
   }
   ```

2. **Import (prod admin app).** Admin uploads the JSON. Prod shows a **preview**: the image loaded
   from the (public) dev bucket plus all element fields. The import is **3-state**, keyed on
   `publicId`:
   - not in prod → **Create**
   - in prod, identical (same fields + asset `contentHash`) → **Already imported, nothing to do**
   - in prod, differs → **Update**, with a field-level diff shown.

3. **Confirm.** On confirm, server-side in prod `spattoo-api`:
   1. Copy each asset dev→prod bucket (server-side CopyObject; **idempotent** — skip if prod already
      has the same `contentHash`; verify ETag/size after copy).
   2. **Then** upsert the prod DB row on `publicId`, pointing at the **prod** bucket key.

   Asset copy happens *before* the DB write, and the persisted prod row references the **prod** bucket
   — never the dev bucket (a prod row pointing at dev would reintroduce a prod→dev coupling and break
   audit isolation). The preview loads from dev; the stored record references prod.

### Types

`element_types` are **not** exported via JSON. They are managed as an **idempotent seed script** in
`spattoo-api`, version-controlled, upserting on the unique natural `key`:

```sql
insert into element_types (key, label, ...) values
  ('topper', 'Cake Topper', ...),
  ('candle', 'Candle',      ...)
on conflict (key) do update set label = excluded.label, ...;
```

- Run the **same file** on dev, then on prod. Each DB auto-assigns its own surrogate `id` — and that
  is fine, because **nothing crosses environments by id**; elements reference types by `elementTypeKey`
  and import resolves `key → prod id`.
- The seed script is the **source of truth** for types (author/edit there, not via a dev-only UI).
- **Dependency order at promote time:** run the type seed on prod **before** importing elements. An
  element import **fails fast** if its `elementTypeKey` is not present in prod.

## Why identity is `publicId`, type is `key` (the core invariant)

Dev and prod are separate databases, so auto-generated surrogate ids differ across them. Therefore
the promotion artifact carries **no surrogate ids**:

- **Element identity** = `publicId` (uuid generated at creation in dev, preserved on import). This
  makes import idempotent and update-capable: re-importing an optimized asset **updates** the prod row
  instead of creating a duplicate. (Asset filename is **not** a valid identity key — an element has
  multiple assets, and the filename can change when an asset is re-optimized.)
- **Type reference** = natural `key` (resolved to the prod surrogate id on import).

## Security model

- **Prod credentials never leave prod.** Prod Supabase service key + prod R2 keys live only on the
  prod-side server — never in dev, never in the browser, never issued to developers.
- The asset copy runs **server-side in prod `spattoo-api`** (prod write creds + read-only dev bucket
  access, both server-side). The browser only uploads the JSON and clicks confirm.
- Read-only access to the dev bucket is acceptable (assets are public anyway).
- **Treat the imported JSON as untrusted input** (a human carries it between two apps): schema-validate
  on import, honor `schemaVersion`, validate the named source bucket against an allowlist, and confirm
  the referenced assets actually exist before preview/copy. An HMAC/checksum on the export is optional
  for a trusted team but cheap and audit-friendly.

## Mistake mitigations

- Idempotent import keyed on `publicId` (re-import is safe; no duplicates).
- Preview + field-level diff before the prod admin confirms.
- Prod elements keep a `status_id`/`is_active` flag → a bad import can be disabled instantly without
  deleting (soft-delete only).
- Audit columns `promoted_by` / `promoted_at` (and `published_by` / `published_at` if a publish step is
  added).

## Schema groundwork to do NOW (cheap while there is no prod data — schema is forever)

These are independent of prod existing and avoid a painful retrofit later:

1. Add `public_id uuid not null default gen_random_uuid()` (unique) to `cake_elements` and
   `templates`.
2. Confirm `element_types.key` is `UNIQUE NOT NULL` (the cross-env join key). Same for any other
   lookup involved in promotion.
3. Add a `status_id smallint` (FK to a small status lookup) or `is_active boolean` to the master
   tables, so prod inherits the rollback flag from day one.
4. Write the `element_types` seed script (idempotent, `on conflict (key)`).

## To build at prod standup (~go-live)

5. Create the prod Supabase project + `spattoo-assets-prod` bucket; scope IAM (dev token → dev bucket
   only; prod tokens isolated; prod server gets read-only dev access).
6. Export endpoint + "Export" action in the dev admin app (produces the JSON above).
7. Import endpoint + preview/diff/confirm UI in the prod admin app (3-state, server-side asset copy
   then DB upsert on `publicId`).

## Scope notes

- **Single-element export only** for the MVP. The artifact is one element object; it can be wrapped in
  an array later for bulk without redesign, but bulk is out of scope for now.
- No export/import UI is needed for **types** — they are seed-script managed.
