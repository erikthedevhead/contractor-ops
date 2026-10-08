import { sql } from 'kysely';
import { withTenant, type Db } from '@co/db';
import { isAppError } from '@co/shared';
import type { QboClient } from './http';
import { markDeleted } from './mirror';
import { applyEntity } from './sync';
import type { MirrorEntity } from './types';
import { mirrorEntityFor } from './webhooks';

export type EventOutcome = 'applied' | 'unchanged' | 'deleted' | 'ignored';

/**
 * Applies one stored webhook event to the mirror.
 *
 * The CloudEvents envelope says *what* changed, not the new state, so for
 * anything other than a delete we fetch the current object. Because we always
 * fetch current state and the upsert is version-guarded, processing events
 * out of order, twice, or late all converge on the same correct row.
 */
export async function processWebhookEvent(db: Db, client: QboClient, eventRowId: string): Promise<EventOutcome> {
  const tenantId = client.tenantId;
  const ev = await withTenant(db, tenantId, async (tx) => {
    const row = await tx.selectFrom('webhook_events').selectAll().where('id', '=', eventRowId).forUpdate().executeTakeFirst();
    if (row) await tx.updateTable('webhook_events').set({ status: 'processing', attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    return row;
  });
  if (!ev) return 'ignored'; // tenant deleted, or the event belongs to someone else (RLS)

  const entity = mirrorEntityFor(ev.entity_name);
  try {
    let outcome: EventOutcome;
    if (!entity) {
      outcome = 'ignored';
    } else if (ev.operation === 'deleted') {
      outcome = (await withTenant(db, tenantId, (tx) => markDeleted(tx, tenantId, entity, ev.entity_id))) ? 'deleted' : 'unchanged';
    } else {
      outcome = await fetchAndApply(db, client, entity, ev.entity_id);
      if (ev.operation === 'merged' && entity === 'Customer') {
        const loserId = mergedAwayId(ev.data);
        if (loserId) await withTenant(db, tenantId, (tx) => markDeleted(tx, tenantId, 'Customer', loserId, ev.entity_id));
      }
    }

    await withTenant(db, tenantId, async (tx) => {
      await tx.updateTable('webhook_events')
        .set({ status: outcome === 'ignored' ? 'ignored' : 'processed', processed_at: new Date(), last_error: null })
        .where('id', '=', ev.id).execute();
      if (entity) {
        await tx.insertInto('sync_cursors')
          .values({ tenant_id: tenantId, entity_name: entity, last_event_time: ev.event_time })
          .onConflict((oc) => oc.columns(['tenant_id', 'entity_name']).doUpdateSet({
            last_event_time: sql`greatest(sync_cursors.last_event_time, excluded.last_event_time)`,
          }))
          .execute();
      }
    });
    return outcome;
  } catch (err) {
    await withTenant(db, tenantId, (tx) =>
      tx.updateTable('webhook_events')
        .set({ status: 'failed', last_error: isAppError(err) ? `${err.code}: ${err.message}` : String(err) })
        .where('id', '=', ev.id).execute(),
    );
    throw err;
  }
}

/** GET the entity's current state and apply it; "not found" means it was deleted. */
export async function fetchAndApply(db: Db, client: QboClient, entity: MirrorEntity, id: string): Promise<EventOutcome> {
  const tenantId = client.tenantId;
  let obj: unknown;
  try {
    const res = await client.get<Record<string, unknown>>(`/${entity.toLowerCase()}/${encodeURIComponent(id)}`, { entityName: entity });
    obj = res[entity];
  } catch (err) {
    if (isAppError(err) && err.code === 'QBO_NOT_FOUND') {
      return (await withTenant(db, tenantId, (tx) => markDeleted(tx, tenantId, entity, id))) ? 'deleted' : 'unchanged';
    }
    throw err;
  }
  if (!obj) throw new Error(`QuickBooks returned no ${entity} for id ${id}`);
  const changed = await withTenant(db, tenantId, (tx) => applyEntity(tx, tenantId, entity, obj));
  return changed ? 'applied' : 'unchanged';
}

/** Merge events may name the absorbed record in `data`; the field name isn't pinned down, so look for it loosely. */
function mergedAwayId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (/deleted.?id|merged.?from|source.?id/i.test(k) && (typeof v === 'string' || typeof v === 'number')) return String(v);
  }
  return null;
}
