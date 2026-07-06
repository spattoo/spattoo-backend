import { Worker } from 'bullmq';
import { connection } from './queue.js';
import { extractImage } from './processors/extractImage.js';
import { autoTag } from './processors/autoTag.js';
import { sendNotification } from './processors/sendNotification.js';
import { removeLogoBg } from './processors/removeLogoBg.js';
import { optimizePhoto } from './processors/optimizePhoto.js';
import { reconcileSubscriptions } from './processors/reconcileSubscriptions.js';
import { relayBillingOutbox } from './processors/relayBillingOutbox.js';
import { eraseExpiredAccounts } from './processors/eraseExpiredAccounts.js';

const processors = {
  extract_image:           extractImage,
  auto_tag:                autoTag,
  send_notification:       sendNotification,
  remove_logo_bg:          removeLogoBg,
  optimize_photo:          optimizePhoto,
  reconcile_subscriptions: reconcileSubscriptions,
  relay_billing_outbox:    relayBillingOutbox,
  erase_expired_accounts:  eraseExpiredAccounts,
};

export function startWorker() {
  const worker = new Worker('jobs', async job => {
    const processor = processors[job.name];
    if (!processor) throw new Error(`Unknown job type: ${job.name}`);
    await processor(job.data);
  }, { connection });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} (${job?.name}) failed:`, err.message);
  });

  console.log('Worker started');
  return worker;
}
