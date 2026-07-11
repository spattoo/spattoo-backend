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
  const url = String(req.query.image ?? '');
  const args = ['scripts/bg-bench.mjs', model, ...(url ? [url] : [])];

  execFile(process.execPath, args, { timeout: 180_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    let parsed = null;
    try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* child died */ }
    const result = parsed ?? {
      ok: false,
      model,
      // No JSON back = the child was killed. On Render that is almost always the OOM killer, which
      // is itself the measurement: this model does not fit in this instance's memory.
      error: err?.killed ? 'child killed (timeout or OOM)' : (err?.message ?? 'no output from child'),
      signal: err?.signal ?? null,
      stderr: String(stderr).slice(-400),
    };
    if (result.ok) benchCache.set(model, result);
    res.json(result);
  });
});

export default router;
