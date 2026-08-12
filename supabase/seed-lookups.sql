-- ─────────────────────────────────────────────────────────────────────────────
-- spattoo — reference data.  GENERATED FILE — do not hand-edit.
--
-- Regenerate:  node scripts/seed-lookups-sql.mjs
-- Apply:       paste into the target project's SQL editor and run.
--
-- The vocabularies the CODE speaks — statuses, roles, plans, notification types. Distinct
-- from the admin-authored library (elements, templates, tags), which has pictures in R2 and
-- travels via scripts/migrate-master-to-prod.mjs.
--
-- Every row is a snapshot of DEV at generation time, not a copy of the seed migrations —
-- those have drifted. Idempotent: re-running refreshes rows rather than duplicating them.
--
-- 16 tables, 128 rows.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;
-- capabilities — 17 rows
INSERT INTO public.capabilities (key, label, description, category, is_sensitive, sort_order, created_at) VALUES
  ('design:create', 'Create designs', 'Open and build a cake design', 'design', false, 0, '2026-06-17T05:41:33.553897+00:00'),
  ('order:place', 'Place orders', 'Submit a cake order', 'design', false, 1, '2026-06-17T05:41:33.553897+00:00'),
  ('order:view', 'View orders', 'See orders for the baker', 'baker', false, 10, '2026-06-17T05:41:33.553897+00:00'),
  ('order:manage', 'Manage orders', 'Update order status / details', 'baker', false, 11, '2026-06-17T05:41:33.553897+00:00'),
  ('customer:manage', 'Manage customers', 'Create, edit, and invite customers', 'baker', false, 12, '2026-06-17T05:41:33.553897+00:00'),
  ('template:manage', 'Manage templates', 'Create and edit baker templates', 'baker', false, 13, '2026-06-17T05:41:33.553897+00:00'),
  ('store:manage', 'Manage store', 'Edit settings, branding, storefront', 'baker', false, 14, '2026-06-17T05:41:33.553897+00:00'),
  ('staff:manage', 'Manage staff', 'Add / remove baker staff users', 'baker', false, 15, '2026-06-17T05:41:33.553897+00:00'),
  ('billing:manage', 'Manage own billing', 'Manage the baker''s own subscription & payments', 'baker', false, 16, '2026-06-17T05:41:33.553897+00:00'),
  ('baker:onboard', 'Onboard bakers', 'Create and manage baker accounts', 'platform', false, 20, '2026-06-17T05:41:33.553897+00:00'),
  ('catalog:admin', 'Manage global catalog', 'Global elements, types, and templates', 'platform', false, 21, '2026-06-17T05:41:33.553897+00:00'),
  ('baker:support', 'Support access', 'View baker data for support', 'platform', false, 22, '2026-06-17T05:41:33.553897+00:00'),
  ('billing:discount', 'Issue discounts', 'Apply discounts to a baker', 'platform', true, 30, '2026-06-17T05:41:33.553897+00:00'),
  ('subscription:override', 'Override subscriptions', 'Comp / offer subscription upgrades', 'platform', true, 31, '2026-06-17T05:41:33.553897+00:00'),
  ('admin:manage', 'Manage admins & RBAC', 'Add/remove admins, edit roles & capabilities', 'platform', true, 32, '2026-06-17T05:41:33.553897+00:00'),
  ('account:delete', 'Delete account', 'Request erasure of the baker account & its data', 'baker', true, 17, '2026-07-06T08:45:23.209574+00:00'),
  ('element:manage', 'Manage own decorations', 'Upload and remove their own cake decorations', 'baker', false, 17, '2026-07-11T17:39:54.924905+00:00')
ON CONFLICT (key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    is_sensitive = EXCLUDED.is_sensitive,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at;

-- roles — 5 rows
INSERT INTO public.roles (key, label, description, scope, is_super, is_system, sort_order, created_at) VALUES
  ('admin', 'Admin (super)', 'Full platform access — every capability', 'platform', true, true, 0, '2026-06-17T05:41:46.635741+00:00'),
  ('admin_staff', 'Admin Staff', 'Platform operations without privileged money actions', 'platform', false, true, 1, '2026-06-17T05:41:46.635741+00:00'),
  ('owner', 'Baker Owner', 'Full access to the baker''s own store', 'baker', false, true, 2, '2026-06-17T05:41:46.635741+00:00'),
  ('staff', 'Baker Staff', 'Day-to-day baker work; no store/billing/staff admin', 'baker', false, true, 3, '2026-06-17T05:41:46.635741+00:00'),
  ('customer', 'Customer', 'Design and order only', 'customer', false, true, 4, '2026-06-17T05:41:46.635741+00:00')
ON CONFLICT (key) DO UPDATE SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    scope = EXCLUDED.scope,
    is_super = EXCLUDED.is_super,
    is_system = EXCLUDED.is_system,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at;

-- role_capabilities — 25 rows
INSERT INTO public.role_capabilities (role_key, capability_key) VALUES
  ('admin_staff', 'design:create'),
  ('admin_staff', 'baker:onboard'),
  ('admin_staff', 'catalog:admin'),
  ('admin_staff', 'baker:support'),
  ('owner', 'design:create'),
  ('owner', 'order:place'),
  ('owner', 'order:view'),
  ('owner', 'order:manage'),
  ('owner', 'customer:manage'),
  ('owner', 'template:manage'),
  ('owner', 'store:manage'),
  ('owner', 'staff:manage'),
  ('owner', 'billing:manage'),
  ('staff', 'design:create'),
  ('staff', 'order:place'),
  ('staff', 'order:view'),
  ('staff', 'order:manage'),
  ('staff', 'customer:manage'),
  ('staff', 'template:manage'),
  ('customer', 'design:create'),
  ('customer', 'order:place'),
  ('owner', 'account:delete'),
  ('owner', 'element:manage'),
  ('staff', 'element:manage'),
  ('customer', 'element:manage')
ON CONFLICT (role_key, capability_key) DO NOTHING;

-- order_statuses — 11 rows
INSERT INTO public.order_statuses (key, label, phase, sort_order, is_terminal, customer_visible, tone, created_at, id) VALUES
  ('initiated', 'Initiated', 'quote', 10, false, true, 'slate', '2026-06-26T16:24:12.980671+00:00', 10),
  ('requested', 'Requested', 'quote', 20, false, true, 'amber', '2026-06-26T04:52:07.737433+00:00', 1),
  ('quoted', 'Quoted', 'quote', 30, false, true, 'blue', '2026-06-26T04:52:07.737433+00:00', 2),
  ('quote_approved', 'Quote approved', 'fulfillment', 35, false, true, 'teal', '2026-06-26T18:35:45.429627+00:00', 12),
  ('confirmed', 'Confirmed', 'fulfillment', 40, false, true, 'green', '2026-06-26T04:52:07.737433+00:00', 3),
  ('in_production', 'In production', 'fulfillment', 50, false, true, 'violet', '2026-06-26T04:52:07.737433+00:00', 4),
  ('ready', 'Ready', 'fulfillment', 60, false, true, 'teal', '2026-06-26T04:52:07.737433+00:00', 5),
  ('completed', 'Completed', 'fulfillment', 70, true, true, 'grey', '2026-06-26T04:52:07.737433+00:00', 6),
  ('declined', 'Declined', 'closed', 80, true, true, 'red', '2026-06-26T04:52:07.737433+00:00', 7),
  ('cancelled', 'Cancelled', 'closed', 90, true, true, 'red', '2026-06-26T04:52:07.737433+00:00', 8),
  ('expired', 'Expired', 'closed', 100, true, false, 'grey', '2026-06-26T04:52:07.737433+00:00', 9)
ON CONFLICT (id) DO UPDATE SET
    key = EXCLUDED.key,
    label = EXCLUDED.label,
    phase = EXCLUDED.phase,
    sort_order = EXCLUDED.sort_order,
    is_terminal = EXCLUDED.is_terminal,
    customer_visible = EXCLUDED.customer_visible,
    tone = EXCLUDED.tone,
    created_at = EXCLUDED.created_at;

-- design_session_statuses — 3 rows
INSERT INTO public.design_session_statuses (id, key, label) VALUES
  (1, 'active', 'Active'),
  (2, 'ended', 'Ended'),
  (3, 'expired', 'Expired')
ON CONFLICT (id) DO UPDATE SET
    key = EXCLUDED.key,
    label = EXCLUDED.label;

-- element_action_types — 4 rows
INSERT INTO public.element_action_types (id, key, label, description, default_value, sort_order, is_active, created_at) VALUES
  ('09882abb-cfda-455e-83a7-993368ad474d', 'resize', 'Resizable', 'Show drag handle so the customer can resize this element on the canvas.', true, 1, true, '2026-04-30T19:44:16.814771+00:00'),
  ('c43fe533-3d0f-4975-8594-82ad86aa002b', 'color', 'Color changeable', 'Show a color picker in the designer (applies to untextured GLB models only).', false, 2, true, '2026-04-30T19:44:16.814771+00:00'),
  ('95c976aa-f2e4-455d-af06-866d1fe6e8dc', 'delete', 'Deletable', 'Show a Remove button when the element is selected.', true, 3, true, '2026-04-30T19:44:16.814771+00:00'),
  ('b4a2198b-96bc-4fe8-8688-8167008c5e49', 'move', 'Movable', 'Let the customer drag this decoration to a new spot on the cake. Untick to pin it where it is placed.', true, 4, true, '2026-08-09T08:32:59.014008+00:00')
ON CONFLICT (id) DO UPDATE SET
    key = EXCLUDED.key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    default_value = EXCLUDED.default_value,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    created_at = EXCLUDED.created_at;

-- dietary_requirements — 6 rows
INSERT INTO public.dietary_requirements (id, key, label, kind, sort_order, is_active, created_at) VALUES
  (1, 'eggless', 'Eggless', 'diet', 10, true, '2026-07-25T20:16:18.942278+00:00'),
  (2, 'vegan', 'Vegan', 'diet', 20, true, '2026-07-25T20:16:18.942278+00:00'),
  (3, 'jain', 'Jain', 'diet', 30, true, '2026-07-25T20:16:18.942278+00:00'),
  (4, 'nut_free', 'Nut-free', 'allergen', 40, true, '2026-07-25T20:16:18.942278+00:00'),
  (5, 'gluten_free', 'Gluten-free', 'allergen', 50, true, '2026-07-25T20:16:18.942278+00:00'),
  (6, 'dairy_free', 'Dairy-free', 'allergen', 60, true, '2026-07-25T20:16:18.942278+00:00')
ON CONFLICT (id) DO UPDATE SET
    key = EXCLUDED.key,
    label = EXCLUDED.label,
    kind = EXCLUDED.kind,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    created_at = EXCLUDED.created_at;

-- notification_types — 21 rows
INSERT INTO public.notification_types (id, slug, label, audience) VALUES
  (11, 'subscription_activated', 'Subscription activated — baker', 'baker'),
  (12, 'subscription_renewed', 'Subscription renewed (payment received) — baker', 'baker'),
  (13, 'payment_failed', 'Subscription payment failed / action needed — baker', 'baker'),
  (14, 'subscription_cancelled', 'Subscription cancelled (access until period end) — baker', 'baker'),
  (15, 'subscription_expired', 'Subscription ended / lapsed — baker', 'baker'),
  (16, 'baker_welcome', 'Baker welcome / onboarding kit — post-confirmation', 'baker'),
  (17, 'account_erasure_notice', 'Account erasure — 48h notice', 'baker'),
  (18, 'credits_purchased', 'AI credits — purchase receipt', 'baker'),
  (19, 'credits_low', 'AI credits — running low', 'baker'),
  (20, 'credits_exhausted', 'AI credits — monthly allowance used up', 'baker'),
  (2, 'order_placed_customer', 'Order placed — customer confirmation', 'customer'),
  (3, 'design_updated_customer', 'Design updated by baker — customer notification', 'customer'),
  (5, 'quote_issued_customer', 'Quote issued — customer notification', 'customer'),
  (6, 'order_confirmed_customer', 'Order confirmed — customer notification', 'customer'),
  (9, 'order_completed_customer', 'Order completed — customer thank-you', 'customer'),
  (10, 'order_ready_customer', 'Order ready for pickup/delivery — customer notification', 'customer'),
  (1, 'order_placed_baker', 'Order placed — baker notification', 'baker'),
  (4, 'quote_accepted_baker', 'Quote accepted — baker notification', 'baker'),
  (7, 'quote_question_baker', 'Customer question on the quote — baker notification', 'baker'),
  (21, 'delivery_digest_baker', 'Deliveries due today — baker morning digest', 'baker'),
  (8, 'customer_invite', 'Customer invited to design session', 'customer')
ON CONFLICT (id) DO UPDATE SET
    slug = EXCLUDED.slug,
    label = EXCLUDED.label,
    audience = EXCLUDED.audience;

-- subscription_statuses — 6 rows
INSERT INTO public.subscription_statuses (id, name, label, description, sort_order) VALUES
  (1, 'active', 'Active', 'Subscription is current and paid — renew next 
  cycle', 0),
  (2, 'pending', 'Pending', 'Payment initiated, awaiting confirmation', 1),
  (3, 'paused', 'Paused', 'Subscription temporarily paused — do not charge
  next cycle', 2),
  (4, 'past_due', 'Past Due', 'Payment failed, grace period active', 3),
  (5, 'expired', 'Expired', 'Subscription period ended without renewal', 4),
  (6, 'cancelled', 'Cancelled', 'Baker cancelled — access valid till end_date, 
  stop next charge', 5)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order;

-- payment_providers — 2 rows
INSERT INTO public.payment_providers (id, name, display_name, supported_currencies, is_active, created_at) VALUES
  ('b8af2b68-6900-4cd4-8653-ec03ec543643', 'razorpay', 'Razorpay', ARRAY['INR']::text[], true, '2026-05-29T09:40:49.084539+00:00'),
  ('3cd1f242-4e39-4ef8-934c-6e5eb8119840', 'stripe', 'Stripe', ARRAY['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD']::text[], true, '2026-05-29T09:40:49.084539+00:00')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    display_name = EXCLUDED.display_name,
    supported_currencies = EXCLUDED.supported_currencies,
    is_active = EXCLUDED.is_active,
    created_at = EXCLUDED.created_at;

-- billing_periods — 3 rows
INSERT INTO public.billing_periods (id, name, display_name, months, discount_pct, is_active, sort_order, created_at) VALUES
  (1, 'monthly', 'Monthly', 1, 0, true, 0, '2026-05-29T16:58:43.124059+00:00'),
  (3, 'yearly', 'Yearly', 12, 17, true, 2, '2026-05-29T16:58:43.124059+00:00'),
  (2, 'quarterly', 'Quarterly', 3, 10, false, 1, '2026-05-29T16:58:43.124059+00:00')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    display_name = EXCLUDED.display_name,
    months = EXCLUDED.months,
    discount_pct = EXCLUDED.discount_pct,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at;

-- subscription_plans — 4 rows
INSERT INTO public.subscription_plans (id, name, display_name, price_monthly, price_yearly, features, is_active, sort_order, created_at, tagline, feature_bullets, is_popular, has_storefront) VALUES
  (1, 'spark', 'Spark', 0, 0, '{"storefront":true,"trial_days":30,"xray_reports":true,"premium_themes":false,"can_buy_credits":false,"custom_branding":true,"custom_templates":true,"max_orders_total":null,"max_team_members":2,"edible_print_studio":false,"max_saved_templates":30,"ai_credits_per_month":200,"ai_background_removal":false,"whatsapp_notifications":false}'::jsonb, true, 0, '2026-05-29T16:58:06.572298+00:00', 'Everything, free for 30 days', ARRAY['Your storefront + 3D designer', 'Unlimited orders and quotes', 'Flavour suggestions for your customers', '200 smart-tool credits', '30 days — then choose a plan']::text[], false, true),
  (2, 'flame', 'Flame', 99900, 999900, '{"storefront":true,"xray_reports":true,"premium_themes":false,"can_buy_credits":false,"custom_branding":true,"custom_templates":true,"max_orders_total":null,"max_team_members":2,"edible_print_studio":false,"max_saved_templates":30,"ai_credits_per_month":300,"ai_background_removal":false,"whatsapp_notifications":false}'::jsonb, true, 1, '2026-05-29T16:58:06.572298+00:00', 'Less than the price of one cake', ARRAY['Everything in Spark, with no time limit', '300 smart-tool credits a month', 'Email support']::text[], false, true),
  (3, 'blaze', 'Blaze', 249900, 2499900, '{"storefront":true,"trial_days":30,"xray_reports":true,"premium_themes":true,"can_buy_credits":true,"custom_branding":true,"custom_templates":true,"max_orders_total":null,"max_team_members":4,"edible_print_studio":true,"max_custom_elements":0,"max_saved_templates":null,"ai_credits_per_month":800,"ai_background_removal":true,"whatsapp_notifications":false}'::jsonb, true, 2, '2026-05-29T16:58:06.572298+00:00', 'More credits, more tools, faster help', ARRAY['Everything in Flame', '800 smart-tool credits a month', 'Buy extra credits when you need them', 'Unlimited saved templates', 'Premium storefront themes', 'Edible Print Studio — any image, not just order photos', 'Priority chat support']::text[], true, true),
  (4, 'forge', 'Forge', 499900, 4999900, '{"storefront":true,"trial_days":30,"xray_reports":true,"premium_themes":true,"can_buy_credits":true,"custom_branding":true,"custom_templates":true,"max_orders_total":null,"max_team_members":10,"edible_print_studio":true,"max_custom_elements":0,"max_saved_templates":null,"ai_credits_per_month":2000,"ai_background_removal":true,"whatsapp_notifications":false}'::jsonb, false, 3, '2026-05-29T16:58:06.572298+00:00', 'The most credits, and someone to call', ARRAY['Everything in Blaze', '2,000 smart-tool credits a month', 'Dedicated account manager']::text[], false, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    display_name = EXCLUDED.display_name,
    price_monthly = EXCLUDED.price_monthly,
    price_yearly = EXCLUDED.price_yearly,
    features = EXCLUDED.features,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at,
    tagline = EXCLUDED.tagline,
    feature_bullets = EXCLUDED.feature_bullets,
    is_popular = EXCLUDED.is_popular,
    has_storefront = EXCLUDED.has_storefront;

-- cancellation_reasons — 10 rows
INSERT INTO public.cancellation_reasons (id, key, display_name, is_customer_selectable, is_active, sort_order, created_at) VALUES
  (1, 'upgrade', 'Upgraded plan', false, true, 0, '2026-07-02T11:39:09.727136+00:00'),
  (2, 'downgrade', 'Downgraded plan', false, true, 1, '2026-07-02T11:39:09.727136+00:00'),
  (3, 'admin_external', 'Cancelled by support', false, true, 2, '2026-07-02T11:39:09.727136+00:00'),
  (4, 'completed', 'Term completed', false, true, 3, '2026-07-02T11:39:09.727136+00:00'),
  (5, 'customer_requested', 'Cancelled (no reason given)', false, true, 4, '2026-07-02T11:39:09.727136+00:00'),
  (10, 'too_expensive', 'Too expensive', true, true, 10, '2026-07-02T11:39:09.727136+00:00'),
  (11, 'not_using', 'Not using it enough', true, true, 11, '2026-07-02T11:39:09.727136+00:00'),
  (12, 'missing_features', 'Missing features I need', true, true, 12, '2026-07-02T11:39:09.727136+00:00'),
  (13, 'switching', 'Switching to another tool', true, true, 13, '2026-07-02T11:39:09.727136+00:00'),
  (14, 'other', 'Other', true, true, 14, '2026-07-02T11:39:09.727136+00:00')
ON CONFLICT (id) DO UPDATE SET
    key = EXCLUDED.key,
    display_name = EXCLUDED.display_name,
    is_customer_selectable = EXCLUDED.is_customer_selectable,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    created_at = EXCLUDED.created_at;

-- credit_costs — 5 rows
INSERT INTO public.credit_costs (id, action_key, credits, label, is_active, updated_at) VALUES
  (2, 'photo_to_cake_design', 20, 'Cake design', false, '2026-07-30T11:36:22.850035+00:00'),
  (3, 'enquiry_to_draft_order', 2, 'Draft order', false, '2026-07-30T11:36:22.850035+00:00'),
  (4, 'sticker_generate', 60, 'Decoration', false, '2026-07-30T11:36:22.850035+00:00'),
  (1, 'photo_to_xray_estimate', 15, 'X-Ray — read a cake photo', true, '2026-07-31T19:31:11.314091+00:00'),
  (9, 'element_build_guide', 20, 'X-Ray — how to make a decoration', true, '2026-07-31T19:31:11.314091+00:00')
ON CONFLICT (id) DO UPDATE SET
    action_key = EXCLUDED.action_key,
    credits = EXCLUDED.credits,
    label = EXCLUDED.label,
    is_active = EXCLUDED.is_active,
    updated_at = EXCLUDED.updated_at;

-- credit_packs — 3 rows
INSERT INTO public.credit_packs (id, pack_key, credits, price_paise, label, is_active, sort_order, updated_at) VALUES
  (1, 'topup_150', 150, 14900, 'Small top-up', true, 1, '2026-07-29T09:29:52.691054+00:00'),
  (2, 'topup_400', 400, 34900, 'Medium top-up', true, 2, '2026-07-29T09:29:52.691054+00:00'),
  (3, 'topup_1000', 1000, 79900, 'Large top-up', true, 3, '2026-07-29T09:29:52.691054+00:00')
ON CONFLICT (id) DO UPDATE SET
    pack_key = EXCLUDED.pack_key,
    credits = EXCLUDED.credits,
    price_paise = EXCLUDED.price_paise,
    label = EXCLUDED.label,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    updated_at = EXCLUDED.updated_at;

-- storefront_themes — 3 rows
INSERT INTO public.storefront_themes (id, key, name, description, is_active, sort_order, is_premium) VALUES
  (1, 'spotlight', 'Spotlight', 'A dramatic dark hero with a spotlit, rotating 3D cake. Bold and modern.', true, 1, false),
  (3, 'aurora', 'Aurora', 'Soft, airy and colourful — a bright, welcoming storefront.', true, 3, false),
  (2, 'patisserie', 'Patisserie', 'Hand-drawn ink and watercolour: your shopfront, sketched around your name, with a window of cakes and scalloped edges throughout.', true, 2, true)
ON CONFLICT (id) DO UPDATE SET
    key = EXCLUDED.key,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    is_premium = EXCLUDED.is_premium;

-- ── Sequence resync — 5 tables with serial/identity ids ──
-- Seeded with explicit ids, which does NOT advance the sequence. Without this the next row
-- the app inserts collides on the primary key — months later, from the admin UI, for no
-- visible reason.

select setval(pg_get_serial_sequence('public.order_statuses', 'id'), coalesce((select max(id) from public.order_statuses), 1));
select setval(pg_get_serial_sequence('public.dietary_requirements', 'id'), coalesce((select max(id) from public.dietary_requirements), 1));
select setval(pg_get_serial_sequence('public.notification_types', 'id'), coalesce((select max(id) from public.notification_types), 1));
select setval(pg_get_serial_sequence('public.credit_costs', 'id'), coalesce((select max(id) from public.credit_costs), 1));
select setval(pg_get_serial_sequence('public.credit_packs', 'id'), coalesce((select max(id) from public.credit_packs), 1));

COMMIT;
