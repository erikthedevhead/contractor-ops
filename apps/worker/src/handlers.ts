import { enqueue, withTenant, type Db, type Job } from '@co/db';
import { initialSync, processWebhookEvent, reconcile, type QboClient } from '@co/qbo';
import { logger, type Logger } from '@co/shared';
import { Q } from './queues';

export interface HandlerDeps {
  db: Db;
  clientFor: (tenantId: string) => QboClient;
  log?: Logger;
}

export type Handler = (job: Job, deps: HandlerDeps) => Promise<unknown>;

export const handlers: Record<string, Handler> = {
  [Q.webhookEvent]: async (job, { db, clientFor }) => {
    const { eventRowId } = job.payload as { eventRowId: string };
    return processWebhookEvent(db, clientFor(requireTenant(job)), eventRowId);
  },

  [Q.initialSync]: async (job, { db, clientFor, log }) => {
    return initialSync(db, clientFor(requireTenant(job)), { log: log ?? logger });
  },

  [Q.reconcile]: async (job, { db, clientFor, log }) => {
    const tenantId = requireTenant(job);
    const result = await reconcile(db, clientFor(tenantId), { log: log ?? logger });
    if (result.mode === 'needs_full_sync') {
      // Outside CDC's window: the only correct recovery is a full re-read.
      await withTenant(db, tenantId, (tx) => enqueue(tx, Q.initialSync, {}, { tenantId, singletonKey: `reconcile-fallback:${job.id}` }));
    }
    return result;
  },
};

function requireTenant(job: Job): string {
  if (!job.tenant_id) throw new Error(`job ${job.id} (${job.queue}) has no tenant`);
  return job.tenant_id;
}
