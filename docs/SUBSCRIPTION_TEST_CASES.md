# Subscription Flows — Test Cases & Expected State

Traces every subscription flow across the four surfaces: **`baker_subscriptions`** (rows/fields),
**Razorpay** (subscription status), **Billing screen** (what the baker sees), **`subscription_events`**
(history rows). Built from the recreate-based model in `SUBSCRIPTION_CHANGE_PLAN.md`.

## Reference
- **`baker_subscriptions.status_id`**: 1 active · 2 pending · 3 paused · 4 past_due · 5 expired · 6 cancelled.
- **`cancellation_reason_id`**: 1 upgrade · 2 downgrade · 3 admin_external · 4 completed · 5 customer_requested.
- **`subscription_events.changed_by`**: `system` (provisioning/reconcile) · `razorpay` (webhook) · `baker` (/billing/cancel).
- **Access truth** = `current_period_end` (grace rule): a row stays `status_id=1` and access is granted while
  `now() < current_period_end`, even after the Razorpay sub is cancelled.
- **Plan ranks** (sort_order): spark 0 · flame 1 · blaze 2 · forge 3. Upgrade = higher rank, downgrade = lower.

---

## 0. Precondition — fresh baker (on Spark)
`bakerProvisioning` on signup:
- **baker_subscriptions**: 1 row → `plan_id=1 (spark)`, `status_id=1 (active)`, `billing_subscription_id=NULL`, `end_date=trial end`.
- **bakers**: `subscription_plan_id=1`, `subscription_status_id=1`.
- **Razorpay**: none (Spark is free).
- **Billing screen**: "Spark" current; paid tiers offered as upgrades; Spark NOT a selectable card.
- **subscription_events**: `activated / spark / system`.

---

## 1. Fresh subscribe — Spark → Flame

| Step | baker_subscriptions | Razorpay | Billing screen | subscription_events |
|---|---|---|---|---|
| **1a. Click Upgrade → Flame** (`POST /billing/subscribe`) | Spark row → `status_id=6`, `cancellation_reason_id=1`, `end_date=today`. **NEW Flame row**: `status_id=2 (pending)`, `plan_id=2`, `billing_subscription_id=<flameSub>`. bakers → billing_subscription_id=flameSub, status pending. | Flame sub **created** → Checkout opens. | Still Spark until Checkout done. | — |
| **1b. Complete Checkout** (authorize + first charge) | Flame row `status_id=2→1`, `current_period_start/end`, `end_date` set. | Flame → **authenticated → active** (paid_count 1, ₹999 charged). | **"Flame — Current Plan"**, Renews `<date>`. Payments tab: ₹999. | `subscribed / flame / razorpay` |
| **1b′. Abandon Checkout** | Flame row stays `pending`; Spark row already cancelled → baker has no active paid row. | Flame stays **created** (never charges). | Shows pending/limbo until it lapses. *(known upgrade-path limitation)* | — |

---

## 2. Upgrade — Flame → Blaze (immediate)

| Step | baker_subscriptions | Razorpay | Billing screen | subscription_events |
|---|---|---|---|---|
| **2a. Click Upgrade → Blaze** | Flame row → `status_id=6`, `reason=1`, `end_date=today`. **NEW Blaze row**: `status_id=2`, `plan_id=3`, `billing_subscription_id=<blazeSub>`. bakers → blazeSub, pending. | Old Flame → **cancelled** (immediate). Blaze → **created** → Checkout. | Flame until Checkout completes. | — |
| **2b. Complete Checkout** | Blaze row `2→1`, period set. | Blaze → **active** (₹2499). Old Flame cancelled. | **"Blaze — Current Plan"**, Renews `<date>`. | `upgraded / blaze / razorpay` |
| **2b′. Abandon** | Flame already cancelled + Blaze never activates → stranded. | Flame cancelled, Blaze created. | limbo *(known upgrade-path limitation — abandoned upgrade)* | — |

---

## 3. Deferred downgrade — Blaze → Flame (the core flow)

| Step | baker_subscriptions | Razorpay | Billing screen | subscription_events |
|---|---|---|---|---|
| **3a. Click Switch → Flame** (`subscribe`, downgrade) | **NEW parked Flame row**: `status_id=2`, `plan_id=2`, `billing_subscription_id=<parkedFlame>`, `start_date=<period_end>`. **Blaze row UNCHANGED** (still active, NO scheduled_*). | Parked Flame → **created** with `start_at=period_end`. Blaze → still **active**. | **No change** — Blaze current, nothing scheduled shown (commit happens at auth). | — |
| **3b. Complete Checkout** (authorize deferred mandate) | **Blaze row**: `scheduled_plan_id=2`, `scheduled_effective_at=<period_end>`, `scheduled_subscription_id=<parkedFlame>`, `cancel_at_period_end=true`, `cancellation_reason_id=2`, `cancellation_requested_at` set — **`status_id` stays 1** (grace). Parked Flame row stays `pending`. | Blaze → **cancelled** (immediate). Parked Flame → **authenticated** (`charge_at=period_end`). | **"Blaze"** · "Until `<date>` · then Flame" + "Moving to Flame on `<date>` — you keep Blaze until then." No cancel email. | `downgrade_scheduled / prev blaze → new flame / razorpay` |
| **3b′. Abandon Checkout** | Blaze row UNCHANGED. Parked Flame row stays `pending` (orphan; created sub never charges). | Blaze still **active** (renews normally). Parked Flame stays **created**. | Blaze current, **no phantom** "downgrade scheduled". | — |
| **3c. Cycle end** — parked Flame first-charges | Blaze row → `status_id=6`, `end_date=today`, **scheduled_\* cleared**. Flame row `2→1`, period set. bakers → parkedFlame, plan flame. | Parked Flame → **active** (₹999). Blaze already cancelled. | **"Flame — Current Plan"**, Renews `<next date>`. | `downgraded / prev blaze → new flame / razorpay` |

**3d. Downgrade scheduled, then change mind (upgrade to Forge before cycle end):** subscribe sees
`Blaze.scheduled_subscription_id` set → **cancels the parked Flame** (Razorpay + row → 6) + clears
`scheduled_*` on Blaze (and `cancel_at_period_end=false`), then runs the normal upgrade path to Forge.
Result: parked Flame gone, baker upgrades to Forge; history logs `upgraded / forge`.

**3e. Cancel WHILE a downgrade is scheduled (cancel supersedes the downgrade — last-action-wins):**
`POST /billing/cancel` sees `Blaze.scheduled_subscription_id` set →

| Surface | Expected |
|---|---|
| baker_subscriptions | Parked Flame row → `6`. Blaze row: `scheduled_*` cleared, `cancel_at_period_end=true`, reason=5 — **stays `status 1`** (grace). |
| Razorpay | Parked Flame → **cancelled**. Blaze already cancelled (from 3b) → the route **tolerates** "already cancelled" (no 502). |
| Billing screen | Cancel dialog **notes the discard**: "You have a downgrade to Flame scheduled for `<date>` — cancelling discards it." After: "Blaze · Ends `<date>` · won't renew" (no "then Flame"). |
| subscription_events | `cancelled / blaze / baker`. |
| Cycle end | Blaze grace expires → **inactive/lapsed** (NOT Flame, NOT Spark). |

---

## 4. Standalone cancellation — Flame → free

| Step | baker_subscriptions | Razorpay | Billing screen | subscription_events |
|---|---|---|---|---|
| **4a. Click Cancel** (`POST /billing/cancel`) | Flame row: `cancel_at_period_end=true`, `cancellation_reason_id=5`, `cancellation_requested_at` set — **`status_id` stays 1** (grace). | Flame → **cancelled** (immediate — NOT cancel-at-cycle-end, which no-ops on UPI). | **"Flame"** · "Ends `<date>` · won't renew" + "Cancellation scheduled — access until this period ends." Cancel button hidden. Cancel email sent. | `cancelled / flame / baker` |
| **4b. Cycle end** (grace expires) | Derive rule → `expired`; reconcile relabels `status_id=1→6`. No renewal charge. | Flame already cancelled. | Baker **inactive/lapsed** — floor entitlements, can't accept orders (`BAKER_INACTIVE`). **NOT Spark** (one-time at signup). Must pick a PAID plan to resume; data preserved. | `expired / … / system` (reconcile) |

> Why immediate-cancel not `cancel_at_cycle_end`: verified `cancel(id,true)` is a **silent no-op on UPI**
> (leaves the sub armed → re-charges at the boundary). Immediate cancel is synchronous + verifiable; the
> grace period gives the identical baker-facing outcome.

---

## 5. Paid baker selects Spark → rejected

| Surface | Expected |
|---|---|
| **Billing screen** | Spark is **not shown** as a selectable card for a paid baker (returning to free = Cancel). |
| **Server** (if bypassed) | `POST /billing/subscribe {tier:'spark'}` → **400** `free_plan_not_subscribable`. |
| baker_subscriptions / Razorpay / events | **No change.** |

---

## 6. Renewal — same plan at cycle end (not cancelled)

| Step | baker_subscriptions | Razorpay | Billing screen | subscription_events |
|---|---|---|---|---|
| **subscription.charged** (paid_count > 1) | current_period_start/end/end_date **advanced**; status stays 1. | Flame **active**, paid_count++. | "Flame — Current Plan", Renews `<new date>`. Payments tab: new ₹999. | **none** *(renewals aren't logged as events yet — known gap; the 'renewed' label exists but nothing writes it)* |

---

## 7. Payment failure / dunning

| Event | baker_subscriptions | Razorpay | Billing screen |
|---|---|---|---|
| `subscription.pending` / `payment.failed` | `status_id=4 (past_due)` | active (retrying) | past-due badge, "update payment method" (payment-failed email) |
| `subscription.halted` (retries exhausted) | `status_id=5 (expired)` — recoverable on same row | halted | expired; a later successful charge reactivates the SAME row |

---

## 8. Reactivation after cancel — DURING grace (⬜ PLANNED, not yet built)
Baker cancelled (Flame, `cancel_at_period_end=true`, still in grace before period end) → resubscribes.
Expected model: **deferred re-subscribe** — keep the paid grace, first charge at period end, no double
charge (industry "un-cancel" outcome). A **confirm dialog** must convey the mechanics (amount-agnostic).

| Step | baker_subscriptions | Razorpay | Billing screen | subscription_events |
|---|---|---|---|---|
| **8a. Reactivate SAME plan** (Flame) | Clear the cancel intent; park a new Flame sub → `scheduled_subscription_id`, `scheduled_effective_at=period_end`. Current Flame row stays `1` (grace). | new Flame sub `created`(→authenticated), `start_at=period_end`. | Confirm dialog: "…continues, you keep access until `<date>`, then renews as Flame. Re-authorize your payment method now." Then: "Flame · renews `<date>`" (NOT "cancellation scheduled", NOT "then Flame"). | `reactivated / flame` (or `subscribed`) |
| **8b. Reactivate DIFFERENT lower plan** | as a downgrade — parked lower sub, keep current grace | parked lower `authenticated` | "Current · Until `<date>` · then `<lower>`" | `downgrade_scheduled` |
| **8c. Reactivate DIFFERENT higher plan** | upgrade path (immediate) supersedes the cancel | new higher sub now | "Higher — Current Plan" | `upgraded` |
| **8d. Cycle end** | parked promotes; old row → `6`; baker on the chosen plan | parked → active | chosen plan current | `subscribed`/`downgraded` |

**Fixes needed for this scenario:** subscribe route must (1) NOT 409 on the same plan when
`cancel_at_period_end=true`, and (2) route a winding-down resubscribe through the deferred-reactivation
path. Confirm dialog + downgrade pre-Checkout note added. **No amount stated in copy** (Razorpay owns it).

## 9. Resubscribe after FULL lapse (inactive)
Baker's grace already expired (inactive). Resubscribe to any paid plan → **fresh subscribe** (immediate,
new sub + charge + period), exactly like §1. ✅ works today (no active row → direction null → fresh).

---

## Required Razorpay webhook events (must be enabled)
`subscription.authenticated` (deferred-downgrade commit), `subscription.activated`, `subscription.charged`,
`subscription.cancelled`, `subscription.completed`, `subscription.pending`, `subscription.halted`,
`subscription.paused`, `subscription.resumed`, `payment.failed`. **`subscription.updated` is NOT needed**
(we never call `update()`).

## Known gaps / follow-ups
- **Reactivation during grace (§8)** is PLANNED — needs the subscribe-route deferred-reactivation path +
  same-plan 409 fix + confirm dialog. Reactivation after full lapse (§9) already works.
- Abandoned **upgrade** Checkout strands the baker (old cancelled immediately). Downgrade already fixed
  (commit-at-auth); upgrade could adopt the same safe-sequencing.
- **Renewals** aren't written to `subscription_events` (only emailed).
- **External/dashboard cancels** aren't logged as events (only app cancels via `/billing/cancel`).
- **Interval switch (monthly↔yearly, same tier)** is blocked as "same plan" — see SUBSCRIPTION_COVERAGE.md B7.
- Card path is the SAME flow but **not yet verified in test mode**; card-only `update()` optimization deferred.
- Cycle-end **promotion (§3c)** — VALIDATED via `scripts/simulate_cycle_end.mjs` (fires the charged webhook).
- Full coverage audit: **SUBSCRIPTION_COVERAGE.md**.
