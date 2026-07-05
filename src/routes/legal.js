import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolvePrincipal } from '../middleware/rbac.js';
import { legalContentHash } from '../lib/legalHash.js';
import {
  LEGAL_DOC_KEYS,
  CONSENT_REQUIRED_DOC_KEYS,
  CONSENT_SUBJECT_TYPE,
  CONSENT_SOURCE,
} from '../constants/legalDocuments.js';
import { getCurrentVersions, recordConsent } from '../services/legalConsent.js';

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
    if (!LEGAL_DOC_KEYS.includes(doc_key)) return res.status(400).json({ error: 'Invalid doc_key' });
    if (!version || typeof version !== 'string') return res.status(400).json({ error: 'version required' });
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    if (!effective_at || Number.isNaN(Date.parse(effective_at))) {
      return res.status(400).json({ error: 'valid effective_at required' });
    }

    const contentHash = legalContentHash(content);
    if (providedHash && providedHash !== contentHash) {
      return res.status(400).json({ error: 'content_hash mismatch', expected: contentHash });
    }

    const { data: existing } = await supabase
      .from('legal_document_versions')
      .select('id, content_hash, effective_at')
      .eq('doc_key', doc_key)
      .eq('version', version)
      .maybeSingle();

    let row;
    if (existing) {
      if (existing.content_hash !== contentHash) {
        return res.status(409).json({
          error: 'version already published with different content — bump the version',
          version,
        });
      }
      row = existing; // idempotent re-register of identical text
    } else {
      const { data: inserted, error } = await supabase
        .from('legal_document_versions')
        .insert({ doc_key, version, effective_at, content_hash: contentHash, content, is_current: false })
        .select('id, effective_at')
        .single();
      if (error) throw error;
      row = inserted;
    }

    // Make it the sole current version. Unset the others FIRST so the one-current-per-doc
    // partial unique index is never violated mid-flight.
    const un = await supabase
      .from('legal_document_versions')
      .update({ is_current: false })
      .eq('doc_key', doc_key)
      .neq('id', row.id);
    if (un.error) throw un.error;
    const cur = await supabase
      .from('legal_document_versions')
      .update({ is_current: true })
      .eq('id', row.id);
    if (cur.error) throw cur.error;

    res.status(existing ? 200 : 201).json({
      id: row.id,
      doc_key,
      version,
      effective_at: row.effective_at ?? effective_at,
      content_hash: contentHash,
      is_current: true,
    });
  } catch (err) {
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
    if (!LEGAL_DOC_KEYS.includes(docKey)) return res.status(404).json({ error: 'Unknown document' });
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
    const subjectType =
      req.role === 'owner' || req.role === 'staff' ? CONSENT_SUBJECT_TYPE.BAKER_APPUSER
      : req.role === 'customer' ? CONSENT_SUBJECT_TYPE.CUSTOMER
      : null;
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

export default router;
