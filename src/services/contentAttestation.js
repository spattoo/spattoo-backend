import { supabase } from './supabase.js';
import { serverError } from '../lib/httpError.js';
import { logError } from '../lib/telemetry.js';
import { getCurrentVersions } from './legalConsent.js';
import {
  ATTESTATION_DOC_KEY,
  ATTESTATION_TARGET_TYPE,
  CONSENT_SUBJECT_TYPE,
} from '../constants/legalDocuments.js';

// Content-rights attestation helpers (IP / copyright). See supabase/content_attestations.sql for
// why this is separate from the DPDP consent log, and why the ONLY gate is the storefront Publish
// button (the one moment content becomes visible to the world).
//
// The wording lives in legal_document_versions under ATTESTATION_DOC_KEY, so recording an
// attestation resolves the CURRENT version and FKs to it — proving which sentence the baker saw.
// getCurrentVersions() is reused rather than re-queried: one place knows how "current" is decided.

// The attestation is UNENFORCEABLE until its wording is published (nothing to point a FK at).
// Rather than silently record nothing — which would leave a live storefront with no evidence, and
// no way to tell that apart from a real gap — the caller gets a hard failure and the publish is
// refused. Fail closed: no attestation, no publish.
export class AttestationUnavailableError extends Error {
  constructor() {
    super('content-rights statement is not published — cannot attest');
    this.code = 'ATTESTATION_UNAVAILABLE';
  }
}

// Current published attestation statement (id + text), or null when Layer 1 is still draft.
export async function currentAttestationStatement() {
  const [version] = await getCurrentVersions([ATTESTATION_DOC_KEY]);
  if (!version) return null;
  const { data, error } = await supabase
    .from('legal_document_versions')
    .select('id, version, content, content_hash, effective_at')
    .eq('id', version.id)
    .single();
  if (error) throw error;
  return data;
}

// Record that `subjectId` (a baker app-user) vouched for what they are publishing. APPEND-ONLY:
// each publish is a distinct EVENT, so re-publishing adds another row and the trail reads
// "published 3 Aug, re-published 20 Sep" — each against the statement version in force then.
//
// Throws AttestationUnavailableError when the statement is unpublished — the caller MUST let that
// surface (do not swallow it) so the publish itself fails. That is the whole point of the gate.
export async function recordAttestation({
  subjectId,
  bakerId,
  targetType,
  targetId,
  ip,
  userAgent,
  subjectType = CONSENT_SUBJECT_TYPE.BAKER_APPUSER,
}) {
  if (!Object.values(ATTESTATION_TARGET_TYPE).includes(targetType)) {
    throw new Error(`unknown attestation target_type: ${targetType}`);
  }
  const statement = await currentAttestationStatement();
  if (!statement) throw new AttestationUnavailableError();

  const { error } = await supabase
    .from('content_attestations')
    .insert({
      subject_type: subjectType,
      subject_id: subjectId,
      baker_id: bakerId,
      target_type: targetType,
      target_id: targetId,
      document_version_id: statement.id,
      ip: ip ?? null,
      user_agent: userAgent ?? null,
    });
  if (error) throw error;

  return { attested: true, statementVersion: statement.version };
}

// The client must send an explicit, affirmative `rights_attested: true`. Absent/false → the
// publish is refused. Kept as a named helper (not an inline `!== true`) so that when a SECOND
// public surface appears — a custom domain, a marketplace listing — it gates on the same rule
// rather than inventing its own.
export function attestationMissing(body) {
  return body?.rights_attested !== true;
}

// Error responder for routes whose failure can be an UNPUBLISHABLE attestation (i.e. any route
// gated on recordAttestation). Kept beside the error it translates, so a second gated surface
// (custom domain, marketplace listing) reports the refusal identically instead of inventing its own
// status code.
//
// The unavailable case is OURS, not the caller's: the wording isn't published, so there is nothing
// to attest against and we refuse to expose content without evidence. That is a server-side gap —
// 503, not 4xx — and the code lets the client say "publishing is briefly unavailable" rather than
// blaming the baker for a valid tick. It still routes through serverError's telemetry path, because
// a live storefront that cannot be published is an alert, not a normal outcome.
export function publishError(req, res, err) {
  if (err instanceof AttestationUnavailableError) {
    logError(err, req);
    return res.status(503).json({
      error: 'Publishing is temporarily unavailable. Please try again shortly.',
      code: err.code,
      request_id: req?.id,
    });
  }
  return serverError(req, res, err);
}

// The attestation trail for one baker (newest first) — what we hand a rights holder, or the
// Grievance Officer, when a notice names a baker. Enums translated at this boundary; storage
// stays compact, callers speak strings (same convention as consentHistory).
export async function attestationHistory(bakerId) {
  const { data, error } = await supabase
    .from('content_attestations')
    .select('target_type, target_id, attested_at, subject_id, ip, legal_document_versions ( version, content_hash )')
    .eq('baker_id', bakerId)
    .order('attested_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(r => ({
    targetType:  ATTESTATION_TARGET_TYPE.NAME_BY_ID[r.target_type] ?? String(r.target_type),
    targetId:    r.target_id,
    attestedBy:  r.subject_id,
    at:          r.attested_at,
    ip:          r.ip,
    statement:   r.legal_document_versions?.version ?? null,
    statementHash: r.legal_document_versions?.content_hash ?? null,
  }));
}
