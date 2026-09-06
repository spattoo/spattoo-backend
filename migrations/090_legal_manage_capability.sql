-- `legal:manage` — the capability that publishes a legal document version.
--
-- ⚠️ IT WAS NEVER SEEDED. `POST /api/admin/legal/versions` (src/routes/legal.js) has required this
-- capability since it was written, and no row for it has ever existed — so `requireCapability`
-- resolved it to "no" for every principal, every time, and the route has been callable by NOBODY
-- since day one. Nothing surfaced that, because v1.0 of all four documents was published through
-- scripts/publish-legal-version.mjs, which runs with the service role and bypasses RBAC entirely.
--
-- Found while wiring the admin publish screen: the screen would have loaded, shown the document,
-- and 403'd on the button, with the cause four layers away from the symptom.
--
-- SENSITIVE, AND DELIBERATELY NOT GRANTED TO admin_staff. Publishing a version writes the row that
-- consent records and content attestations point at — the evidence that a named person agreed to a
-- specific text, under the DPDP Act. It also FLIPS is_current, so it changes what every future
-- consent binds to. That is governance, not catalogue work, so it sits with `subscription:override`
-- and `admin:manage`: super admins only (role `admin`, whose is_super grants every capability
-- without needing a row in role_capabilities).
--
-- Re-runnable, like the rest of the RBAC seed.

insert into capabilities (key, label, description, category, is_sensitive, sort_order) values
  ('legal:manage', 'Publish legal versions', 'Freeze and publish a version of a legal document', 'platform', true, 33)
on conflict (key) do nothing;
