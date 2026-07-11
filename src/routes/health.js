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

export default router;
