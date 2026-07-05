import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

export const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  tls: config.redis.url.startsWith('rediss://') ? {} : undefined,
});

export const jobQueue = new Queue('jobs', { connection });

// Cross-service queue: the billing → accounting seam (GST_INVOICING_PLAN.md Wave 2). The outbox relay
// (jobs/processors/relayBillingOutbox.js) PUBLISHES 'sale.charge_captured' events here; the separate
// spattoo-accounting service runs the CONSUMER worker on the same Redis. Core never processes this queue.
export const accountingQueue = new Queue(config.jobs.accountingQueueName, { connection });
