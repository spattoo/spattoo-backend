# Security Review — Shift-Left Strategy

## Principle
Security issues must be caught **before code reaches `dev`**, not at the `dev → main`
release PR — by then it's already integrated and too late. Two consequences:

- **CI cannot gate a direct push to `dev`** — it runs *after* the push lands. So the real
  "before-`dev`" gate is **local git hooks** (pre-commit + pre-push). As a solo dev, your
  machine is the only push origin, so local hooks are genuine enforcement, not just advisory.
- **Defense in depth** — layer several checks; each catches a *different class* of issue.
  No single tool covers everything.

## Security is not just secrets
Secret scanning is the cheapest, most automatable slice — but the highest-risk issues for a
multi-tenant SaaS are **not** caught by any cheap scanner.

| Class | Example (this app) | Caught by | Automatable? |
|---|---|---|---|
| **Secrets** | R2 / Supabase / Razorpay keys committed | gitleaks (or trufflehog) | ✅ cheap |
| **Vulnerable dependencies** | CVE in an npm package | `npm audit` / Dependabot | ✅ cheap |
| **Common insecure patterns** | `eval`, `child_process`, `dangerouslySetInnerHTML`, weak `Math.random` tokens, path traversal | Semgrep OSS + `eslint-plugin-security` | ✅ cheap, **shallow** |
| **Broken access control / IDOR** | baker A reads baker B's data; `/api/baker/*` route missing `requireCapability`; query not scoped by `baker_id` | custom Semgrep rules + AI/manual review | ⚠️ partial |
| **Business-logic / abuse** | trial-farming, race conditions, missing webhook HMAC verify, amount tampering | AI/manual review | ❌ manual |
| **Infra / config** | Supabase **RLS** off/permissive, wide-open CORS, public R2 bucket, missing security headers | manual checklist / audit | ❌ manual |

### The multi-tenant caveat (most important)
The #1 real risk is **broken tenant isolation** — a route missing an auth/capability check,
or a query missing `.eq('baker_id', …)`. Generic scanners miss this entirely because it's
*logic*, not a pattern. It must be covered by **custom rules encoding our invariants** and
**diff-scoped review**.

## The layered gate

| Layer | When | Checks | Blocks? |
|---|---|---|---|
| **pre-commit** | every commit | gitleaks on **staged** changes (secrets — earliest catch, before it's in history) + `eslint-plugin-security` | yes (local) |
| **pre-push** | before push to `dev` | gitleaks on the **pushed commit range** + `npm audit` + Semgrep (OSS + custom rules) + optional `/security-review` on the diff | yes (local) |
| **CI on push to `dev`** | after push lands | full gitleaks + Semgrep + audit | no — **backstop/alert** (catches `--no-verify`) |
| **`dev → main` PR (required check)** | release | same workflow as required status check | yes — **release gate** |

Flow: `commit` → secrets blocked instantly · `push` → full scan blocks before it leaves ·
CI on `dev` → backstop · `dev→main` → final gate. The first three fire before `dev` is affected.

## Tooling (zero / low cost)
- **gitleaks** — secret scanning (single binary; the free, private-repo-friendly equivalent
  of GitHub Push Protection). `brew install gitleaks`.
- **Dependabot** — free on private repos; enable in *Settings → Code security*. Vulnerable-dep
  alerts + auto-PRs.
- **Semgrep OSS** — free SAST; rulesets `p/javascript p/nodejs p/react p/secrets p/owasp-top-ten`,
  plus **custom rules** for our invariants.
- **eslint-plugin-security** — folded into `npm run verify`.
- **`/security-review`** (Claude Code) — AI review of the diff with codebase context; catches
  authz/logic patterns tools can't. Run at pre-push. (Token cost only.)
- **GitHub Secret Scanning + Push Protection** — free for **public** repos (server-side,
  unbypassable); **private** repos need paid GitHub Advanced Security → use gitleaks in CI instead.
- GitHub Actions free tier (2,000 private min/month) easily covers these — each run is seconds.

## Setup

**Shared hooks across all repos** (avoid per-repo copies):
```sh
mkdir -p ~/.config/git/hooks
git config --global core.hooksPath ~/.config/git/hooks   # or per-repo if you want Spattoo-only
```

**pre-commit**
```sh
gitleaks git --staged --no-banner || { echo "❌ secret in staged changes"; exit 1; }
npm run verify        # includes eslint-plugin-security
```

**pre-push** (scans only the commits being pushed)
```sh
#!/bin/sh
FAIL=0
while read local_ref local_sha remote_ref remote_sha; do
  case "$local_sha" in *0000000000000000*) continue ;; esac
  case "$remote_sha" in
    *0000000000000000*) RANGE="$local_sha" ;;
    *) RANGE="$remote_sha..$local_sha" ;;
  esac
  gitleaks git --no-banner --log-opts="$RANGE" || FAIL=1
done
npm audit --audit-level=high || FAIL=1
# optional SAST on the diff:
# semgrep --error --config p/javascript --config .semgrep/ $(git diff --name-only @{push} 2>/dev/null) || FAIL=1
[ "$FAIL" -eq 0 ] || { echo "❌ security check failed — push blocked"; exit 1; }
```

**CI backstop / release gate** — `.github/workflows/security.yml`
```yaml
name: security
on:
  push:        { branches: [dev] }
  pull_request: { branches: [main] }
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
      - uses: returntocorp/semgrep-action@v1
        with: { config: "p/javascript p/nodejs p/react p/secrets .semgrep/" }
      - run: npm audit --audit-level=high
```
Mark this a **required status check** on the protected-`main` ruleset.

## Custom Semgrep rules (encode our invariants) — `.semgrep/`
These catch the tenant-isolation class mechanically:
```yaml
rules:
  - id: baker-route-needs-capability
    languages: [js]
    severity: ERROR
    message: "Baker route defined without requireCapability() — possible broken access control."
    patterns:
      - pattern: router.$METHOD("/baker/...", ..., $HANDLER)
      - pattern-not: router.$METHOD("/baker/...", ..., requireCapability(...), ...)

  - id: tenant-scoped-query
    languages: [js]
    severity: WARNING
    message: "Query on a tenant table without an explicit baker_id scope — verify tenant isolation."
    patterns:
      - pattern: supabase.from("$T").select(...)
      - metavariable-regex: { metavariable: $T, regex: "^(orders|customers|baker_subscriptions|payments)$" }
      - pattern-not-inside: supabase.from("$T").select(...).eq("baker_id", ...)

  - id: no-dangerous-html
    languages: [js]
    severity: ERROR
    message: "dangerouslySetInnerHTML — XSS risk; sanitize or avoid."
    pattern: dangerouslySetInnerHTML={...}
```
(Tune to real route/query shapes; treat WARNINGs as review prompts, not hard fails.)

## Config / infra checklist (not in git — audit manually)
Re-check whenever a table, route, or bucket is added:
- **Supabase RLS** enabled + correct on every table (biggest risk — RLS off = anon key reads everything).
- API routes: `requireAuth` + `requireCapability` present; no route trusts client-supplied `baker_id`.
- **CORS** not `*`; only allow-listed origins.
- **R2 buckets** private; access via signed URLs only.
- **Webhook signatures** verified (Razorpay HMAC) before processing.
- No secrets/PII in logs; API responses don't leak internal fields.
- Security headers on the web app (CSP, HSTS, etc.).
- Supabase Auth "allow multiple accounts with same email" **off** (identity uniqueness).

## Summary
Automate the cheap classes (secrets, deps, patterns) at **pre-commit/pre-push**; cover the
expensive, high-risk classes (tenant isolation, business logic, RLS) with **custom Semgrep
rules + AI/manual diff review**. Run everything **before `dev`**, with CI + the release PR as
backstops — never as the first line.
