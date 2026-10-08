import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mirrorEntityFor, parseCloudEvents, verifyIntuitSignature } from '../src/webhooks';

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
