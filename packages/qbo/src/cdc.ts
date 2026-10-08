import { withTenant, type Db } from '@co/db';
import { logger as baseLogger, type Logger } from '@co/shared';
import type { QboClient } from './http';
import { markDeleted } from './mirror';
import { queryAll } from './query';
import { applyEntity, SYNC_ORDER } from './sync';
import type { MirrorEntity } from './types';

/** Intuit's CDC limits. */
export const CDC_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const CDC_MAX_OBJECTS = 1000;
/** Re-read a little before the last high-water mark: clocks drift, and re-applying is free. */
const OVERLAP_MS = 5 * 60 * 1000;

export type ReconcileResult =
  | { mode: 'needs_full_sync'; reason: string }
  | { mode: 'cdc'; since: string; applied: Record<string, number>; fellBackToQuery: MirrorEntity[] };

/**
 * Nightly safety net for missed webhooks.
 *
 * CDC returns everything changed since `changedSince` (no upper bound), capped
 * at 1000 objects per entity and 30 days of history. So:
 * - older than ~30 days, or never synced -> caller schedules a full sync
 * - an entity that hits the cap -> re-read it with a paged query on
 *   MetaData.LastUpdatedTime (tombstones from CDC are still applied)
 * The high-water mark is the moment the CDC request started.
 */
export async function reconcile(db: Db, client: QboClient, opts: { now?: () => Date; log?: Logger; maxObjects?: number } = {}): Promise<ReconcileResult> {
  const cap = opts.maxObjects ?? CDC_MAX_OBJECTS;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? baseLogger;
  const tenantId = client.tenantId;

  const cursors = await withTenant(db, tenantId, (tx) => tx.selectFrom('sync_cursors').selectAll().execute());
  const marks = SYNC_ORDER.map((e) => {
    const c = cursors.find((x) => x.entity_name === e);
    const times = [c?.cdc_through, c?.last_full_sync_at].filter((t): t is Date => t instanceof Date);
    return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
  });
  if (marks.some((m) => m === null)) return { mode: 'needs_full_sync', reason: 'an entity has never been synced' };
  const oldest = new Date(Math.min(...marks.map((m) => m!.getTime())));
  const startedAt = now();
  if (startedAt.getTime() - oldest.getTime() > CDC_MAX_LOOKBACK_MS - 60 * 60 * 1000) {
    return { mode: 'needs_full_sync', reason: 'last sync is older than the CDC 30-day window' };
  }

  const since = new Date(oldest.getTime() - OVERLAP_MS);
  const res = await client.get<{ CDCResponse?: Array<{ QueryResponse?: Array<Record<string, unknown>> }> }>('/cdc', {
    query: { entities: SYNC_ORDER.join(','), changedSince: since.toISOString() },
    entityName: 'CDC',
  });

  const byEntity = new Map<MirrorEntity, Array<Record<string, unknown>>>();
  for (const qr of res.CDCResponse?.[0]?.QueryResponse ?? []) {
    for (const e of SYNC_ORDER) {
      const list = qr[e];
      if (Array.isArray(list)) byEntity.set(e, [...(byEntity.get(e) ?? []), ...(list as Array<Record<string, unknown>>)]);
    }
  }

  const applied: Record<string, number> = {};
  const fellBackToQuery: MirrorEntity[] = [];
  for (const entity of SYNC_ORDER) {
    const objs = byEntity.get(entity) ?? [];
    let n = 0;
    // Tombstones first (only CDC reports deletes).
    const tombstones = objs.filter((o) => o.status === 'Deleted');
    const live = objs.filter((o) => o.status !== 'Deleted');
    n += await withTenant(db, tenantId, async (tx) => {
      let k = 0;
      for (const t of tombstones) if (await markDeleted(tx, tenantId, entity, String(t.Id))) k++;
      return k;
    });

    if (objs.length >= cap) {
      fellBackToQuery.push(entity);
      log.warn({ tenantId, entity }, 'CDC cap reached; falling back to paged query');
      for await (const page of queryAll<unknown>(client, entity, `MetaData.LastUpdatedTime >= '${since.toISOString()}'`)) {
        n += await withTenant(db, tenantId, async (tx) => {
          let k = 0;
          for (const o of page) if (await applyEntity(tx, tenantId, entity, o)) k++;
          return k;
        });
      }
    } else {
      n += await withTenant(db, tenantId, async (tx) => {
        let k = 0;
        for (const o of live) if (await applyEntity(tx, tenantId, entity, o)) k++;
        return k;
      });
    }
    applied[entity] = n;
  }

  await withTenant(db, tenantId, async (tx) => {
    for (const entity of SYNC_ORDER) {
      await tx.insertInto('sync_cursors')
        .values({ tenant_id: tenantId, entity_name: entity, cdc_through: startedAt })
        .onConflict((oc) => oc.columns(['tenant_id', 'entity_name']).doUpdateSet({ cdc_through: startedAt }))
        .execute();
    }
  });
  log.info({ tenantId, since: since.toISOString(), applied, fellBackToQuery }, 'cdc reconcile complete');
  return { mode: 'cdc', since: since.toISOString(), applied, fellBackToQuery };
}
