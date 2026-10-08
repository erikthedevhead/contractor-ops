import { asSystem, enqueue, type Db } from '@co/db';
import { mirrorEntityFor, parseCloudEvents, verifyIntuitSignature, type QboEnvironment } from '@co/qbo';
import { logger as baseLogger, type Logger } from '@co/shared';
import { Q } from '@co/worker';

export interface IngestInput {
  rawBody: Buffer;
  signature: string | undefined;
  verifierToken: string;
  environment: QboEnvironment;
}

export interface IngestResult {
  status: 200 | 401;
  deliveryId: string;
  accepted: number;     // new events queued for processing
  duplicates: number;   // event ids we had already seen
  ignored: number;      // unknown realm or entity we don't mirror
  rejected: number;     // malformed envelopes (kept in the raw delivery)
}

/**
 * Webhook ingestion. Contract with Intuit: answer within 3 seconds, and
 * anything unacknowledged blocks later events. So this does the minimum:
 *   1. persist the raw delivery (even with a bad signature, for forensics)
 *   2. verify the signature over the raw bytes
 *   3. record each event, deduped on the CloudEvents id, and enqueue its
 *      processing job in the SAME transaction (no event without a job, no job
 *      without an event)
 * All QuickBooks API calls happen later, in the worker.
 */
export async function ingestDelivery(db: Db, input: IngestInput, log: Logger = baseLogger): Promise<IngestResult> {
  const valid = verifyIntuitSignature(input.rawBody, input.signature, input.verifierToken);
  const rawText = input.rawBody.toString('utf8');

  const delivery = await db
    .insertInto('webhook_deliveries')
    .values({ signature: input.signature ?? null, signature_valid: valid, raw_body: rawText })
    .returning('id')
    .executeTakeFirstOrThrow();
  const result: IngestResult = { status: 200, deliveryId: delivery.id, accepted: 0, duplicates: 0, ignored: 0, rejected: 0 };

  if (!valid) {
    log.warn({ deliveryId: delivery.id }, 'webhook signature invalid; stored, not processed');
    return { ...result, status: 401 };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    log.error({ deliveryId: delivery.id }, 'webhook body is not JSON; stored for inspection');
    return result; // 200: retrying an unparseable body will never succeed
  }

  const { events, rejected } = parseCloudEvents(body);
  result.rejected = rejected.length;
  if (rejected.length) log.warn({ deliveryId: delivery.id, rejected }, 'malformed webhook events');

  await asSystem(db, 'webhook ingestion: route realm -> tenant', async (tx) => {
    const realms = [...new Set(events.map((e) => e.realmId))];
    const conns = realms.length
      ? await tx.selectFrom('qbo_connections').select(['tenant_id', 'realm_id'])
          .where('environment', '=', input.environment).where('realm_id', 'in', realms).execute()
      : [];
    const tenantByRealm = new Map(conns.map((c) => [c.realm_id, c.tenant_id]));

    for (const e of events) {
      const tenantId = tenantByRealm.get(e.realmId) ?? null;
      const mirrored = mirrorEntityFor(e.entityName) !== null;
      const inserted = await tx
        .insertInto('webhook_events')
        .values({
          delivery_id: delivery.id,
          event_id: e.eventId,
          tenant_id: tenantId,
          realm_id: e.realmId,
          event_type: e.eventType,
          entity_name: e.entityName,
          operation: e.operation,
          entity_id: e.entityId,
          event_time: e.eventTime,
          data: e.data === null ? null : JSON.stringify(e.data),
          status: tenantId && mirrored ? 'received' : 'ignored',
        })
        .onConflict((oc) => oc.column('event_id').doNothing())
        .returning('id')
        .executeTakeFirst();

      if (!inserted) {
        result.duplicates++;
      } else if (tenantId && mirrored) {
        await enqueue(tx, Q.webhookEvent, { eventRowId: inserted.id }, { tenantId, singletonKey: e.eventId });
        result.accepted++;
      } else {
        result.ignored++;
      }
    }
    await tx.updateTable('webhook_deliveries').set({ event_count: events.length }).where('id', '=', delivery.id).execute();
  });

  log.info(result, 'webhook delivery ingested');
  return result;
}
