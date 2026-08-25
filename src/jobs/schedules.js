import { jobQueue } from './queue.js';
import { config } from '../config.js';

// Register repeatable (cron) job schedulers in Redis. Idempotent via upsert — safe to call on every
// boot and from every instance: BullMQ dedupes on the scheduler id, so each scheduled tick produces
// exactly ONE job regardless of how many API instances are running (no per-instance duplication, no
// drift across restarts — the schedule lives in Redis, not process memory). The jobs are executed by
// the worker's processors map (jobs/worker.js).
export async function registerJobSchedulers() {
  await jobQueue.upsertJobScheduler(
    'reconcile-subscriptions',
    { pattern: config.jobs.reconcileCron, tz: 'UTC' },
    { name: 'reconcile_subscriptions', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await jobQueue.upsertJobScheduler(
    'relay-billing-outbox',
    { pattern: config.jobs.outboxRelayCron, tz: 'UTC' },
    { name: 'relay_billing_outbox', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await jobQueue.upsertJobScheduler(
    'erase-expired-accounts',
    { pattern: config.jobs.eraseAccountsCron, tz: 'UTC' },
    { name: 'erase_expired_accounts', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await jobQueue.upsertJobScheduler(
    'send-delivery-digest',
    { pattern: config.jobs.deliveryDigestCron, tz: 'UTC' },
    { name: 'send_delivery_digest', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  await jobQueue.upsertJobScheduler(
    'send-trial-reminders',
    { pattern: config.jobs.trialReminderCron, tz: 'UTC' },
    { name: 'send_trial_reminders', opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  console.log(
    `Job schedulers registered (reconcile_subscriptions: "${config.jobs.reconcileCron}" UTC; ` +
    `relay_billing_outbox: "${config.jobs.outboxRelayCron}" UTC; ` +
    `erase_expired_accounts: "${config.jobs.eraseAccountsCron}" UTC; ` +
    `send_delivery_digest: "${config.jobs.deliveryDigestCron}" UTC, day in ${config.jobs.deliveryDigestTz}; ` +
    `send_trial_reminders: "${config.jobs.trialReminderCron}" UTC, day in ${config.jobs.trialReminderTz})`,
  );
}
