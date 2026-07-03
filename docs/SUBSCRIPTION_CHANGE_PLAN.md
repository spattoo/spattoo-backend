# Subscription Plan Changes — Upgrade Now / Downgrade at Cycle End

Status: PLANNING. Reworks how `POST /billing/subscribe` handles a plan change for a baker who is
ALREADY on a paid subscription. New signups and resubscribe-after-cancel are unchanged. Relates to
`spattoo-core/docs/SUBSCRIPTION_TIERS.md`; implementation lives entirely in `spattoo-api` (`billing.js`
+ one migration + webhook).

## Problem (validated 2026-07-03)
Every plan change — up OR down — currently does the same thing in `billing.js`:
1. `razorpayCancelSubscription(oldSubId, false)` — cancels the current Razorpay sub **immediately**.
2. `razorpayCreateSubscription(newPlan)` — a **brand-new** subscription.
3. `closeSupersededSubscriptions()` → old rows CANCELLED(6); new row PENDING(2) → Checkout → webhook → ACTIVE(1).

For a **downgrade** this is wrong: the baker **loses the unused portion of the higher tier they already
paid for** AND is **charged again immediately** on a fresh cycle. (Repro: Spark→Flame→Blaze→Flame made 3
Razorpay subs + 3 charges in 7 minutes; the final Flame started a new 07-03→08-02 period.) The code already
flags this — `closeSupersededSubscriptions` notes the deferred-downgrade path is not yet built.

## Target policy
- **Upgrade → immediate** (baker wants more now). Applied at once; charge the prorated difference for the
  remainder of the current cycle.
- **Downgrade → deferred to period end.** Baker keeps the higher tier until `current_period_end`, then drops
  to the lower tier at the next renewal. **No refund, no immediate re-charge.** UI: "Blaze until 2 Aug, then Flame."
- **Same/no-op** → reject.
- Direction is decided by an explicit tier **rank**, NOT `plan_id` ordering (don't assume 1<2<3 forever) — add/
  use a `rank`/`level` on `subscription_plans` (or the tier registry) as the single source of ordering.

## Phase 0 — SPIKE RESULTS (razorpay-node 2.9.6, test mode, 2026-07-03)
CONFIRMED (API surface + constraints) — **Approach A is viable**:
- SDK exposes `subscriptions.update(id, { plan_id, schedule_change_at:'now'|'cycle_end' })` — `plan_id` is an
  updatable field; `now`=immediate, `cycle_end`=at end of current billing cycle. Also `pendingUpdate(id)`
  (GET retrieve_scheduled_changes) to READ a scheduled change, and `cancelScheduledChanges(id)` to REVERT one.
- **Hard constraint:** the sub must be in **Authenticated or Active** state to be updated — a freshly `created`
  (un-authorized) sub is rejected (`400 Can't update subscription when subscription is not in Authenticated or
  Active state`). So plan changes only apply to a live sub (fine — our changes always target an active baker).
- Active sub exposes the fields we rely on: `plan_id`, `current_start`/`current_end` (monthly), `charge_at`,
  `remaining_count`, `has_scheduled_changes`, `change_scheduled_at`.

STILL PENDING (behavioral — needs an ACTIVE sub; can only be a live one): (1) proration mechanics on
`schedule_change_at:'now'` (immediate prorated charge vs. addon on next invoice); (2) that `cycle_end` scheduling
sets `has_scheduled_changes` + is readable via `pendingUpdate` + revertible via `cancelScheduledChanges`
(reversible/no-charge — safe to test); (3) which webhook fires when a scheduled change APPLIES at cycle end.

## Phase 0 — SPIKE (decide the mechanism before building)
Validate in Razorpay **test mode** whether **Update Subscription** (`PATCH /subscriptions/{id}`) supports what
we need, because Razorpay's proration/plan-change is less automatic than Stripe:
1. Change `plan_id` on a running subscription with `schedule_change_at: 'now'` — does it apply immediately and
   how is the delta charged (addon on next invoice vs. immediate prorated charge)?
2. Change `plan_id` with `schedule_change_at: 'cycle_end'` — does the plan swap at the next cycle with the same
   subscription id and no immediate charge?
3. Constraint check: both plans must share the billing interval (monthly↔monthly ✓); confirm allowed states.
4. Which webhook events fire (`subscription.updated`, `subscription.charged`) and what `sub.plan_id`/period they carry.

Outcome picks the approach:
- **Approach A (preferred) — Razorpay Update Subscription.** One persistent subscription id across up/down
  changes; Razorpay owns proration + cycle-end timing. Far less churn than cancel+recreate.
- **Approach B (fallback, if A is too limited).** Keep the current sub running to `current_period_end`; at cycle
  end, cancel it + create the new-plan sub. Deferral driven by a **BullMQ repeatable reconcile job** (NOT a
  timer) that promotes due scheduled changes, with the webhook as the primary trigger. More moving parts.

The rest of this plan is written for **Approach A**; Approach B reuses the same schema + UI, differing only in
the Razorpay calls and adding the promote-at-cycle-end job.

## Schema (additive, one migration)
```sql
ALTER TABLE baker_subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_plan_id      int REFERENCES subscription_plans(id),
  ADD COLUMN IF NOT EXISTS scheduled_effective_at timestamptz;   -- = current_period_end at schedule time
```
- On the ACTIVE row only: a pending downgrade to `scheduled_plan_id`, effective `scheduled_effective_at`.
- NULL = no pending change (today's behaviour). Compact surrogate FK to the bounded plan lookup.
- No row churn: a plan change now UPDATES the active row / schedules on it, instead of superseding it.

## Flow — `POST /billing/subscribe` (rework)
Resolve `current` (active row + `billing_subscription_id`) and `target` plan; compute direction by rank.

**Upgrade (target rank > current rank):**
1. Razorpay: update subscription → target `plan_id`, `schedule_change_at: 'now'`.
2. DB: keep the same row + `billing_subscription_id`; set `plan_id = target`, clear any `scheduled_*`.
   (Status stays ACTIVE; if Razorpay requires a re-auth/charge, park the delta and let the webhook confirm —
   mirror today's PENDING→webhook only if a fresh authorization is actually required.)
3. Audit: `changeType: 'upgraded'`.

**Downgrade (target rank < current rank):**
1. Razorpay: update subscription → target `plan_id`, `schedule_change_at: 'cycle_end'`.
2. DB: DO NOT change `plan_id` now. Set `scheduled_plan_id = target`, `scheduled_effective_at = current_period_end`.
3. Baker keeps the current (higher) tier + all its access until `current_period_end`.
4. Audit: `changeType: 'downgrade_scheduled'`.

**Cancel a scheduled downgrade** (baker changes their mind before cycle end): Razorpay update back to the
current plan (or cancel the scheduled change); clear `scheduled_*`. A subsequent **upgrade** implicitly clears
the scheduled downgrade (upgrade-now wins).

## Webhook — `POST /billing/webhook` additions
- `subscription.charged` at cycle end: if the row has a `scheduled_plan_id` and Razorpay now reports the new
  `sub.plan_id`, **apply** the scheduled change → `plan_id = scheduled_plan_id`, clear `scheduled_*`, refresh
  `current_period_start/end/end_date` from `sub.current_start/current_end` (existing code path). Emit a
  `downgrade_applied` audit event + fire the plan-change notification.
- `subscription.updated` (if Razorpay sends it on schedule): reconcile our `plan_id`/`scheduled_*` to match
  Razorpay's `plan_id` + `has_scheduled_changes`, so Razorpay stays the source of truth.
- Keep the existing activated/charged/cancelled mapping; the scheduled-change apply is layered on `charged`.

## Consumer / UI (`get_baker_subscription` view + billing screen)
- Expose `scheduled_plan_id` + `scheduled_effective_at` (+ the plan name) from the view.
- Billing screen: when a downgrade is scheduled, show "Blaze until 2 Aug, then Flame" and a "Keep Blaze / cancel
  the change" action. Feature-gating stays on the CURRENT `plan_id` until the change applies.

## Edge cases
- Downgrade → upgrade before cycle end: upgrade-now clears the scheduled downgrade, applies immediately.
- Downgrade → change the downgrade target: overwrite `scheduled_plan_id` + re-issue the Razorpay schedule.
- Downgrade → cancel subscription: cancel wins (existing immediate-cancel flow); clear `scheduled_*`.
- Failed proration charge on upgrade: treat like any failed subscription charge (past_due path); don't leave a
  half-applied plan.
- Idempotency: the scheduled-apply on `subscription.charged` must be a no-op if already applied (guard on
  `scheduled_plan_id IS NOT NULL`), since Razorpay retries webhooks.

## What this removes / simplifies
- No more cancel-immediate + create-new + supersede on every plan change → stable `billing_subscription_id`,
  no 3-subs-in-7-minutes churn, no double-charge on downgrade.
- `closeSupersededSubscriptions` is reserved for true resubscribe-after-cancel, not plan changes.

## Open decisions for Sandeep
1. **Proration on upgrade:** charge the prorated difference now (fairest) vs. apply the upgrade now but bill the
   new rate only from next cycle (simpler, slightly generous)? Depends partly on Phase-0 findings.
2. **Approach A vs B** — pending the Phase-0 spike result.
3. Refunds on downgrade: confirmed **none** (baker consumes the paid higher tier to cycle end). OK?
