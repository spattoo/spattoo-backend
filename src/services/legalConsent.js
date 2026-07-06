import { supabase } from './supabase.js';
import { CONSENT_ACTION, CONSENT_SOURCE, CONSENT_REQUIRED_DOC_KEYS } from '../constants/legalDocuments.js';

// Consent-log helpers (DPDP "Layer 2"). See docs/CONSENT_CAPTURE_PLAN.md.
// consent_events is append-only: a withdrawal is a NEW row, so "is this accepted?" means
// "the LATEST event for (subject, version) is an acceptance".

// Current published version of each requested document (metadata only — no frozen text).
export async function getCurrentVersions(docKeys) {
  let q = supabase
    .from('legal_document_versions')
    .select('id, doc_key, version, effective_at, content_hash')
    .eq('is_current', true);
  if (docKeys?.length) q = q.in('doc_key', docKeys);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// Map of version_id → action of its LATEST consent event for this subject. The one place the
// "latest event wins" rule lives (accept AND withdraw both read it) — never a second copy.
async function latestActionByVersion(subjectType, subjectId, versionIds) {
  const latest = new Map();
  if (!versionIds.length) return latest;
  const { data, error } = await supabase
    .from('consent_events')
    .select('document_version_id, action, consented_at')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .in('document_version_id', versionIds)
    .order('consented_at', { ascending: false });
  if (error) throw error;
  for (const row of data ?? []) {          // desc order → first seen per version is the latest
    if (!latest.has(row.document_version_id)) latest.set(row.document_version_id, row.action);
  }
  return latest;
}

// Set of version ids whose LATEST event is an acceptance (a withdrawal flips it back out).
async function acceptedVersionIds(subjectType, subjectId, versionIds) {
  const latest = await latestActionByVersion(subjectType, subjectId, versionIds);
  const accepted = new Set();
  for (const [vid, action] of latest) {
    if (action === CONSENT_ACTION.ACCEPTED) accepted.add(vid);
  }
  return accepted;
}

// docKeys the subject has NOT yet accepted at the current version. [] when nothing is
// published yet (draft phase) → the gate stays silent until Layer 1 goes live.
export async function pendingConsents(subjectType, subjectId, docKeys = CONSENT_REQUIRED_DOC_KEYS) {
  const versions = await getCurrentVersions(docKeys);
  if (!versions.length) return [];
  const accepted = await acceptedVersionIds(subjectType, subjectId, versions.map(v => v.id));
  return versions.filter(v => !accepted.has(v.id)).map(v => v.doc_key);
}

// Record acceptance of the CURRENT version of each docKey. Idempotent per (subject, version):
// a doc already accepted at its current version is skipped, not duplicated.
export async function recordConsent({ subjectType, subjectId, docKeys, source, ip, userAgent }) {
  const versions = await getCurrentVersions(docKeys);
  const byKey = new Map(versions.map(v => [v.doc_key, v]));
  const accepted = await acceptedVersionIds(subjectType, subjectId, versions.map(v => v.id));

  const recorded = [];
  const already = [];
  const unpublished = [];
  const rows = [];
  for (const key of docKeys) {
    const v = byKey.get(key);
    if (!v) { unpublished.push(key); continue; }       // no current version → nothing to accept
    if (accepted.has(v.id)) { already.push(key); continue; }
    rows.push({
      subject_type: subjectType,
      subject_id: subjectId,
      document_version_id: v.id,
      action: CONSENT_ACTION.ACCEPTED,
      source,
      ip: ip ?? null,
      user_agent: userAgent ?? null,
    });
    recorded.push({ doc_key: key, version: v.version });
  }
  if (rows.length) {
    const { error } = await supabase.from('consent_events').insert(rows);
    if (error) throw error;
  }
  return { recorded, already, unpublished };
}

// Withdraw consent for the CURRENT version of each docKey (DPDP §6(4)). Idempotent + append-only:
// a withdrawal is a NEW row with action=WITHDRAWN — we withdraw ONLY docs whose latest event is an
// acceptance (already-withdrawn or never-accepted docs are skipped, not stacked). The caller (route)
// decides which docKeys are eligible — the REQUIRED-doc guard lives at the API boundary so the
// account-deletion flow can still withdraw tos/privacy internally via this same function.
export async function withdrawConsent({ subjectType, subjectId, docKeys, source, ip, userAgent }) {
  const versions = await getCurrentVersions(docKeys);
  const byKey = new Map(versions.map(v => [v.doc_key, v]));
  const latest = await latestActionByVersion(subjectType, subjectId, versions.map(v => v.id));

  const withdrawn = [];
  const notAccepted = [];   // never accepted, or already withdrawn — nothing to do
  const unpublished = [];
  const rows = [];
  for (const key of docKeys) {
    const v = byKey.get(key);
    if (!v) { unpublished.push(key); continue; }
    if (latest.get(v.id) !== CONSENT_ACTION.ACCEPTED) { notAccepted.push(key); continue; }
    rows.push({
      subject_type: subjectType,
      subject_id: subjectId,
      document_version_id: v.id,
      action: CONSENT_ACTION.WITHDRAWN,
      source,
      ip: ip ?? null,
      user_agent: userAgent ?? null,
    });
    withdrawn.push({ doc_key: key, version: v.version });
  }
  if (rows.length) {
    const { error } = await supabase.from('consent_events').insert(rows);
    if (error) throw error;
  }
  return { withdrawn, notAccepted, unpublished };
}

// A subject's own consent history (accept + withdraw), newest first, joined to the version it
// references. Powers the "Your agreements" list + the downloadable record. Enums are translated to
// readable names at this boundary (callers speak strings, storage stays compact).
export async function consentHistory(subjectType, subjectId) {
  const { data, error } = await supabase
    .from('consent_events')
    .select('action, source, consented_at, legal_document_versions ( doc_key, version, effective_at )')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .order('consented_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(r => ({
    docKey:      r.legal_document_versions?.doc_key ?? null,
    version:     r.legal_document_versions?.version ?? null,
    effectiveAt: r.legal_document_versions?.effective_at ?? null,
    action:      CONSENT_ACTION.NAME_BY_ID[r.action] ?? String(r.action),
    source:      CONSENT_SOURCE.NAME_BY_ID[r.source] ?? String(r.source),
    at:          r.consented_at,
  }));
}
