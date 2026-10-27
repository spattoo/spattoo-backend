/* ── Questions the assistant will not try to answer ──────────────────────────────────────────────
 *
 * Sandeep: *"if a baker tries to prob for some business information like 'howmany bakers are
 * subscribed to spattoo?'. we should be careful here."*
 *
 * ⚠️ FIRST, WHAT THIS IS NOT. It is not what stops business information leaking — nothing can leak,
 * because nothing is there. Audited 2026-10-27: the index holds 58 articles, every one
 * `audience: baker` and `status: live`, and **zero** sections mention revenue, subscribers,
 * competitors, investors, churn, margins or a roadmap. And `searchHelp(question, …)` takes the
 * question text and nothing else, so no account or platform data reaches retrieval at any point.
 * The safeguard is an absent code path. This is a courtesy on top of it.
 *
 * What it fixes is dignity. Asked "how many bakers are subscribed to spattoo?", the assistant
 * returned four confident cards headed *Writing a cake order yourself* (0.434). Nothing leaked —
 * but a baker who asks something we should not answer and gets a page of unrelated instructions
 * learns the thing does not understand them, and stops asking it anything.
 *
 * ⚠️ AND IT IS NARROW ON PURPOSE, because the obvious version is dangerous. Measured:
 *
 *     "how many orders did I get last month"   0.490  — a real question, answered
 *     "how do I see my revenue"                0.381  — a real question
 *     "how many bakers are subscribed"         0.434  — a probe
 *
 * A word list on *revenue*, *earnings* or *how many* blocks the first two. The difference is never
 * the words — it is WHOSE DATA IT IS. So every pattern below has to name Spattoo or somebody else's
 * bakery, and anything about "my" or "our" falls straight through to a normal search.
 *
 * ⚠️ IT RUNS BEFORE RETRIEVAL, which is where it must stay. Deterministic, auditable, and
 * independent of whatever answers the question — so it still holds the day a model is doing the
 * writing, when "it won't say that" stops being a property of the code and becomes a sentence in
 * a prompt.
 */

/** Why a question was declined. The panel shows a different sentence for each. */
export const SCOPE = Object.freeze({
  BUSINESS: 'business',   // Spattoo the company, rather than using Spattoo
  OTHERS:   'others',     // another bakery's data
  SECURITY: 'security',   // credentials
});

/* ⚠️ EVERY PATTERN NAMES THE SUBJECT. "how many bakers" is unambiguous — a baker has no bakers.
   "my" and "our" are excluded explicitly where the noun could go either way. */
const RULES = Object.freeze([
  // ── Spattoo the business ──────────────────────────────────────────────────────────────────────
  { re: /\bhow many (bakers|bakeries|users|customers|subscribers|shops)\b(?!.*\b(my|our)\b)/i, why: SCOPE.BUSINESS },
  { re: /\b(spattoo'?s|your company'?s|the company'?s)\s+(revenue|turnover|profit|margin|earnings|valuation|funding|investors?|roadmap|plans?|strategy|customers?|users?)\b/i, why: SCOPE.BUSINESS },
  { re: /\bhow much (money |revenue )?does spattoo (make|earn)\b/i, why: SCOPE.BUSINESS },
  { re: /\b(who are|list) (spattoo'?s? |your )?competitors?\b/i, why: SCOPE.BUSINESS },
  { re: /\bspattoo'?s? (roadmap|valuation|investors?|funding)\b/i, why: SCOPE.BUSINESS },
  /* ⚠️ EITHER ORDER, because "across spattoo" lands at the end as often as the front — "how many
     cakes were ordered last month across spattoo". And the phrase has to be an explicitly
     platform-wide one: "on spattoo" would catch "how do I take an order on spattoo", which is a
     perfectly ordinary question. */
  { re: /(?=.*\b(across spattoo|platform[- ]wide|in total across|spattoo in total)\b)(?=.*\b(orders?|cakes?|bakers?|bakeries|revenue|users?)\b)/i, why: SCOPE.BUSINESS },
  { re: /\bwhich bakery is the (biggest|largest|best|top)\b/i, why: SCOPE.BUSINESS },

  // ── Somebody else's bakery ────────────────────────────────────────────────────────────────────
  { re: /\b(other|another|someone else'?s|other bakers'?|different) (baker'?s?|bakery'?s?|bakeries'?)\b/i, why: SCOPE.OTHERS },
  { re: /\bshow me (other|another|someone else'?s)\b/i, why: SCOPE.OTHERS },

  // ── Credentials ───────────────────────────────────────────────────────────────────────────────
  /* "my password" is a real question — Changing your password answers it at 0.632 — so this names
     somebody else's or an administrative one, never a bare "password". */
  { re: /\b(admin|administrator|root|someone else'?s|another user'?s|the baker'?s)\s+(password|login|credentials?|api key|token)\b/i, why: SCOPE.SECURITY },
  { re: /\b(database|service[- ]role|supabase|razorpay|openai)\s+(key|password|secret|credentials?)\b/i, why: SCOPE.SECURITY },
]);

/**
 * Why we will not answer this, or null to carry on and search.
 *
 * Pure and gated, for the reason helpRank.js is: a rule nobody can exercise is a rule that quietly
 * blocks the wrong thing.
 */
export function outOfScope(question) {
  const q = String(question ?? '');
  if (!q.trim()) return null;
  for (const { re, why } of RULES) if (re.test(q)) return why;
  return null;
}
