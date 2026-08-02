// ── When to warn a baker about credits ───────────────────────────────────────────────
// The decision only, with NO IMPORTS — no supabase, no notifications, no queue. Same reason
// decorationPolicy.js and saleEventPayloads.js are pure: this is the part with the interesting
// rules, and it should be assertable without booting the application. See
// scripts/check-credit-alerts.mjs.
//
// (It is also the part that must not drag the notification stack into aiCredits.js's import graph.
// Doing exactly that broke check:ai-credit-pricing — the gate imports aiCredits, notifications
// pulls in the BullMQ queue, and a gate that had always exited cleanly began hanging forever on a
// Redis connection to a stub host.)

// 80% of the monthly allowance. Deliberately later than the 70% at which the pill first goes amber:
// that is a colour on a screen the baker is already looking at, and this is an email. The cost of
// being early differs by an order of magnitude between the two.
export const LOW_WATERMARK = 0.8;

// Returns 'exhausted' | 'low' | null.
//
// `null` means say nothing, and most of the interesting logic is about when to return it.
export function creditWarningLevel({ unlimited, active, allowance, allowanceUsed, walletBalance }) {
  // No line to cross.
  if (unlimited) return null;
  // A lapsed plan has bigger news than its credit balance, and its allowance is 0 — without this
  // every lapsed baker would be permanently 'exhausted'.
  if (!active) return null;
  if (!allowance || allowance <= 0) return null;

  // ── Suppressed when bought credits cover the gap ──────────────────────────────────
  // A baker holding a month's worth of PURCHASED credits has not hit a wall: the monthly ones
  // running out is a bookkeeping event for them and the smart tools keep working. Warning anyway
  // is how an alert becomes something people filter — and it would be the first alert most heavy
  // users ever saw, since they are precisely the ones who top up.
  if ((walletBalance ?? 0) >= allowance) return null;

  const used = (allowanceUsed ?? 0) / allowance;
  if (used >= 1) return 'exhausted';
  if (used >= LOW_WATERMARK) return 'low';
  return null;
}

// The 1st of the current month in IST, as a plain date string. The same boundary the ledger meters
// the allowance on (migration 022), so "this month" means one thing across the whole feature.
//
// Takes `now` so it can be tested at a month edge without waiting for one.
export function istMonthStart(now = Date.now()) {
  const IST = 5.5 * 3600 * 1000;
  const d = new Date(now + IST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
