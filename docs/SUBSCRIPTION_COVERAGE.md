# Subscription Lifecycle — Industry Coverage Audit

The standard SaaS subscription/billing use cases (Stripe / Chargebee / Recurly conventions), mapped to
what Spattoo covers today. Use it to see what's done, what's deliberately different, and what's missing.

**Legend:** ✅ covered · 🟡 partial / by-design-different · ⛔ deliberately out of scope (decided) · ⬜ gap / not built

---

## A. Acquisition & activation
| # | Use case | Status | Notes |
|---|---|---|---|
| A1 | Time-boxed free trial → convert or lapse | ✅ | Spark = one-time trial (features.trial_days), lapses to inactive |
| A2 | No card at trial; card required to convert | ✅ | Spark free; pay only at upgrade (Option A) |
| A3 | Spark is one-time (never re-granted) | ✅ | `activate-spark` → `SPARK_ALREADY_USED` |
| A4 | Direct paid signup (skip trial) | 🟡 | Everyone starts Spark; paid via Billing. Deliberate (Option A) |
| A5 | Permanent free tier (freemium) | ⛔ | Spark is time-boxed, not permanent — by design |

## B. Plan changes
| # | Use case | Status | Notes |
|---|---|---|---|
| B1 | Upgrade mid-cycle, immediate | ✅ | recreate, immediate |
| B2 | Upgrade **proration** (charge only the delta) | 🟡 | We charge full new tier now, forfeit unused days. Documented; Razorpay/UPI recreate makes true proration hard. Goodwill-credit = future |
| B3 | Downgrade deferred to period end (no refund) | ✅ | validated end-to-end |
| B4 | Downgrade to free = cancel | ✅ | Spark not subscribable → routes to Cancel |
| B5 | Scheduled change, then change mind (supersede) | ✅ | subscribe-while-scheduled + cancel-while-scheduled both supersede |
| B6 | Only one pending change at a time (newest wins) | ✅ | our model |
| B7 | **Switch billing interval on same tier (monthly↔yearly)** | ⬜ | **BLOCKED** — direction is by tier rank only, so same tier = "already on this plan" (409). Standard use case, not handled |
| B8 | Quantity / seat changes (per-seat billing) | ⛔ | Team size is a feature cap, not per-seat billing — N/A |

## C. Cancellation & churn
| # | Use case | Status | Notes |
|---|---|---|---|
| C1 | Cancel at period end (keep access to boundary) | ✅ | immediate Razorpay cancel + local grace |
| C2 | Cancellation reason / churn survey | ✅ | `cancellation_reasons`, customer-selectable |
| C3 | Cancel supersedes a scheduled downgrade | ✅ | just shipped |
| C4 | Resubscribe after lapse | ✅ | `/billing/subscribe` (paid only) |
| C5 | Immediate cancel **with refund** | ⛔ | No refunds — decided |
| C6 | **Un-cancel / resume before period end** | ⬜ | Not supported — resuming needs a new sub. Clean fix = soft-cancel (flag locally, cancel at boundary via reconcile) |
| C7 | **Win-back / reactivation offers** | ⬜ | Not built |
| C8 | User-facing **pause/resume** | ⬜ | Webhook paused/resumed handled, but no user-initiated pause |
| C9 | Cancel during trial | 🟡 | Spark lapses; explicit trial-cancel path not distinct |
| C10 | Lapsed state = dormant, data retained, resubscribe to reactivate | ✅ | inactive → floor entitlements, `BAKER_INACTIVE`, data preserved |

## D. Payments & dunning
| # | Use case | Status | Notes |
|---|---|---|---|
| D1 | Successful renewal (period advances) | ✅ | on `subscription.charged` |
| D2 | Failed payment → retry/dunning | ✅ | `subscription.pending` → past_due |
| D3 | Retries exhausted → involuntary churn | ✅ | `subscription.halted` → expired (recoverable, same row) |
| D4 | Payment recovery (retry succeeds) | ✅ | reactivates same row |
| D5 | **Self-serve update payment method** | ⬜ | payment-failed email links out, but no in-app update flow. On UPI/card, "update" = new mandate |
| D6 | **Card-expiry pre-warnings** | ⬜ | Not built |
| D7 | **Downgrade's first charge fails at cycle end** | ⬜ | Parked sub charge failing → dunning on the new sub; promotion path assumes success — verify |

## E. Billing operations
| # | Use case | Status | Notes |
|---|---|---|---|
| E1 | Invoices / receipts / payment history | ✅ | `payments` + Razorpay invoices; Payments tab |
| E2 | Proration & credits / account balance | ⛔/⬜ | No proration (B2); no credit ledger |
| E3 | Refunds (full/partial) | ⛔ | Decided — none |
| E4 | **Coupons / discounts / promo codes** | ⬜ | Razorpay offers exist; not applied in our flow |
| E5 | **Taxes / GST** (India) | ⬜ | Not applied — see PRICING_AND_QUOTE_PLAN GST landscape; likely required for real invoicing |
| E6 | Multiple currencies | ⛔ | INR only |

## F. History, admin & data
| # | Use case | Status | Notes |
|---|---|---|---|
| F1 | Subscription event timeline (tier-aware) | ✅ | subscribed/upgraded/downgrade_scheduled/downgraded/cancelled |
| F2 | **Renewal logged in history** | ⬜ | Renewals emailed but NOT written to `subscription_events` |
| F3 | **External/dashboard cancel logged** | ⬜ | Only app cancels log an event |
| F4 | Admin-initiated plan change / comp | 🟡 | Dev-only `/baker/plan/select`; no prod admin-comp flow |
| F5 | Cancel-then-resubscribe overwrites cancel reason with 'upgrade' | ⬜ | Cosmetic audit inaccuracy — skip overwrite if a cancel reason is already set |

---

## Prioritized gaps (what "everything covered" would add)
**Should-fix (real user-facing gaps):**
1. **B7 — billing interval switch (monthly↔yearly on same tier)** is blocked. Decide direction by (tier rank, then period) or handle same-tier-different-period as a change.
2. **D5 — update payment method** self-serve (new mandate flow) — otherwise a failed card = forced cancel.
3. **E5 — GST/tax** on invoices — needed for compliant Indian invoicing at scale.
4. **D7 — downgrade first-charge failure** at cycle end — confirm the parked sub's dunning + what the baker sees.

**Nice-to-have / polish:**
5. C6 un-cancel/resume (soft-cancel model), C7 win-back, C8 user pause.
6. F2 renewal events, F3 external-cancel events, F5 reason-overwrite — history completeness.
7. B2 upgrade proration credit (goodwill).
8. D6 card-expiry warnings, E4 coupons.

**Verification debt (built but unproven):**
9. Card mandate path (all flows tested on UPI only).
10. Abandoned-**upgrade** Checkout strands the baker (only downgrade got commit-at-auth).

**Deliberately out (no action):** permanent free tier (A5), refunds (E3/C5), multi-currency (E6), per-seat billing (B8).
