import { supabase } from '../../services/supabase.js';
import { accountingQueue } from '../queue.js';

// Billing → accounting OUTBOX RELAY (GST_INVOICING_PLAN.md Wave 2). Runs as a BullMQ repeatable job
// (jobs/schedules.js) — NOT an in-process timer. The charge path writes ONLY the billing_outbox row
// (atomic with the charge); this relay is the sole thing that publishes it to the accounting queue, so
// there is never a dual-write (a queue publish + a DB write can't share a transaction — doing both
// inline would risk a missing invoice or an invoice for a charge that rolled back).
//
// Ordering is PUBLISH-then-mark-delivered, never the reverse: if we marked delivered first and the
// publish then failed, the event would be lost (a gap in a gap-free legal register). Publishing first
// means the worst case is a re-publish, which is harmless — jobId=event_id dedupes it on the queue and
// the accounting consumer is idempotent on the same key (invoices.source_event_id UNIQUE). 'delivered'
// means "handed to the queue"; the queue owns delivery to the consumer from there.
//
// The .eq('status','pending') on the mark is an optimistic claim so two overlapping ticks can't both
// count/flip the same row. A publish failure bumps attempts and leaves the row pending for the next tick
// — nothing is ever lost. Throwing propagates to BullMQ (job retried); per-row errors are logged, not
// thrown, so one poison row can't stall the whole batch.
const BATCH = 200;
const MAX_BATCHES = 20;   // drain up to 4k backlog per run, then stop (backstop, not the hot path)

export async function relayBillingOutbox() {
  let relayed = 0;

  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data: rows, error } = await supabase
      .from('billing_outbox')
      .select('id, event_id, type, payload, attempts')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })   // oldest first — matches the pending index
      .limit(BATCH);
    if (error) throw new Error(`outbox relay query failed: ${error.message}`);   // throw → BullMQ retries
    if (!rows?.length) break;

    for (const row of rows) {
      try {
        // jobId = event_id (= razorpay_payment_id) → BullMQ ignores a duplicate add while the job exists,
        // so a relay retry can't hand the same charge to the consumer twice. attempts/backoff let the
        // consumer retry transient failures; removeOnFail:false keeps a permanently-failed job as a DLQ
        // entry for Phase 8 ops (replay = reset the outbox row to 'pending').
        await accountingQueue.add(
          row.type,
          { event_id: row.event_id, type: row.type, payload: row.payload },
          {
            jobId: row.event_id,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
      } catch (err) {
        // Publish failed — bump attempts, leave pending. Re-tried next tick; nothing lost.
        const { error: bumpErr } = await supabase
          .from('billing_outbox')
          .update({ attempts: (row.attempts ?? 0) + 1 })
          .eq('id', row.id)
          .eq('status', 'pending');
        if (bumpErr) console.error(`[outbox-relay] attempts bump ${row.event_id} failed:`, bumpErr.message);
        console.error(`[outbox-relay] publish ${row.event_id} failed:`, err.message);
        continue;
      }

      // Published — claim the row. .eq('status','pending') is the optimistic lock; a 0-row match means a
      // concurrent tick already flipped it (fine, the job was deduped by jobId).
      const { error: updErr } = await supabase
        .from('billing_outbox')
        .update({ status: 'delivered', delivered_at: new Date().toISOString(), attempts: (row.attempts ?? 0) + 1 })
        .eq('id', row.id)
        .eq('status', 'pending');
      if (updErr) { console.error(`[outbox-relay] mark delivered ${row.event_id} failed:`, updErr.message); continue; }
      relayed++;
    }

    if (rows.length < BATCH) break;   // drained
  }

  if (relayed) console.log(`[outbox-relay] relayed ${relayed} event(s) to the accounting queue`);
}
