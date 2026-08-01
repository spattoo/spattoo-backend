import { supabase } from '../../services/supabase.js';
import { config } from '../../config.js';
import { DELETION_STATUS, ERASURE_MANIFEST } from '../../constants/accountDeletion.js';
import { notifyAccountErasureScheduled } from '../../services/notifications.js';
import { deleteObject } from '../../services/r2.js';

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

// Erase every image uploaded into a tenant: deactivate the promoted library copies (via the
// source_upload_id link), delete the R2 objects, then drop the rows.
//
// HARD delete, not the soft delete the routes use. Elsewhere `deleted_at` is right — a baker removing an
// image wants a trail, and moderation wants to know what was taken down. Erasure is the opposite: the
// user asked us to STOP HOLDING IT, and a soft-deleted row still holds the storage_key of a live object.
// The audit trail that survives is deletion_requests, which records that the erasure happened — the
// right thing to keep, without keeping the photograph.
async function eraseUploads(bakerId) {
  const { data: uploads, error } = await supabase
    .from('baker_uploads')
    .select('id, storage_key')
    .eq('baker_id', bakerId);
  if (error) throw new Error(`upload erase query failed: ${error.message}`);
  if (!uploads?.length) return;

  const { error: unlinkErr } = await supabase
    .from('cake_elements')
    .update({ is_active: false })
    .in('source_upload_id', uploads.map(u => u.id));
  if (unlinkErr) throw new Error(`unlink promoted uploads failed: ${unlinkErr.message}`);

  // Object deletes are isolated: one missing key (already gone, or never written) must not abort the
  // erasure of the rest. Losing the ROW while the object lingers would be the bad failure, so rows go last.
  for (const u of uploads) {
    try {
      await deleteObject(u.storage_key);
    } catch (e) {
      console.error(`[erase-accounts] R2 delete ${u.storage_key} failed:`, e.message);
    }
  }

  const { error: delErr } = await supabase.from('baker_uploads').delete().eq('baker_id', bakerId);
  if (delErr) throw new Error(`upload row delete failed: ${delErr.message}`);
}

// X-Ray stage images: the generated build-sequence picture for one decoration on one order.
//
// These are NOT in baker_uploads — they are written by the API, not uploaded by anyone, so the
// upload sweep above cannot see them. They are derived from the CUSTOMER's reference photo, which
// makes them personal data by provenance, and an erasure that leaves them behind leaves a picture
// of the customer's cake in a bucket after the account is gone.
//
// The key lives in orders.xray_spec.decorations[<key>].stages_key. Deleting the object is enough:
// the row itself goes when the order does, and a dangling key on a deleted order harms nobody.
async function eraseXrayStageImages(bakerId) {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, xray_spec')
    .eq('baker_id', bakerId)
    .not('xray_spec', 'is', null);
  if (error) throw new Error(`stage image query failed: ${error.message}`);

  for (const o of orders ?? []) {
    const decorations = o?.xray_spec?.decorations ?? {};
    for (const entry of Object.values(decorations)) {
      const key = entry?.stages_key;
      if (!key) continue;
      // Isolated per object, like the uploads above: one already-gone key must not abort the rest.
      try {
        await deleteObject(key);
      } catch (e) {
        console.error(`[erase-accounts] R2 delete ${key} failed:`, e.message);
      }
    }
  }
}

// The same picture, for a decoration in the baker's OWN element library. Derived from an image
// they uploaded, so it goes with them.
//
// SCOPED TO THEIR OWN ELEMENTS, never to a guide they generated on a GLOBAL one. Those are shared:
// the row records who paid for it, but the answer belongs to every baker who uses that element, and
// deleting it because one account closed would take a picture away from everyone else.
async function eraseElementStageImages(bakerId) {
  const { data: rows, error } = await supabase
    .from('element_craft_guide')
    .select('stages_key, cake_elements!inner(baker_id)')
    .eq('cake_elements.baker_id', bakerId)
    .not('stages_key', 'is', null);
  if (error) throw new Error(`element stage image query failed: ${error.message}`);

  for (const r of rows ?? []) {
    try {
      await deleteObject(r.stages_key);
    } catch (e) {
      console.error(`[erase-accounts] R2 delete ${r.stages_key} failed:`, e.message);
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

  // UPLOADED IMAGES — the manifest cannot reach these. It nulls COLUMNS, but an upload is an OBJECT in
  // R2 (a customer's photo: personal data, and often a child's). Nulling a column would leave the image
  // sitting in the bucket, publicly addressable, after we told the user it was erased.
  //
  // The library copy must go too. If an upload had been PROMOTED, deleting only the upload row would
  // leave the promoted cake_elements row live in every customer's picker — a deletion that did not
  // delete. Promotion links back (source_upload_id) precisely so erasure can follow it.
  await eraseUploads(bakerId);
  await eraseXrayStageImages(bakerId);
  await eraseElementStageImages(bakerId);

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
