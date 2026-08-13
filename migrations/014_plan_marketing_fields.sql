-- Plan MARKETING catalog moves into the DB so billing + onboarding read ONE source
-- (was hardcoded + drifting in both spattoo-core BillingPanel and spattoo-web onboarding).
-- Entitlements/prices already live here; these add the human-facing copy admin authors.
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tagline        text;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS feature_bullets text[]  NOT NULL DEFAULT '{}';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_popular     boolean NOT NULL DEFAULT false;
-- Whether the plan includes a public storefront (gates the logo/storefront steps in the
-- self-signup wizard). A plan attribute, so it lives with the plan.
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS has_storefront boolean NOT NULL DEFAULT true;

-- Seed from the CURRENT marketing copy (the post-"drop WhatsApp" set the onboarding
-- wizard already shows). Admin can edit these in Manage Plans afterwards.
UPDATE subscription_plans SET
  tagline = 'Design canvas · 10 orders', is_popular = false, has_storefront = false,
  feature_bullets = ARRAY['Design canvas','10 total orders','1 team member','Help-docs support']
WHERE name = 'spark';

UPDATE subscription_plans SET
  tagline = 'Public storefront · unlimited orders', is_popular = false, has_storefront = true,
  feature_bullets = ARRAY['Everything in Spark','Public storefront (yourname.spattoo.com)','Unlimited orders','2 team members','Email support']
WHERE name = 'flame';

UPDATE subscription_plans SET
  tagline = 'Custom branding & templates', is_popular = true, has_storefront = true,
  feature_bullets = ARRAY['Everything in Flame','Custom templates','Custom branding','5 team members','Priority chat support']
WHERE name = 'blaze';

UPDATE subscription_plans SET
  tagline = 'Everything · unlimited team', is_popular = false, has_storefront = true,
  feature_bullets = ARRAY['Everything in Blaze','Unlimited team members','Dedicated account manager']
WHERE name = 'forge';
