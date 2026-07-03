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
### 🔴 DECISIVE FINDING: Approach A (update subscription) is BLOCKED for UPI
Updating an active **UPI-mandate** subscription is rejected: `400 subscriptions cannot be updated when payment
mode is upi`. UPI Autopay mandates are locked to a fixed max amount, so a plan (amount) change isn't allowed.
Since **UPI is the majority payment method in India (our market)**, the elegant single-subscription
`update()` + `schedule_change_at` model is NOT usable in general — it would only work for CARD mandates.
→ **Adopt the corrected recreate model (was "Approach B") as the PRIMARY design.** `update()` stays a possible
card-only optimization, deferred (not worth the up-front branching for v1).

### Confirmed API surface (useful either way)
- `update(id, { plan_id, schedule_change_at:'now'|'cycle_end' })`, `pendingUpdate(id)`,
  `cancelScheduledChanges(id)` all exist — but see the UPI block above. Update also requires the sub be
  Active/Authenticated (a freshly `created` sub is rejected).
- **`create({ …, start_at })`** — first charge can be DEFERRED to a future Unix ts (e.g. `current_period_end`).
- **`cancel(id, true)`** — cancel **at cycle end** (keep access until the current period ends).
- Active sub exposes `plan_id`, `current_start`/`current_end` (monthly), `charge_at`, `remaining_count`,
  `has_scheduled_changes`, `payment_method`.
- Inherent to Razorpay: a NEW subscription needs the customer to authorize a **new mandate** (Checkout). So any
  recreate-based change requires re-authorization — this is already how today's flow behaves (Checkout per change).

### Still to verify on a live sub (lower priority now)
Proration is largely moot under recreate (see below). Remaining: exactly which webhook/timing fires when a
deferred (`start_at`) new sub activates + first-charges at cycle end — validate during build against test mode.

## Mechanism — RESOLVED: recreate with correct timing (UPI-compatible)
Phase 0 killed the `update()` model for UPI. The primary design is recreate-based, built on `start_at`
(defer first charge) + `cancel(id, cycle_end)` (keep access to period end). A new mandate authorization
(Checkout) is required per change — unchanged from today's behaviour.

## Schema (additive, one migration)
```sql
ALTER TABLE baker_subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_plan_id      int REFERENCES subscription_plans(id),
  ADD COLUMN IF NOT EXISTS scheduled_effective_at timestamptz;   -- = current_period_end at schedule time
```
- On the ACTIVE row only: a pending downgrade to `scheduled_plan_id`, effective `scheduled_effective_at`.
- NULL = no pending change (today's behaviour). Compact surrogate FK to the bounded plan lookup.
- No row churn: a plan change now UPDATES the active row / schedules on it, instead of superseding it.

## Flow — `POST /billing/subscribe` (rework, recreate model)
Resolve `current` (active row + `billing_subscription_id`) and `target` plan; direction by explicit rank.
Every change creates a NEW Razorpay sub the baker authorizes via Checkout; the difference is TIMING.

**Upgrade (target rank > current rank) — immediate:**
1. Create the new (higher) sub starting now; open Checkout → baker authorizes → first charge now.
2. On activation webhook: cancel the OLD sub immediately, mark it superseded, promote the new row to ACTIVE.
3. Proration: with recreate there's no native proration. v1 = charge the full new tier now, old tier's unused
   remainder is forfeited (simplest, and a fair-value story since they get the higher tier immediately). A
   goodwill credit (addon/discount for the unused days) is a possible v2.

**Downgrade (target rank < current rank) — deferred to cycle end, NO immediate charge.**
A downgrade is a NEW (lower) UPI mandate the baker must authorize — Razorpay allows a new mandate at a new
amount; it only forbids editing the *existing* mandate. So order the steps so the baker can never be left
without a subscription:
1. Create the new (lower) sub with `start_at = current_period_end` (first charge deferred to the next cycle);
   open Checkout → baker authorizes the new mandate NOW (no charge yet). Park it as PENDING; DO NOT touch the
   current sub yet.
2. **Only after the new mandate is AUTHORIZED (activation webhook confirms it) →** flag the current (higher)
   sub `cancel(currentSub, cycle_end)` so access stays to `current_period_end`, and record the pending change
   on the current row: `scheduled_plan_id = target`, `scheduled_effective_at = current_period_end`, + stash the
   parked sub id.
3. If the baker **abandons** the Checkout (mandate never authorized) → do NOTHING: the current sub renews on the
   current plan as usual. No lapse, no half-state. (Sweep/expire the orphan parked sub.)
4. At cycle end: the current sub ends; the parked lower sub activates + first-charges → its
   `subscription.activated/charged` webhook promotes it to ACTIVE, applies the plan, clears `scheduled_*`.
5. Baker keeps the higher tier they paid for until period end; no double charge.

> ⚠️ **Sequencing rule (the whole point):** authorize the new lower mandate FIRST; cancel-at-cycle-end the old
> one ONLY after that authorization is confirmed. Cancelling first would strand the baker with nothing if the
> new mandate is never approved.

**Cancel a scheduled downgrade** (before cycle end): cancel the parked new sub, clear `scheduled_*`, and undo
`cancel_at_cycle_end` on the current sub (Razorpay `resume`/re-flag) so it renews on the current plan. A
subsequent **upgrade** supersedes the scheduled downgrade (upgrade-now wins).

UX note: this needs a second Checkout at downgrade time (the new mandate). Acceptable because UPI has no silent
plan change. Alternative (decide in build): prompt the downgrade Checkout via a reminder near cycle end instead
of at request time — lighter UX, but risks the baker not completing it (they then just renew on the higher plan).

## ⚠️ REQUIRED webhook event — enable `subscription.authenticated`
The deferred downgrade depends on `subscription.authenticated` (fires when the parked lower mandate is
authorized) to schedule the old sub's cancel-at-cycle-end. It was NOT in the dev webhook's event list
(validated 2026-07-03: parked sub reached `authenticated`, but Blaze stayed uncancelled) → **add
`subscription.authenticated` to every Razorpay webhook (dashboard, dev + prod).** Without it the old
(higher) sub can RENEW at cycle end before promotion cancels it → wrong/double charge. Follow-up: a
reconcile backstop that catches "parked sub authenticated but old sub not cancel-at-cycle-end".

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

## Open decisions for Sandeep (post-spike)
1. **Upgrade proration:** under recreate there's no native proration. OK with v1 = charge full new tier now,
   forfeit the old tier's unused days (simplest)? Or invest in a goodwill credit (addon/discount)?
2. **Downgrade re-auth UX:** the deferred downgrade needs the baker to authorize the new (lower) mandate via a
   second Checkout. Authorize **at downgrade time** (parked sub, `start_at`=cycle end) or **prompt near cycle
   end**? Former is cleaner state; latter is lighter UX but risks lapse if they don't complete it.
3. Refunds on downgrade: confirmed **none** (baker consumes the paid higher tier to cycle end). OK?
4. (Deferred) Card-only `update()` optimization — skip for v1, revisit if card share grows.
