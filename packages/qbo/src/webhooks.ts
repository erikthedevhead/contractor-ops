import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { MirrorEntity } from './types';

/**
 * Intuit webhook signature: base64(HMAC-SHA256(verifierToken, rawBody)) in the
 * `intuit-signature` header. Must be computed over the exact bytes received,
 * before any JSON parsing or re-serialization.
 */
export function verifyIntuitSignature(rawBody: Buffer, signature: string | undefined, verifierToken: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', verifierToken).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** One CloudEvents envelope as Intuit sends it. Unknown fields are kept. */
const CloudEvent = z
  .object({
    id: z.string().min(1),
    type: z.string().regex(/^qbo\.[a-z]+\.[a-z]+\.v\d+$/i),
    time: z.string().min(1),
    intuitentityid: z.coerce.string().min(1),
    intuitaccountid: z.coerce.string().min(1),
    specversion: z.string().optional(),
    source: z.string().optional(),
    data: z.unknown().optional(),
  })
  .loose();

export interface ParsedEvent {
  format: 'cloudevents' | 'legacy';
  eventId: string;
  eventType: string;
  entityName: string;   // lower-case as sent: invoice, customer, ...
  operation: string;    // created | updated | deleted | merged | voided | ...
  entityId: string;
  realmId: string;
  eventTime: Date;
  data: unknown;
}

export interface ParseResult {
  events: ParsedEvent[];
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Parses a notification body. Accepts a batch (array) or a single envelope.
 * Malformed entries are reported, not thrown: one bad event must not cause
 * the whole delivery to be refused (Intuit would just redeliver it forever).
 */
export function parseCloudEvents(body: unknown): ParseResult {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const events: ParsedEvent[] = [];
  const rejected: ParseResult['rejected'] = [];
  list.forEach((raw, index) => {
    const r = CloudEvent.safeParse(raw);
    if (!r.success) {
      rejected.push({ index, reason: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const [, entity, operation] = r.data.type.split('.');
    const time = new Date(r.data.time);
    if (Number.isNaN(time.getTime())) {
      rejected.push({ index, reason: 'time: not a timestamp' });
      return;
    }
    events.push({
      format: 'cloudevents',
      eventId: r.data.id,
      eventType: r.data.type,
      entityName: entity!.toLowerCase(),
      operation: operation!.toLowerCase(),
      entityId: r.data.intuitentityid,
      realmId: r.data.intuitaccountid,
      eventTime: time,
      data: r.data.data ?? null,
    });
  });
  return { events, rejected };
}

const MIRRORED: Record<string, MirrorEntity> = {
  customer: 'Customer', item: 'Item', invoice: 'Invoice', estimate: 'Estimate', payment: 'Payment',
};

export function mirrorEntityFor(entityName: string): MirrorEntity | null {
  return MIRRORED[entityName.toLowerCase()] ?? null;
}

/**
 * Intuit's legacy webhook format, still sent when an app's "CloudEvents
 * payload" setting is disabled:
 *   {"eventNotifications":[{"realmId":"...","dataChangeEvent":{"entities":[
 *     {"name":"Payment","id":"247","operation":"Create","lastUpdated":"..."}]}}]}
 * It has no event id, so we derive a deterministic one from
 * (realm, entity, id, operation, lastUpdated): a redelivery of the same change
 * produces the same id and is deduped exactly like a CloudEvents retry.
 */
const LegacyEntity = z
  .object({
    name: z.string().min(1),
    id: z.coerce.string().min(1),
    operation: z.string().min(1),
    lastUpdated: z.string().min(1),
    deletedId: z.coerce.string().optional(),
  })
  .loose();

const LEGACY_OPS: Record<string, string> = {
  create: 'created', update: 'updated', delete: 'deleted', merge: 'merged', void: 'voided', emailed: 'emailed',
};

export function parseLegacyNotifications(body: unknown): ParseResult {
  const events: ParsedEvent[] = [];
  const rejected: ParseResult['rejected'] = [];
  const notifications = (body as { eventNotifications?: unknown })?.eventNotifications;
  if (!Array.isArray(notifications)) return { events, rejected: [{ index: 0, reason: 'eventNotifications: expected array' }] };
  let index = 0;
  for (const n of notifications) {
    const realmId = (n as { realmId?: unknown })?.realmId;
    const entities = (n as { dataChangeEvent?: { entities?: unknown } })?.dataChangeEvent?.entities;
    if (typeof realmId !== 'string' && typeof realmId !== 'number') {
      rejected.push({ index: index++, reason: 'realmId missing' });
      continue;
    }
    for (const raw of Array.isArray(entities) ? entities : []) {
      const r = LegacyEntity.safeParse(raw);
      const time = r.success ? new Date(r.data.lastUpdated) : null;
      if (!r.success || !time || Number.isNaN(time.getTime())) {
        rejected.push({ index: index++, reason: r.success ? 'lastUpdated: not a timestamp' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        continue;
      }
      const entity = r.data.name.toLowerCase();
      const op = LEGACY_OPS[r.data.operation.toLowerCase()] ?? r.data.operation.toLowerCase();
      events.push({
        format: 'legacy',
        eventId: `legacy:${realmId}:${entity}:${r.data.id}:${op}:${time.toISOString()}`,
        eventType: `qbo.${entity}.${op}.legacy`,
        entityName: entity,
        operation: op,
        entityId: r.data.id,
        realmId: String(realmId),
        eventTime: time,
        data: r.data.deletedId ? { deletedId: r.data.deletedId } : null,
      });
      index++;
    }
  }
  return { events, rejected };
}

/** Accepts either format; Intuit decides which one per app setting. */
export function parseWebhookBody(body: unknown): ParseResult {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'eventNotifications' in body) {
    return parseLegacyNotifications(body);
  }
  return parseCloudEvents(body);
}
