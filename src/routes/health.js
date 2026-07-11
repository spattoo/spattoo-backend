import { Router } from 'express';
import { config } from '../config.js';

const router = Router();

// Liveness + WHICH BUILD is answering. The commit is the point: without it there is no way to ask a
// deployed API what code it is running, so "did my push actually deploy?" can only be answered by
// finding a behavioural difference — and if every new route is auth-gated (as they are under
// /api/admin), there may not be one you can see unauthenticated. Render injects RENDER_GIT_COMMIT on
// every deploy, and config.telemetry.release already reads it (falling back to RELEASE_VERSION), so
// this is free.
//
// The commit SHA is not a secret — it names a revision, and the repo is private. Nothing else about
// the environment is exposed here.
router.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    commit:    config.telemetry.release ?? null,   // null locally / when unset — absence is the answer
    env:       config.telemetry.environment,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEMPORARY — DELETE AFTER THE BACKGROUND-REMOVAL TIER DECISION.
//
// Measures what a segmentation model ACTUALLY costs on the deploy target. This cannot be measured
// on the dev machine: onnxruntime-node ships no darwin/x64 binding, so local numbers come from the
// WASM backend, which carries a large fixed heap (a 4 MB model measured 428 MB RSS). Those numbers
// are useless for choosing a Render instance tier, and guessing the tier is how we ended up
// planning to load a 1.5 GB model onto a 512 MB box.
//
// Deliberately unauthenticated: every /api/admin route is behind requireAdmin, and there is no admin
// token available to the one running this. It exposes nothing but memory/timing figures, runs at
// most once per model per deploy (cached), and executes in a CHILD PROCESS so an OOM kill cannot
// take the API down — a dead child IS the answer ("did not fit"), not an outage.
const benchCache = new Map();
router.get('/health/bg-bench', async (req, res) => {
  const model = String(req.query.model ?? 'silueta');
  if (!['silueta', 'isnet', 'u2net', 'u2netp'].includes(model)) {
    return res.status(400).json({ error: 'model must be silueta|isnet|u2net|u2netp' });
  }
  if (benchCache.has(model)) return res.json({ cached: true, ...benchCache.get(model) });

  const { execFile } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const url = String(req.query.image ?? '');

  // RSS WATCHDOG — the parent kills the child if its RESIDENT memory crosses `limitMb`.
  //
  // Two earlier attempts got this wrong, and both are worth recording:
  //   1. No cap at all → the child's allocation blew past the 512 MB container, the OOM killer took
  //      the whole API, and dev served 502s. Never run an unbounded memory experiment on a shared
  //      service.
  //   2. `ulimit -v` → caps VIRTUAL address space, and V8 reserves multiple GB of it regardless of
  //      actual usage, so Node died at startup (SIGTRAP) without ever loading the model. It measured
  //      nothing.
  // RSS is what the container's OOM killer actually accounts, so RSS is what we bound. Polling from
  // the parent (rather than self-limiting in the child) means the guard survives even if the child
  // is wedged.
  const limitMb = Math.min(300, Math.max(64, Number(req.query.limitMb) || 250));
  const args = ['scripts/bg-bench.mjs', model, ...(url ? [url] : [])];

  let peakChildMb = 0;
  let killedByWatchdog = false;
  const child = execFile(process.execPath, args, { timeout: 180_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    clearInterval(watch);
    let parsed = null;
    try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* child died */ }
    const result = parsed ?? {
      ok: false,
      model,
      limitMb,
      // Killed by the watchdog = the RESULT, not a fault: this model needs more resident memory than
      // `limitMb`. Raise the limit (within the container's headroom) and try again.
      error: killedByWatchdog
        ? `watchdog killed the child at ${peakChildMb} MB RSS (cap ${limitMb} MB) — needs more`
        : `child died: ${err?.message ?? 'no output'}`,
      peak_child_rss_mb: peakChildMb,
      signal: err?.signal ?? null,
      stderr: String(stderr).slice(-300),
    };
    result.peak_child_rss_mb = peakChildMb;   // what the PARENT observed — independent of the child's own report
    if (result.ok) benchCache.set(model, result);
    res.json(result);
  });

  // Poll the child's real RSS from /proc and kill it before it can threaten the container.
  const watch = setInterval(() => {
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const kb = Number(/VmRSS:\s+(\d+)\s+kB/.exec(status)?.[1] ?? 0);
      const rssMb = Math.round(kb / 1024);
      if (rssMb > peakChildMb) peakChildMb = rssMb;
      if (rssMb > limitMb) { killedByWatchdog = true; child.kill('SIGKILL'); clearInterval(watch); }
    } catch { /* child gone, or not linux — nothing to watch */ }
  }, 50);
});

export default router;
