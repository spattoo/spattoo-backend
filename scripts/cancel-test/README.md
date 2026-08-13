# Scheduled-cancel validation harness (test mode)

**Question:** does Razorpay `subscriptions.cancel(id, cancel_at_cycle_end=true)` actually stop the
next charge on our rails (UPI first, then card) — or is it a no-op that re-charges at the boundary?

Our whole billing lifecycle currently avoids scheduled cancel and instead **immediate-cancels +
simulates a local grace period**, because of one prior finding (`src/routes/billing.js:666`):
> *cancel-at-cycle-end no-ops on UPI (end_at/charge_at stay armed → old would re-charge).*

That was an **API-field** observation. This harness gets the **ground truth**: it watches whether a
real renewal charge fires at the boundary. If scheduled cancel works, we can drop the immediate-cancel
hack and unlock un-cancel/resume (coverage doc C6) — a change far cheaper to make **now, pre-production**
than after there's live traffic to migrate.

Razorpay has **no test clocks** (see `../simulate_cycle_end.mjs`), so the renewal can only be observed
on real wall-clock. Razorpay's **minimum subscription interval is 7 days** (daily is rejected —
confirmed by `1-create.mjs`), so **weekly is the floor: this is a ~7-day test.** Authorize the first
charge today, schedule the cancel today, then check back after the next weekly boundary.

## Safety
Every script refuses to run unless `RAZORPAY_KEY_ID` starts with `rzp_test_`. It creates a **disposable**
plan + subscription only; it never touches a real baker's subscription.

## Procedure
Run from the `spattoo-api/` root (needs `.env` with the test keys):

```bash
# 1. Create disposable plan + subscription (shortest cycle)
node scripts/cancel-test/1-create.mjs

# 2. Authorize the UPI mandate — opens a local Checkout page
node scripts/cancel-test/2-checkout.mjs        # open http://localhost:4999, UPI → success@razorpay

# 3. Wait for the FIRST charge to land (status=active, paid_count=1)
node scripts/cancel-test/observe.mjs           # repeat until status=active

# 4. Schedule the cancel (the lever under test)
node scripts/cancel-test/3-cancel.mjs

# 5. Observe across the boundary — before AND after charge_at / current_end
node scripts/cancel-test/observe.mjs           # run again after the boundary passes

# 6. Teardown
node scripts/cancel-test/cleanup.mjs
```

To repeat on the **card** rail, re-run from step 1 and authorize with a test card at Checkout.

## Reading the result
After step 4, note `paid_count` (call it N). Then across the boundary:

| Observation after boundary | Verdict |
|---|---|
| `status` → `cancelled`/`completed`, `paid_count` stays **N**, no new paid invoice | ✅ **Scheduled cancel works** — adopt it; drop immediate-cancel + local grace |
| `paid_count` → **N+1**, or a new `paid` invoice appears | ❌ **No-op on this rail** — prior finding holds; keep the immediate-cancel model |

`observe.mjs` prints `>>> A NEW CHARGE FIRED` when it detects the no-op case, and logs every snapshot
to `observe-log.jsonl` so the full timeline is auditable.

## Files
- `_shared.mjs` — client, test-key guard, state (`.state.json`), snapshot helpers
- `1-create.mjs` · `2-checkout.mjs` · `3-cancel.mjs` · `observe.mjs` · `cleanup.mjs`
- `.state.json`, `observe-log.jsonl` — gitignored run artifacts
