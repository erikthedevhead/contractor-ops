import { withTenant, type Db, type Tx } from '@co/db';
import { logger as baseLogger, type Logger } from '@co/shared';
import type { QboClient } from './http';
import { upsertCustomer, upsertEstimate, upsertInvoice, upsertItem, upsertPayment } from './mirror';
import { queryAll } from './query';
import type { MirrorEntity, QboCustomer, QboEstimate, QboInvoice, QboItem, QboPayment } from './types';

// Reference data first, so transactions never point at a customer/item the mirror hasn't seen.
export const SYNC_ORDER: MirrorEntity[] = ['Customer', 'Item', 'Estimate', 'Invoice', 'Payment'];

export interface SyncStats { entity: MirrorEntity; fetched: number; changed: number }

/**
 * Full pull of every mirrored entity into Postgres. Safe to re-run: the
 * guarded upserts make it a no-op for rows that haven't changed. Each page is
 * its own transaction so a failure midway keeps completed pages.
 */
export async function initialSync(db: Db, client: QboClient, opts: { log?: Logger; entities?: MirrorEntity[] } = {}): Promise<SyncStats[]> {
  const log = opts.log ?? baseLogger;
  const tenantId = client.tenantId;
  const stats: SyncStats[] = [];

  for (const entity of opts.entities ?? SYNC_ORDER) {
    const startedAt = new Date();
    let fetched = 0;
    let changed = 0;
    for await (const page of queryAll<unknown>(client, entity)) {
      fetched += page.length;
      changed += await withTenant(db, tenantId, async (tx) => {
        let n = 0;
        for (const obj of page) if (await applyEntity(tx, tenantId, entity, obj)) n++;
        return n;
      });
    }
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('sync_cursors')
        .values({ tenant_id: tenantId, entity_name: entity, last_full_sync_at: startedAt })
        .onConflict((oc) => oc.columns(['tenant_id', 'entity_name']).doUpdateSet({ last_full_sync_at: startedAt }))
        .execute(),
    );
    log.info({ tenantId, entity, fetched, changed }, 'initial sync: entity done');
    stats.push({ entity, fetched, changed });
  }
  return stats;
}

export function applyEntity(tx: Tx, tenantId: string, entity: MirrorEntity, obj: unknown): Promise<boolean> {
  switch (entity) {
    case 'Customer': return upsertCustomer(tx, tenantId, obj as QboCustomer);
    case 'Item': return upsertItem(tx, tenantId, obj as QboItem);
    case 'Invoice': return upsertInvoice(tx, tenantId, obj as QboInvoice);
    case 'Estimate': return upsertEstimate(tx, tenantId, obj as QboEstimate);
    case 'Payment': return upsertPayment(tx, tenantId, obj as QboPayment);
  }
}
