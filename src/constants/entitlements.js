// Entitlement registry — DEFINITIONS only (plan-agnostic). The actual per-plan
// VALUES live as data on the plan row (subscription_plans.features jsonb), so the
// resolver never branches on plan name/rank and renaming/restructuring plans needs
// no code change. `fallback` is the conservative value used when a plan hasn't set
// a key yet, and the value an inactive subscription collapses to.
//   bool → false (locked) | int → a safe floor (0 = none, 1 = the minimum)
// null in a plan's features means "unlimited" for an int key (see resolver).
// `label` is the human name shown in the admin plan editor (registry-driven form).
export const ENTITLEMENTS = {
  // booleans
  storefront:             { type: 'bool', fallback: false, label: 'Public storefront' },                       // {slug}.spattoo.com — now ON for all tiers
  custom_branding:        { type: 'bool', fallback: false, label: 'Custom branding (logo/colours/story)' },     // now ON for all tiers
  custom_templates:       { type: 'bool', fallback: false, label: 'Custom templates (deprecated)' },            // superseded by max_saved_templates; inert
  ai_background_removal:  { type: 'bool', fallback: false, label: 'AI background removal' },
  whatsapp_notifications: { type: 'bool', fallback: false, label: 'WhatsApp notifications (deferred)' },        // #20 — off all tiers; inert
  xray_reports:           { type: 'bool', fallback: false, label: 'X-Ray reports' },
  // Chef's Desk → Edible Print Studio: lay a baker's OWN images out on a to-scale A4 and export a
  // print-ready PDF. Blaze+.
  //
  // Gates the STANDALONE tool only. The same sheet reached from an order stays on every plan, and
  // that is deliberate rather than an oversight: printing a photo a customer attached is part of
  // fulfilling an order they have already paid for, and taking it away would withhold work in
  // progress. What Blaze buys is printing things NO order asked for — a name, a logo, a sheet of
  // roses — which is a bakery's own productivity, not a customer's order.
  edible_print_studio:    { type: 'bool', fallback: false, label: 'Edible Print Studio' },
  // Reel capture: film the cake turning and download it at 1080×1920, ready to post.
  // See spattoo-docs/plans/reel-for-bakers.md.
  //
  // TWO keys, not one, because "may record" and "whose name is on it" are different questions and a
  // plan row should say exactly what the customer gets.
  //
  // ⚠️ reel_capture is ON FOR EVERY PAID TIER, deliberately — including Spark and Flame. It costs
  // nothing to give away: recording runs entirely on the baker's device (their GPU renders it, their
  // hardware encoder writes the MP4, the file lands in their downloads) with no upload, transcode,
  // storage or queue. And a locked feature generates no awareness while a watermarked one markets us
  // every time it is posted. It still collapses to false on a LAPSED subscription, like everything
  // else — that is the fallback doing its job.
  reel_capture:           { type: 'bool', fallback: false, label: 'Record a reel of a cake' },
  // Whose name the reel carries. TRUE → the bakery's own. FALSE → a small "made with Spattoo".
  // This is the Blaze lever, and the upgrade reads as "take our name off your marketing".
  //
  // ⚠️ ADVISORY, not enforced. Every other entitlement is backed by requireEntitlement on a route;
  // this one has no route to guard, because the whole feature is client-side. Somebody who edits the
  // response in devtools gets an unbranded reel — which is a thing they could also achieve by
  // cropping the video, so there is nothing here worth defending server-side. Do not let a later
  // reader mistake the absence of middleware for an oversight.
  reel_branding:          { type: 'bool', fallback: false, label: 'Reels carry the bakery\'s own name' },
  /* Film the cake ASSEMBLING ITSELF — every decoration flying in and landing in its own place — and
     save the result. Blaze+. See spattoo-docs/features/reel-capture.md.
     ⚠️ DELIBERATELY NOT THE SAME BARGAIN AS `reel_capture`, and the contrast is the point. A reel is
     given to every paid tier because a watermarked one markets us every time it is posted, and
     because a locked feature generates no awareness. This one has no watermark rung: Sandeep,
     asking for it, *"we have watermark optio for reel capture. but this one strictly for blaze."*
     It is the showpiece — the thing a baker shows a customer to explain what the studio does — so
     it is what the tier is FOR rather than a sample of it.
     ⚠️ ADVISORY, LIKE `reel_branding`, AND FOR THE SAME REASON. There is no route to guard: the
     build runs on the baker's own GPU and the MP4 is written by their own encoder, with nothing
     uploaded. Hiding the button is the whole enforcement, exactly as it is for reel branding. Do
     not let a later reader mistake the absence of middleware for an oversight. */
  build_film:             { type: 'bool', fallback: false, label: 'Film the cake assembling itself' },
  // Storefront themes marked is_premium. Blaze+. Gates CHOOSING one, never RENDERING one: a
  // shop already published on a theme keeps working if that theme is later re-priced, because
  // taking away somebody's live storefront is not a thing a price change should do.
  //
  // The theme says what KIND it is (storefront_themes.is_premium) and the plan says who may
  // have that kind. Keeping the tier ladder out of the themes table means a plan can be
  // renamed or re-ranked without touching a theme.
  premium_themes:         { type: 'bool', fallback: false, label: 'Premium storefront themes' },
  /* How the baker's own rail looks (rail_skins, migration 120). Blaze+.
     ⚠️ BAKER-FACING ONLY, which is why it can be resolved at RENDER where premium_themes could not
     be for months: nothing a CUSTOMER sees depends on it, so a downgrade changing it takes nothing
     away from anybody but the person who chose it. lib/railSkin.js does the resolving and the
     choice is never cleared, so it returns on re-subscribe.
     Not sold on any plan page — a delight a Blaze baker finds, not a reason to upgrade. Adding a
     bullet for it means adding the same bullet to marketing's Pricing.tsx, or check:plan-copy
     fails; the two surfaces agreeing to say nothing is consistent. */
  rail_skins:             { type: 'bool', fallback: false, label: 'Choose how your menu bar looks' },
  /* Generate a 3D decoration from a description — the baker types what they want and a vendor
     (Tripo today) returns a coloured, ready-to-use model. Blaze and above, asked for as such:
     Sandeep: *"generating the 3d elements is allowed from blaze and above subscription only."*

     ⚠️ THIS ONE IS COST CONTROL, NOT PACKAGING, AND THAT MAKES IT UNLIKE EVERY OTHER FLAG HERE.
     `reel_capture`, `build_film` and `rail_skins` are all free to give away — they render on the
     baker's own GPU and we pay nothing per use, which is why two of them are allowed to be advisory
     and client-side. A generation spends real money at a vendor the moment the button is pressed,
     and there is no meter under it: `routes/ai3d.js` does not import `services/aiCredits.js`, so
     nothing reserves, counts or refuses. Until a credit action exists for it (AI_ACTION has no 3D
     key), THIS FLAG IS THE ONLY THING STANDING BETWEEN A SIGNED-IN BAKER AND OUR VENDOR BILL. So
     it is enforced server-side on the route, never only by hiding a button.

     ⚠️ fallback false IS LOAD-BEARING, for two separate reasons. A lapsed Blaze subscription
     collapses every key to its fallback, so it stops generating — correct, since the spending is
     ours. And an environment where migration 156 has not run yet grants this to NOBODY rather than
     to everybody, which is the right way round for a key with money behind it.

     ⚠️ IT GATES GENERATING, NEVER SEEING. A baker who drops to Flame keeps every model they already
     made and can still open it — same split as `premium_themes` (gates choosing a theme, never
     rendering one a shop already runs). Taking back work somebody already paid for is not a thing a
     price change should do. `lib/generate3d.js` holds both halves of that rule.

     ⚠️ STAFF DO NOT COME THROUGH HERE. An admin is a row in `admins`, never in `baker_appusers`, so
     ctxEntitlements resolves them to status 'no_baker' / active false — a bare requireEntitlement on
     the admin studio's route would 402 our own catalogue team. lib/generate3d.js keeps that
     asymmetry in one place instead of in each route that grows one. */
  generate_3d_decorations:{ type: 'bool', fallback: false, label: 'Generate 3D decorations with AI' },
  // numeric limits — null (in a plan's features) = unlimited
  max_team_members:       { type: 'int',  fallback: 1, label: 'Team members' },
  max_saved_templates:    { type: 'int',  fallback: 0, label: 'Saved templates (custom)' },                     // Spark 3 / Flame 30 / Blaze+ unlimited
  // "My Decorations" uploads. Counts BOTH the baker's shared library AND their customers' private
  // uploads (both sit in the baker's tenant).
  //
  // NOT a pricing lever — it is set to the SAME generous number on every plan, on purpose. Once
  // background removal is our own model rather than a metered vendor, an upload costs us essentially
  // nothing (R2 storage is ~$0.015/GB-month with zero egress; the inference is our own CPU on a box we
  // pay a flat rate for). Charging for something with no marginal cost is an arbitrary limit that only
  // generates support tickets.
  //
  // It exists as a CEILING: element:manage is granted to customers, so the upload endpoint is reachable
  // from a public storefront, and an unbounded write path is not something to discover after the fact.
  // A real baker will never approach it; a runaway client will. If it ever needs to become a tier lever,
  // the machinery is already here — change the numbers, no deploy.
  max_custom_elements:    { type: 'int',  fallback: 0, label: 'Own decorations (upload ceiling)' },
  // The monthly AI allowance, in credits, spent by the metered "smart tools" (#13) and X-Ray
  // for photo-only orders. THE one entitlement with real marginal cost behind it, which is why
  // it is also the thing that makes a 30-day Spark trial safe to give away: cost is bounded by
  // this number, not by how long the trial runs.
  //
  // Resets every calendar month, and that reset is DERIVED rather than granted — see
  // migrations/022_ai_credits_ledger.sql. Purchased top-ups are a separate pool that does not
  // reset. fallback 0 (the safe floor) means a lapsed subscription can spend nothing; null on a
  // plan means unlimited, per the int convention above.
  ai_credits_per_month:   { type: 'int',  fallback: 0, label: 'AI credits / month' },
  // One-time message credits, handed over when a subscription first becomes ACTIVE. The second
  // entitlement with real marginal cost behind it (WhatsApp is ₹0.145 a send), and the reason it is
  // an entitlement rather than a constant is the same as above: it is the number we will want to
  // move once conversion is visible, and moving it must not be a deploy.
  //
  // ⚠️ fallback 0 IS THE FEATURE, not a placeholder. Spark — the free tier — has no key, so it grants
  // nothing, and "we don't spend on trial bakers" is true because the data says so rather than
  // because a branch remembers to check the tier. A new tier that should give nothing needs no code.
  // Granted once per bakery, enforced by a partial unique index (migration 099), never by an `if`.
  welcome_message_credits:{ type: 'int',  fallback: 0, label: 'Welcome message credits (one-time)' },
  // Can this plan BUY more credits when the monthly allowance runs out?
  //
  // This is the Flame→Blaze lever, and it is the only thing that stops the two plans collapsing
  // into "same features, different amount of credits". Flame's wall is a real wall — the credits
  // refresh next month and that is the answer; Blaze's is a speed bump it can pay past. That
  // difference is felt only by bakers who actually run out, which is exactly the volume segment
  // Blaze is for, so the lever aims itself.
  //
  // It gates BUYING, never SPENDING. A Blaze baker who tops up and later downgrades keeps every
  // credit they paid for — those are prepaid money and they never expire. Confiscating them would
  // be a trust problem far more expensive than the leak it closes.
  //
  // NOT sufficient on its own: without the stock ceiling in services/aiCredits.js a Blaze baker
  // could buy a year of credits in one afternoon, downgrade to Flame, and run Blaze usage at
  // Flame's price. The flag says WHO may buy; the ceiling says WHEN.
  can_buy_credits:        { type: 'bool', fallback: false, label: 'Can buy AI credit top-ups' },
};

// Non-entitlement plan CONFIG that also lives in subscription_plans.features (read by
// provisioning, NOT by the entitlement resolver). Surfaced in the admin plan editor so it
// stays editable alongside entitlements.
export const PLAN_CONFIG = {
  trial_days: { type: 'int', fallback: 30, label: 'Spark trial (days)' },
};

// Flat, ordered schema for the admin plan editor — key/type/label/fallback per field,
// tagged by section. The form renders bool→checkbox, int→number+"unlimited". The registry
// is the single source of truth, so a new key here automatically grows a new form field.
export function planEditorSchema() {
  const fields = (obj, section) =>
    Object.entries(obj).map(([key, def]) => ({ key, type: def.type, label: def.label, fallback: def.fallback, section }));
  return { entitlements: fields(ENTITLEMENTS, 'entitlement'), config: fields(PLAN_CONFIG, 'config') };
}

// Subscription statuses that DENY access (the coarse gate). past_due / pending are
// intentionally NOT here — they're a grace/dunning window (mirrors the client
// paywall, which only blocks expired/cancelled/paused).
export const BLOCKED_STATUSES = new Set(['expired', 'cancelled', 'paused', 'no_subscription']);
