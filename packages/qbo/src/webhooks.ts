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
