import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolvePrincipal } from '../middleware/rbac.js';
import { legalContentHash } from '../lib/legalHash.js';
import { config } from '../config.js';
import {
  LEGAL_DOC_KEYS,
  PUBLISHABLE_DOC_KEYS,
  CONSENT_REQUIRED_DOC_KEYS,
  CONSENT_SUBJECT_TYPE,
  CONSENT_SOURCE,
} from '../constants/legalDocuments.js';
import { getCurrentVersions, recordConsent, withdrawConsent, consentHistory, publishVersion } from '../services/legalConsent.js';

/**
 * A human date ("6 September 2026") as `YYYY-MM-DD`, or null if it cannot be parsed.
 *
 * Deliberately NOT `new Date(s).toISOString().slice(0,10)`. That parses to LOCAL midnight and then
 * converts to UTC, so on any server east of Greenwich it lands on the previous day — measured, it
 * turned "6 September 2026" into 2026-09-05. Reading the calendar fields back on the same local
 * basis they were parsed in returns the date the string actually names, in any zone.
 */
function isoDateOf(human) {
  if (!human || Number.isNaN(Date.parse(human))) return null;
  const d = new Date(human);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Resolve the consenting subject (baker app-user vs invited customer) from the authed principal.
// Shared by consent / withdraw / history so the mapping never drifts. Returns a smallint or null.
function subjectTypeFor(role) {
  if (role === 'owner' || role === 'staff') return CONSENT_SUBJECT_TYPE.BAKER_APPUSER;
  if (role === 'customer') return CONSENT_SUBJECT_TYPE.CUSTOMER;
  return null;
}

// Consent capture (DPDP "Layer 2"). See docs/CONSENT_CAPTURE_PLAN.md.
const router = Router();

// ── GET /api/admin/legal/preview?doc=privacy ──────────────────────────────────
// What the marketing site is SERVING right now, next to what is FROZEN in the database.
//
// The problem it solves: legal text is authored in git and rendered by the marketing site, but the
// evidence a consent record points at lives in `legal_document_versions`. Those are two stores, and
// a deploy updates only the first. Privacy v1.1 shipped to the website while the database still said
// v1.0 — the site showed the analytics disclosure and the in-app modal served the old text that said
// the opposite, with nothing anywhere reporting the split.
//
// Until now the only way to close it was scripts/publish-legal-version.mjs, run by hand with every
// {{TOKEN}} passed on the command line. That works and is easy to get subtly wrong: a mistyped
// token or a stale --version produces a frozen document that does not match the page, and a hash
// nobody notices is wrong until somebody disputes a consent.
//
// So the API fetches the site's own canonical text SERVER-SIDE (no CORS, no credentials — those are
// published legal documents) and hands back both sides plus the hash. The admin screen shows the
// difference; the publish button below freezes exactly these bytes. Nothing is retyped, so nothing
// can be mistyped.
router.get('/admin/legal/preview', requireAuth, requireCapability('legal:manage'), async (req, res) => {
  try {
    const docKey = String(req.query.doc ?? '');
    if (!PUBLISHABLE_DOC_KEYS.includes(docKey)) return res.status(400).json({ error: 'Invalid doc' });

    // The marketing site is the authoring source of truth, derived from the same base domain
    // everything else here is, so dev reads dev and prod reads prod with no extra variable to set
    // wrong. `content-rights` is authored in THIS repo, not on the site — it has no page.
    const base = config.marketing?.url;
    if (!base) return res.status(501).json({ error: 'No marketing URL configured for this environment' });

    let site = null;
    let fetchError = null;
    try {
      const r = await fetch(`${base}/api/legal/${encodeURIComponent(docKey)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) site = await r.json();
      else fetchError = `site returned HTTP ${r.status}`;
    } catch (err) {
      fetchError = err?.message ?? String(err);
    }

    const [current] = await getCurrentVersions([docKey]);

    // Hash the site's bytes with the SAME function publishVersion uses, so "identical" here means
    // identical there — never a second implementation that can drift from the one that matters.
    const siteHash = site?.content ? legalContentHash(site.content) : null;

    res.json({
      docKey,
      // What the database holds today. Null when this document has never been published.
      published: current
        ? { version: current.version, effectiveAt: current.effective_at, contentHash: current.content_hash }
        : null,
      // What the website is serving today. Null if the site could not be reached.
      site: site
        ? {
            version: site.version,
            effectiveDate: site.effectiveDate,
            // Normalised HERE, not in the browser. The site carries a human date ("6 September
            // 2026") because that is what a reader should see; POST /versions needs something
            // Date.parse accepts. Doing the conversion server-side means one implementation, and a
            // date that cannot be parsed surfaces as null on the screen — which disables the
            // publish button — instead of failing at the moment of writing evidence.
            //
            // ⚠️ NOT toISOString(). `new Date('6 September 2026')` is LOCAL midnight, and
            // toISOString() then converts to UTC — which in IST (+05:30) rolls back to the 5th.
            // Verified: it produced 2026-09-05, one day before the date the document itself states.
            // An effective date is the moment a legal document binds; a silent day-early is exactly
            // the kind of wrong that only surfaces in a dispute. Reading the calendar fields back
            // with the same local basis they were parsed in keeps the date the string denoted,
            // whatever zone the server runs in.
            effectiveAtIso: isoDateOf(site.effectiveDate),
            status: site.status,
            publishable: site.publishable,
            unresolvedTokens: site.unresolvedTokens ?? [],
            contentHash: siteHash,
            bytes: Buffer.byteLength(site.content, 'utf8'),
            content: site.content,
          }
        : null,
      fetchError,
      // The single question the screen exists to answer. Compared on the HASH, not the version
      // string: a version can be edited in place before publication, and it is the bytes that a
      // consent record is evidence of.
      inSync: Boolean(current && siteHash && current.content_hash === siteHash),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

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

// ── GET /api/legal/:docKey ── published full text (for an in-app modal). Public.
// Declared AFTER /legal/current so that literal path wins.
//
// ?version=1.0 returns THAT version instead of the current one. Without it, a baker whose record
// says "you accepted tos v1.0" has no way to read v1.0 once v1.1 is current — the page would show
// them a document they never agreed to. The text is already frozen in the row; this is the only
// thing that was missing to hand it back.
//
// Any published version is fetchable, not only ones the caller consented to. These are published
// legal documents: the current one is world-readable at /terms, and an old one is no more private.
// Gating it would also mean this endpoint could no longer serve the unauthenticated storefront.
router.get('/legal/:docKey', async (req, res) => {
  try {
    const { docKey } = req.params;
    const { version } = req.query;
    // PUBLISHABLE_ — this is also how the designer fetches the current content-rights statement
    // to SHOW the baker the exact sentence they are about to affirm at publish time.
    if (!PUBLISHABLE_DOC_KEYS.includes(docKey)) return res.status(404).json({ error: 'Unknown document' });
    let q = supabase
      .from('legal_document_versions')
      .select('doc_key, version, effective_at, content, content_hash')
      .eq('doc_key', docKey);
    q = version ? q.eq('version', String(version)) : q.eq('is_current', true);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({
        error: version ? `No version ${version} of ${docKey}` : 'Not published yet',
      });
    }
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
