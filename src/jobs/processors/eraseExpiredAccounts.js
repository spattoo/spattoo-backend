import { supabase } from '../../services/supabase.js';
import { config } from '../../config.js';
import { DELETION_STATUS, ERASURE_MANIFEST } from '../../constants/accountDeletion.js';
import { notifyAccountErasureScheduled } from '../../services/notifications.js';

// Scheduled sweep for the account-erasure lifecycle (DPDP "Layer 3"), run as a BullMQ repeatable
// job (jobs/schedules.js) — NOT an in-process timer. Two passes, both idempotent:
//   1. NOTICE  — pending-erasure bakers within the 48h window with no notice sent yet → email + mark.
//   2. ERASE   — pending-erasure bakers past erase_after → anonymize personal data (manifest),
//                delete their auth logins, mark ERASED. The default 365-day window means nothing
//                erases until long after a request; correctness never depends on this job running
//                on time — it only MATERIALISES the erasure once due.
//
// Statutory carve-out: financial records (GST invoices in spattoo-accounting) are NEVER touched
// here — the manifest lists only personal columns on core tables. See
// docs/CONSENT_WITHDRAWAL_AND_ERASURE_PLAN.md §5.
const BATCH = 200;

export async function eraseExpiredAccounts() {
  const nowIso = new Date().toISOString();
  await sendPreErasureNotices(nowIso);
  await eraseDueAccounts(nowIso);
}

// ── Pass 1: 48h pre-erasure notice (Rule 8) ─────────────────────────────────────────
async function sendPreErasureNotices(nowIso) {
  const noticeCutoff = new Date(Date.now() + config.retention.preErasureNoticeHours * 3600000).toISOString();
  const { data: due, error } = await supabase
    .from('bakers')
    .select('id, name, email, timezone, erase_after')
    .eq('deletion_status', DELETION_STATUS.PENDING_ERASURE)
    .is('notice_sent_at', null)
    .lte('erase_after', noticeCutoff)
    .limit(BATCH);
  if (error) throw new Error(`erasure notice query failed: ${error.message}`);

  for (const baker of due ?? []) {
    try {
      // Claim first (set notice_sent_at) so a concurrent run can't double-send; only then email.
      const { data: claimed } = await supabase
        .from('bakers')
        .update({ notice_sent_at: nowIso })
        .eq('id', baker.id)
        .eq('deletion_status', DELETION_STATUS.PENDING_ERASURE)
        .is('notice_sent_at', null)
        .select('id')
        .maybeSingle();
      if (!claimed) continue;                       // another run got it
      await notifyAccountErasureScheduled(baker, { eraseAfter: baker.erase_after });
      await supabase
        .from('deletion_requests')
        .update({ notice_sent_at: nowIso })
        .eq('baker_id', baker.id)
        .is('cancelled_at', null)
        .is('erased_at', null);
    } catch (e) {
      console.error(`[erase-accounts] notice for baker ${baker.id} failed:`, e.message);
    }
  }
}

// ── Pass 2: erase accounts past their window ─────────────────────────────────────────
async function eraseDueAccounts(nowIso) {
  const { data: due, error } = await supabase
    .from('bakers')
    .select('id')
    .eq('deletion_status', DELETION_STATUS.PENDING_ERASURE)
    .lte('erase_after', nowIso)
    .limit(BATCH);
  if (error) throw new Error(`erasure query failed: ${error.message}`);

  for (const baker of due ?? []) {
    try {
      await eraseOneBaker(baker.id);
    } catch (e) {
      console.error(`[erase-accounts] erase baker ${baker.id} failed:`, e.message);   // isolate failures
    }
  }
}

async function eraseOneBaker(bakerId) {
  // Capture auth logins BEFORE anonymizing, so we can delete them (removes email/phone from
  // auth.users too — that PII lives outside our tables).
  const { data: appusers } = await supabase
    .from('baker_appusers')
    .select('auth_user_id')
    .eq('baker_id', bakerId);

  // Anonymize personal columns across every table in the manifest (single declarative source).
  for (const { table, bakerFk, nullColumns } of ERASURE_MANIFEST) {
    const patch = Object.fromEntries(nullColumns.map(c => [c, null]));
    const { error } = await supabase.from(table).update(patch).eq(bakerFk, bakerId);
    if (error) throw new Error(`manifest erase ${table} failed: ${error.message}`);
  }

  // Delete the Supabase Auth users (blocks login + erases their auth-side PII).
  for (const u of appusers ?? []) {
    if (!u.auth_user_id) continue;
    const { error } = await supabase.auth.admin.deleteUser(u.auth_user_id);
    if (error) console.error(`[erase-accounts] auth deleteUser ${u.auth_user_id} failed:`, error.message);
  }

  // Mark ERASED last — the optimistic PENDING_ERASURE match makes a re-run a no-op.
  const { error: markErr } = await supabase
    .from('bakers')
    .update({ deletion_status: DELETION_STATUS.ERASED })
    .eq('id', bakerId)
    .eq('deletion_status', DELETION_STATUS.PENDING_ERASURE);
  if (markErr) throw new Error(`mark erased failed: ${markErr.message}`);

  await supabase
    .from('deletion_requests')
    .update({ erased_at: new Date().toISOString() })
    .eq('baker_id', bakerId)
    .is('erased_at', null)
    .is('cancelled_at', null);
}
