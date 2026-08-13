import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolvePrincipal } from '../middleware/rbac.js';
import { legalContentHash } from '../lib/legalHash.js';
import {
  LEGAL_DOC_KEYS,
  PUBLISHABLE_DOC_KEYS,
  CONSENT_REQUIRED_DOC_KEYS,
  CONSENT_SUBJECT_TYPE,
  CONSENT_SOURCE,
} from '../constants/legalDocuments.js';
import { getCurrentVersions, recordConsent, withdrawConsent, consentHistory, publishVersion } from '../services/legalConsent.js';

// Resolve the consenting subject (baker app-user vs invited customer) from the authed principal.
// Shared by consent / withdraw / history so the mapping never drifts. Returns a smallint or null.
function subjectTypeFor(role) {
  if (role === 'owner' || role === 'staff') return CONSENT_SUBJECT_TYPE.BAKER_APPUSER;
  if (role === 'customer') return CONSENT_SUBJECT_TYPE.CUSTOMER;
  return null;
}

// Consent capture (DPDP "Layer 2"). See docs/CONSENT_CAPTURE_PLAN.md.
const router = Router();

// ── POST /api/admin/legal/versions ── register (publish) a legal document version.
// Under the /api/admin boundary (requireAuth + requireAdmin at the mount, server.js);
// requireCapability('legal:manage') adds finer control (super-admins hold '*'). Freezes the
// exact published text + an unkeyed sha256 over its canonicalized bytes and makes it the
// current version. IMMUTABLE: re-registering the same (doc_key, version) with DIFFERENT text
// is rejected (409) — bump the version instead. Re-registering identical text is idempotent.
router.post('/admin/legal/versions', requireCapability('legal:manage'), async (req, res) => {
  try {
    const { doc_key, version, effective_at, content, content_hash: providedHash } = req.body ?? {};
    // PUBLISHABLE_ (not LEGAL_) — the content-rights attestation statement is versioned + hashed
    // through this same route, but is NOT consentable (see POST /legal/consent below).
    if (!PUBLISHABLE_DOC_KEYS.includes(doc_key)) return res.status(400).json({ error: 'Invalid doc_key' });
    if (!version || typeof version !== 'string') return res.status(400).json({ error: 'version required' });
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    if (!effective_at || Number.isNaN(Date.parse(effective_at))) {
      return res.status(400).json({ error: 'valid effective_at required' });
    }

    const contentHash = legalContentHash(content);
    if (providedHash && providedHash !== contentHash) {
      return res.status(400).json({ error: 'content_hash mismatch', expected: contentHash });
    }

    // Register + flip is_current — shared with scripts/publish-legal-version.mjs so the
    // immutability + one-current-per-doc rules exist in exactly one place.
    const result = await publishVersion({ docKey: doc_key, version, effectiveAt: effective_at, content });

    res.status(result.created ? 201 : 200).json({
      id: result.id,
      doc_key: result.docKey,
      version: result.version,
      effective_at: result.effectiveAt,
      content_hash: result.contentHash,
      is_current: true,
    });
  } catch (err) {
    if (err?.code === 'VERSION_CONTENT_MISMATCH') {
      return res.status(409).json({ error: err.message, version: req.body?.version });
    }
    serverError(req, res, err);
  }
});

// ── GET /api/legal/current ── current published version of each document (public metadata).
// The signup checkbox / first-login gate read this to know what to record against.
router.get('/legal/current', async (req, res) => {
  try {
    const versions = await getCurrentVersions();
    res.json({
      documents: versions.map(v => ({
        docKey: v.doc_key,
        version: v.version,
        id: v.id,
        effectiveAt: v.effective_at,
        contentHash: v.content_hash,
        required: CONSENT_REQUIRED_DOC_KEYS.includes(v.doc_key),
      })),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/legal/:docKey ── current published full text (for an in-app modal). Public.
// Declared AFTER /legal/current so that literal path wins.
router.get('/legal/:docKey', async (req, res) => {
  try {
    const { docKey } = req.params;
    // PUBLISHABLE_ — this is also how the designer fetches the current content-rights statement
    // to SHOW the baker the exact sentence they are about to affirm at publish time.
    if (!PUBLISHABLE_DOC_KEYS.includes(docKey)) return res.status(404).json({ error: 'Unknown document' });
    const { data, error } = await supabase
      .from('legal_document_versions')
      .select('doc_key, version, effective_at, content, content_hash')
      .eq('doc_key', docKey)
      .eq('is_current', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not published yet' });
    res.json({
      docKey: data.doc_key,
      version: data.version,
      effectiveAt: data.effective_at,
      contentHash: data.content_hash,
      content: data.content,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/legal/consent ── record the authenticated subject's acceptance of one or more
// current document versions. Idempotent per (subject, current version).
router.post('/legal/consent', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const subjectType = subjectTypeFor(req.role);
    if (!subjectType) return res.status(403).json({ error: 'No consenting principal' });

    let docKeys = req.body?.doc_keys;
    if (!Array.isArray(docKeys) || !docKeys.length) docKeys = [...CONSENT_REQUIRED_DOC_KEYS];
    docKeys = [...new Set(docKeys.filter(k => LEGAL_DOC_KEYS.includes(k)))];
    if (!docKeys.length) return res.status(400).json({ error: 'No valid doc_keys' });

    const source = CONSENT_SOURCE.ID_BY_NAME[req.body?.source] ?? CONSENT_SOURCE.GATE;

    const result = await recordConsent({
      subjectType,
      subjectId: req.user.id,
      docKeys,
      source,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json(result);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/legal/withdraw ── withdraw consent (DPDP §6(4)) for OPTIONAL documents only.
// A REQUIRED doc (tos/privacy) is necessary + bundled — you can't withdraw it and keep using the
// product, so we refuse here and point the client at the account-deletion flow (the account-delete
// route calls withdrawConsent() internally for those). Append-only: a withdrawal is a new event.
router.post('/legal/withdraw', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const subjectType = subjectTypeFor(req.role);
    if (!subjectType) return res.status(403).json({ error: 'No consenting principal' });

    let docKeys = req.body?.doc_keys;
    if (!Array.isArray(docKeys) || !docKeys.length) return res.status(400).json({ error: 'doc_keys required' });
    docKeys = [...new Set(docKeys.filter(k => LEGAL_DOC_KEYS.includes(k)))];
    if (!docKeys.length) return res.status(400).json({ error: 'No valid doc_keys' });

    const required = docKeys.filter(k => CONSENT_REQUIRED_DOC_KEYS.includes(k));
    if (required.length) {
      return res.status(409).json({ error: 'necessary_consent', action: 'delete_account', doc_keys: required });
    }

    const result = await withdrawConsent({
      subjectType,
      subjectId: req.user.id,
      docKeys,
      source: CONSENT_SOURCE.SETTINGS,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json(result);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/legal/consent/history ── the authed subject's OWN consent trail (accept + withdraw),
// newest first. Powers the "Your agreements" list + downloadable record.
router.get('/legal/consent/history', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const subjectType = subjectTypeFor(req.role);
    if (!subjectType) return res.status(403).json({ error: 'No consenting principal' });
    const events = await consentHistory(subjectType, req.user.id);
    res.json({ events });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
