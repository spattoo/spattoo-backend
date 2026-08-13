import { supabase } from '../../services/supabase.js';
import { SUBSCRIPTION_STATUS } from '../../constants/subscriptionStatuses.js';

// Daily backstop for the cancellation state machine, run as a BullMQ repeatable job (see
// jobs/schedules.js) — NOT an in-process timer. Access correctness does NOT depend on this:
// get_baker_subscription already derives 'expired' the moment now() >= current_period_end. This
// job only MATERIALISES the stored status label (active → cancelled) for grace-cancelled rows whose
// paid-through boundary has passed, recovering rows the subscription.cancelled/.completed webhook
// never delivered. Idempotent: the .eq(status_id, ACTIVE) claim is the optimistic lock, so a
// concurrent run / late webhook can't double-flip.
const BATCH = 500;
const MAX_BATCHES = 20;   // drain up to 10k stale rows per run, then stop (backstop, not hot path)

export async function reconcileSubscriptions() {
  const nowIso = new Date().toISOString();
  let cancelled = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    // Grace-cancelled rows past their boundary but still labelled active. current_period_end is the
    // instant source of truth (only Razorpay-backed rows have it — free/spark subs are excluded).
    const { data: rows, error } = await supabase
      .from('baker_subscriptions')
      .select('id, baker_id, billing_subscription_id')
      .eq('status_id', SUBSCRIPTION_STATUS.ACTIVE)
      .eq('cancel_at_period_end', true)
      .lt('current_period_end', nowIso)   // < also excludes NULLs
      .limit(BATCH);
    if (error) throw new Error(`reconcile query failed: ${error.message}`);   // throw → BullMQ retries
    if (!rows?.length) break;

    for (const row of rows) {
      // Claim + relabel; the extra status_id=ACTIVE match is the optimistic lock. .select() tells us
      // whether WE flipped it (vs a concurrent run / late webhook that already did).
      const { data: updated, error: updErr } = await supabase
        .from('baker_subscriptions')
        .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED })
        .eq('id', row.id)
        .eq('status_id', SUBSCRIPTION_STATUS.ACTIVE)
        .select('id');
      if (updErr) { console.error(`[reconcile] relabel ${row.id} failed:`, updErr.message); continue; }
      if (!updated?.length) continue;   // already flipped by someone else
      cancelled++;

      // Mirror onto bakers only when this IS the baker's current subscription (pointer match), so a
      // superseded row can't clobber live status. All matched rows are Razorpay-backed (non-null id).
      if (row.billing_subscription_id) {
        const { error: mirrorErr } = await supabase
          .from('bakers')
          .update({ subscription_status_id: SUBSCRIPTION_STATUS.CANCELLED })
          .eq('id', row.baker_id)
          .eq('billing_subscription_id', row.billing_subscription_id);
        if (mirrorErr) console.error(`[reconcile] mirror baker ${row.baker_id} failed:`, mirrorErr.message);
      }
    }
    if (rows.length < BATCH) break;   // drained
  }

  if (cancelled) console.log(`[reconcile] cancelled ${cancelled} expired-grace subscription(s)`);
}
