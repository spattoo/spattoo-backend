-- ── 053: device tokens for push ────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/plans/notifications.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- Email addresses a PERSON. Push addresses a DEVICE, and one person has several — a
-- phone, the shop tablet, the laptop they do quotes on. So push needs a table email
-- never did, and the row is the device, not the human.
--
-- Written for a browser today (FCM's web SDK) and unchanged when the Capacitor apps
-- land: an Android or iOS registration token is the same string in the same column.
-- That is the whole reason FCM was chosen over raw VAPID web-push — this table would
-- otherwise have been thrown away and rebuilt in a fortnight.

create table if not exists device_tokens (
  id             bigserial   primary key,

  -- TENANCY, same convention as baker_uploads and print_sheets: whose bakery's world
  -- this belongs to. Cascade because a deleted bakery's devices are not addressable
  -- and keeping them would send a stranger's phone somebody else's orders.
  baker_id       uuid        not null references bakers (id) on delete cascade,

  -- WHO. The Supabase auth user, which is how a notification's recipient_email is
  -- resolved to devices (email → baker_appusers → auth_user_id → here). Not a foreign
  -- key: auth.users lives in Supabase's schema and referencing across it couples this
  -- table to their migration timing for no gain — the id is opaque either way.
  auth_user_id   uuid        not null,

  -- The FCM registration token. UNIQUE because it identifies one app instance on one
  -- device: the same string arriving again is that device re-registering, not a second
  -- device. On conflict the row is UPDATED (see routes/deviceTokens.js) rather than
  -- duplicated — which is also what moves a device to a new owner when a shop tablet
  -- is handed to another staff member, instead of quietly notifying both.
  token          text        not null unique,

  -- 'web' | 'android' | 'ios'. Kept because the three behave differently and a bug
  -- report of "notifications don't work" is unanswerable without knowing which. Also
  -- what a later platform-specific payload would branch on.
  platform       text        not null default 'web'
                 check (platform in ('web', 'android', 'ios')),

  created_at     timestamptz not null default now(),
  -- Refreshed every time the client re-registers, which the SDK does on load. A token
  -- that has not been seen in months is a device that is gone; FCM will say so with
  -- UNREGISTERED and the sender prunes it, but this makes the same rot visible in a
  -- query rather than only at send time.
  last_seen_at   timestamptz not null default now()
);

-- HOT PATH — every device belonging to one bakery, which is what a send resolves to.
create index if not exists device_tokens_baker_idx on device_tokens (baker_id);
-- And the per-person lookup, for "this user's devices" and for logout cleanup.
create index if not exists device_tokens_user_idx  on device_tokens (auth_user_id);

comment on table device_tokens is
  'FCM registration tokens, one row per device per person. Push addresses a device; email addresses '
  'a person — which is why this table exists and notifications.recipient_email was not enough. '
  'Pruned on FCM UNREGISTERED (services/fcm.js). Same shape for web, Android and iOS.';
