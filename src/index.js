import './config.js';
import app from './server.js';
import { startWorker } from './jobs/worker.js';
import { startSweeper } from './jobs/sweeper.js';
import { registerJobSchedulers } from './jobs/schedules.js';
import { config } from './config.js';
import { initTelemetry } from './lib/telemetry.js';

await initTelemetry();

startWorker();
startSweeper();
await registerJobSchedulers();   // BullMQ cron schedules (Redis-backed), executed by the worker

app.listen(config.port, () => {
  console.log(`API running on port ${config.port}`);
});
