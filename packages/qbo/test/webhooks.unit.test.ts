import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mirrorEntityFor, parseCloudEvents, parseWebhookBody, verifyIntuitSignature } from '../src/webhooks';

const verifier = 'verifier-token-123';
const sign = (body: string, key = verifier) => createHmac('sha256', key).update(body).digest('base64');

const ev = (over: Record<string, unknown> = {}) => ({
  specversion: '1.0', id: 'evt-1', source: 'intuit.abc', type: 'qbo.invoice.updated.v1',
  datacontenttype: 'application/json', time: '2026-10-08T15:00:00.000Z', intuitentityid: '145', intuitaccountid: '9341', ...over,
});

describe('verifyIntuitSignature', () => {
  const body = JSON.stringify([ev()]);
  it('accepts the correct HMAC over the raw bytes', () => {
    expect(verifyIntuitSignature(Buffer.from(body), sign(body), verifier)).toBe(true);
  });
  it('rejects a wrong key, a modified body, a missing or garbage header', () => {
    expect(verifyIntuitSignature(Buffer.from(body), sign(body, 'other'), verifier)).toBe(false);
    expect(verifyIntuitSignature(Buffer.from(body + ' '), sign(body), verifier)).toBe(false);
    expect(verifyIntuitSignature(Buffer.from(body), undefined, verifier)).toBe(false);
    expect(verifyIntuitSignature(Buffer.from(body), 'not-base64!!', verifier)).toBe(false);
  });
  it('is sensitive to re-serialization (why we verify raw bytes)', () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyIntuitSignature(Buffer.from(pretty), sign(body), verifier)).toBe(false);
  });
});

describe('parseCloudEvents', () => {
  it('parses a batch and splits the type into entity + operation', () => {
    const r = parseCloudEvents([ev(), ev({ id: 'evt-2', type: 'qbo.customer.merged.v1', intuitentityid: 7 })]);
    expect(r.rejected).toEqual([]);
    expect(r.events.map((e) => [e.entityName, e.operation, e.entityId])).toEqual([['invoice', 'updated', '145'], ['customer', 'merged', '7']]);
  });
  it('accepts a single envelope', () => {
    expect(parseCloudEvents(ev()).events).toHaveLength(1);
  });
  it('keeps good events when some are malformed', () => {
    const r = parseCloudEvents([ev(), { id: 'x' }, ev({ id: 'evt-3', time: 'yesterday' }), ev({ id: 'evt-4', type: 'not.a.type' })]);
    expect(r.events.map((e) => e.eventId)).toEqual(['evt-1']);
    expect(r.rejected.map((x) => x.index)).toEqual([1, 2, 3]);
  });
  it('returns nothing for non-objects', () => {
    expect(parseCloudEvents('hello')).toEqual({ events: [], rejected: [] });
  });
});

describe('mirrorEntityFor', () => {
  it('maps mirrored entities and ignores the rest', () => {
    expect(mirrorEntityFor('invoice')).toBe('Invoice');
    expect(mirrorEntityFor('Payment')).toBe('Payment');
    expect(mirrorEntityFor('bill')).toBeNull();
  });
});

describe('legacy format (CloudEvents payload disabled in the portal)', () => {
  // Exact shape received from the sandbox on 2026-10-08.
  const real = { eventNotifications: [{ realmId: '9341458445295718', dataChangeEvent: { entities: [
    { id: '247', operation: 'Create', name: 'Payment', lastUpdated: '2026-10-08T21:32:48.000Z' },
  ] } }] };

  it('parses the real sandbox payload', () => {
    const r = parseWebhookBody(real);
    expect(r.rejected).toEqual([]);
    expect(r.events).toEqual([{
      format: 'legacy',
      eventId: 'legacy:9341458445295718:payment:247:created:2026-10-08T21:32:48.000Z',
      eventType: 'qbo.payment.created.legacy',
      entityName: 'payment', operation: 'created', entityId: '247', realmId: '9341458445295718',
      eventTime: new Date('2026-10-08T21:32:48.000Z'), data: null,
    }]);
  });

  it('derives the same id for a redelivery, a different one for a later change', () => {
    const again = parseWebhookBody(structuredClone(real)).events[0]!.eventId;
    expect(again).toBe(parseWebhookBody(real).events[0]!.eventId);
    const later = structuredClone(real);
    later.eventNotifications[0]!.dataChangeEvent.entities[0]!.lastUpdated = '2026-10-08T21:40:00.000Z';
    expect(parseWebhookBody(later).events[0]!.eventId).not.toBe(again);
  });

  it('maps legacy operations and carries merge deletedId', () => {
    const r = parseWebhookBody({ eventNotifications: [{ realmId: '1', dataChangeEvent: { entities: [
      { id: '1', operation: 'Update', name: 'Invoice', lastUpdated: '2026-10-08T00:00:00Z' },
      { id: '2', operation: 'Delete', name: 'Estimate', lastUpdated: '2026-10-08T00:00:00Z' },
      { id: '3', operation: 'Merge', name: 'Customer', lastUpdated: '2026-10-08T00:00:00Z', deletedId: '9' },
      { id: '4', operation: 'Void', name: 'Invoice', lastUpdated: '2026-10-08T00:00:00Z' },
    ] } }] });
    expect(r.events.map((e) => e.operation)).toEqual(['updated', 'deleted', 'merged', 'voided']);
    expect(r.events[2]!.data).toEqual({ deletedId: '9' });
  });

  it('handles several realms in one notification and rejects bad entries individually', () => {
    const r = parseWebhookBody({ eventNotifications: [
      { realmId: 'A', dataChangeEvent: { entities: [{ id: '1', operation: 'Create', name: 'Item', lastUpdated: '2026-10-08T00:00:00Z' }] } },
      { realmId: 'B', dataChangeEvent: { entities: [{ id: '2', operation: 'Create', name: 'Item' }] } },
      { dataChangeEvent: { entities: [] } },
    ] });
    expect(r.events.map((e) => e.realmId)).toEqual(['A']);
    expect(r.rejected).toHaveLength(2);
  });

  it('still routes CloudEvents batches to the CloudEvents parser', () => {
    expect(parseWebhookBody([ev()]).events[0]!.format).toBe('cloudevents');
  });
});
