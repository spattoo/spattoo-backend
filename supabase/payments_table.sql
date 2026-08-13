-- Payment records written by the billing webhook.
-- status_id: 1=captured 2=failed 3=refunded

CREATE TABLE IF NOT EXISTS payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baker_id                 uuid NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  baker_subscription_id    uuid REFERENCES baker_subscriptions(id),
  razorpay_payment_id      text UNIQUE,
  razorpay_subscription_id text,
  amount                   integer NOT NULL,
  currency                 text NOT NULL DEFAULT 'INR',
  status_id                int NOT NULL,
  charged_at               timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_baker_id_idx ON payments(baker_id);
-- Hot access pattern: a baker's payments newest-first (latest-row fetch + count).
CREATE INDEX IF NOT EXISTS payments_baker_charged_at_idx ON payments(baker_id, charged_at DESC);
