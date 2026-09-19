-- ── 095: which channels each notification goes out on, and how ──────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Until now the channel was code. Every notification was an email, and buildPush() in
-- sendNotification.js decided by slug which few also buzzed a phone. SMS and WhatsApp break that,
-- because each needs something only an admin holds and that changes without a deploy: an MSG91
-- template id cleared through DLT, an AiSensy campaign name approved by Meta.
--
-- So: one row per (notification type, channel). The MESSAGE stays in code — the email and push
-- text, and the payload that fills a template's gaps. This table only says which channels are on
-- and which approved template each one uses.
--
-- ⚠️ SEEDED TO CHANGE NOTHING. Email on for every type; push on for exactly the four types
-- buildPush() already writes text for. SMS rows for the trial and renewal reminders are created
-- OFF: they have no approved DLT template yet, and an SMS channel switched on without one fails on
-- every send.
--
-- ⚠️ services/notificationChannels.js holds the same defaults for the window between deploying the
-- code and running this file. A missing table reads as "email plus today's push", never as "send
-- nothing".

CREATE TABLE IF NOT EXISTS public.notification_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id       integer NOT NULL REFERENCES public.notification_types(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email', 'push', 'sms', 'whatsapp')),
  enabled       boolean NOT NULL DEFAULT false,
  -- sms: the MSG91 template id (DLT-approved). whatsapp: the AiSensy campaign name (must be Live).
  -- email and push: unused — their text is written in code.
  template_ref  text,
  -- sms:      { "variables": { "VAR1": "bakerName" } }        template variable → payload field
  -- whatsapp: { "params": ["customerName"], "image_field": "thumbnailUrl" }   {{1}}, {{2}} … in order
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Send this channel ONLY when the named channel did not deliver — e.g. sms covering for whatsapp.
  fallback_for  text CHECK (fallback_for IN ('push', 'sms', 'whatsapp')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type_id, channel),
  CHECK (fallback_for IS NULL OR fallback_for <> channel)
);

DROP TRIGGER IF EXISTS notification_channels_updated_at ON public.notification_channels;
CREATE TRIGGER notification_channels_updated_at
  BEFORE UPDATE ON public.notification_channels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Server-only, like notification_types and notifications: RLS on and no policies, so only the
-- service role (the API) can read or write it.
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

-- ── What each channel did, per notification ─────────────────────────────────────────────────────
-- notifications.status meant "the email was sent". With several channels that is no longer one
-- fact, and a retry that re-runs everything would send the email and the SMS again to fix a failed
-- WhatsApp. So each channel's outcome is its own row, and a retry skips a channel already sent.
--
-- `recipient` is a phone number or email address. It goes when the notification goes (CASCADE), so
-- the nightly purge and account erasure cover it without knowing it exists.
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id      uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  channel              text NOT NULL CHECK (channel IN ('email', 'push', 'sms', 'whatsapp')),
  status               text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  recipient            text,
  provider_message_id  text,
  detail               text,          -- the provider's error, or why the channel was skipped
  attempts             integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel)
);

DROP TRIGGER IF EXISTS notification_deliveries_updated_at ON public.notification_deliveries;
CREATE TRIGGER notification_deliveries_updated_at
  BEFORE UPDATE ON public.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

-- ── Seed: exactly today's behaviour ─────────────────────────────────────────────────────────────
INSERT INTO public.notification_channels (type_id, channel, enabled)
SELECT id, 'email', true FROM public.notification_types
ON CONFLICT (type_id, channel) DO NOTHING;

INSERT INTO public.notification_channels (type_id, channel, enabled)
SELECT id, 'push', true FROM public.notification_types
 WHERE slug IN ('order_placed_baker', 'quote_accepted_baker', 'delivery_digest_baker', 'trial_ending')
ON CONFLICT (type_id, channel) DO NOTHING;

-- Off until each has an approved DLT template id and its variables are mapped in admin.
INSERT INTO public.notification_channels (type_id, channel, enabled)
SELECT id, 'sms', false FROM public.notification_types
 WHERE slug IN ('trial_ending', 'trial_ended', 'subscription_renewing')
ON CONFLICT (type_id, channel) DO NOTHING;

-- Expect: email on for every type (24 today), push on for 4, sms off for 3.
SELECT channel, enabled, count(*) AS types
  FROM public.notification_channels
 GROUP BY channel, enabled
 ORDER BY channel, enabled;
