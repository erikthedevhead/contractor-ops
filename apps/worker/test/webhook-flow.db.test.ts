/**
 * Day 2 end to end against a fake QuickBooks:
 *   signed webhook -> ingest (dedupe) -> job -> worker -> fetch -> guarded upsert
 *   + retries/dead-letter, deletes, nightly CDC reconcile, 30-day fallback.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, withTenant } from '@co/db';
import { createApp } from '../../api/src/app';
import { ingestStoredDelivery } from '../../api/src/webhooks';
import { initialSync, QboClient, reconcile, TokenStore } from '@co/qbo';
import { dropTenant, makeTenant, testDb } from '../../../packages/db/test/helpers';
import { FakeQbo } from '../../../packages/qbo/test/fake-qbo';
import { Q, Worker, scheduleDailyReconcile } from '../src';

const db = testDb();
const fake = new FakeQbo();
const verifier = 'test-verifier-token';
const app = { environment: 'sandbox' as const, clientId: 'cid-000000', clientSecret: 'sec-000000', redirectUri: 'http://x/cb' };
const tokens = new TokenStore({ db, ring: { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 }, app });
const realm = `9341flow${Date.now()}`;
const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;
let tenant: string;
let server: Server;
let base: string;
let worker: Worker;
let client: QboClient;
let invoiceId: string;
let customerId: string;
let seq = 0;

beforeAll(async () => {
  tenant = await makeTenant(db, 'flow');
  await tokens.saveConnection(tenant, realm, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: null, responseKeys: [] });
  const clientFor = (t: string) => new QboClient(t, { tokens, meter: () => {}, fetchFn: fake.fetch, sleep: async () => {}, log: silent });
  client = clientFor(tenant);
  worker = new Worker({ db, clientFor, log: silent });

  const c = fake.insert('Customer', { DisplayName: 'Grace Whitfield', Active: true });
  customerId = c.Id;
  const inv = fake.insert('Invoice', {
    CustomerRef: { value: c.Id }, TxnDate: '2026-09-01', DueDate: '2026-10-01', TotalAmt: 1000, Balance: 1000,
    Line: [{ Id: '1', Amount: 1000, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 1, UnitPrice: 1000 } }],
  });
  invoiceId = inv.Id;
  await initialSync(db, client, { log: silent });

  server = createApp({ db, tokens, qbo: app, connectLinkSecret: 'ab'.repeat(32), webhookVerifier: verifier, log: silent }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await dropTenant(db, tenant);
  await db.destroy();
});

const event = (entity: string, op: string, id: string, extra: Record<string, unknown> = {}) => ({
  specversion: '1.0', id: `evt-${Date.now()}-${++seq}`, source: 'intuit.test', type: `qbo.${entity}.${op}.v1`,
  time: new Date().toISOString(), intuitentityid: id, intuitaccountid: realm, ...extra,
});

async function deliver(events: unknown, opts: { badSignature?: boolean } = {}) {
  const body = JSON.stringify(events);
  const sig = createHmac('sha256', opts.badSignature ? 'wrong' : verifier).update(body).digest('base64');
  return fetch(`${base}/webhooks/qbo`, { method: 'POST', headers: { 'content-type': 'application/cloudevents-batch+json', 'intuit-signature': sig }, body });
}

const mirrorInvoice = () =>
  withTenant(db, tenant, (tx) => tx.selectFrom('qbo_invoices').selectAll().where('qbo_id', '=', invoiceId).executeTakeFirstOrThrow());

describe('webhook -> queue -> worker -> mirror', () => {
  it('rejects a bad signature with 401 but keeps the delivery for forensics', async () => {
    const res = await deliver([event('invoice', 'updated', invoiceId)], { badSignature: true });
    expect(res.status).toBe(401);
    const d = await db.selectFrom('webhook_deliveries').select('signature_valid').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(d.signature_valid).toBe(false);
    expect(await worker.drain()).toBe(0);
  });

  it('applies an invoice update made in QuickBooks', async () => {
    fake.update('Invoice', invoiceId, { Balance: 400 });
    expect((await deliver([event('invoice', 'updated', invoiceId)])).status).toBe(200);
    expect(await worker.drain()).toBe(1);
    const row = await mirrorInvoice();
    expect(row.balance).toBe('400.00');
    expect(row.sync_token).toBe(1);
  });

  it('a redelivered event is a duplicate: no second job', async () => {
    fake.update('Invoice', invoiceId, { Balance: 300 });
    const e = event('invoice', 'updated', invoiceId);
    await deliver([e]);
    await deliver([e]); // Intuit retry of the same notification
    const jobs = await withTenant(db, tenant, (tx) => tx.selectFrom('jobs').select('id').where('singleton_key', '=', e.id).execute());
    expect(jobs).toHaveLength(1);
    expect(await worker.drain()).toBe(1);
    expect((await mirrorInvoice()).balance).toBe('300.00');
  });

  it('out-of-order events converge on the latest state', async () => {
    fake.update('Invoice', invoiceId, { Balance: 200 });
    const older = event('invoice', 'updated', invoiceId);
    fake.update('Invoice', invoiceId, { Balance: 0 });
    const newer = event('invoice', 'updated', invoiceId);
    await deliver([newer, older]);
    expect(await worker.drain()).toBe(2);
    const row = await mirrorInvoice();
    expect(row.balance).toBe('0.00');
    expect(row.sync_token).toBe(4); // v3 and v4 both delivered; v4 wins regardless of order
  });

  it('ignores realms we do not know and entities we do not mirror', async () => {
    await deliver([event('invoice', 'updated', '1', { intuitaccountid: 'unknown-realm' }), event('bill', 'created', '9')]);
    expect(await worker.drain()).toBe(0);
    const rows = await asSystem(db, 'test', (tx) =>
      tx.selectFrom('webhook_events').select(['status', 'tenant_id']).where('entity_id', 'in', ['1', '9']).where('event_type', 'in', ['qbo.invoice.updated.v1', 'qbo.bill.created.v1']).execute(),
    );
    expect(rows.every((r) => r.status === 'ignored')).toBe(true);
  });

  it('handles deletes: explicit delete events and objects that vanished before we fetched them', async () => {
    const c2 = fake.insert('Customer', { DisplayName: 'Temp Customer' });
    await deliver([event('customer', 'created', c2.Id)]);
    await worker.drain();
    fake.remove('Customer', c2.Id);
    await deliver([event('customer', 'updated', c2.Id)]); // fetch will 404 -> treat as deleted
    await worker.drain();
    const row = await withTenant(db, tenant, (tx) => tx.selectFrom('qbo_customers').select('is_deleted').where('qbo_id', '=', c2.Id).executeTakeFirstOrThrow());
    expect(row.is_deleted).toBe(true);
  });

  it('QuickBooks outage: job retries with backoff, then succeeds', async () => {
    fake.update('Invoice', invoiceId, { Balance: 50 });
    fake.injected.push(503, 503, 503, 503, 503); // exhausts the client's in-request retries
    await deliver([event('invoice', 'updated', invoiceId)]);
    expect(await worker.drain()).toBe(1);
    const job = await withTenant(db, tenant, (tx) => tx.selectFrom('jobs').selectAll().where('queue', '=', Q.webhookEvent).orderBy('id', 'desc').executeTakeFirstOrThrow());
    expect(job.status).toBe('failed');
    expect(job.run_at.getTime()).toBeGreaterThan(Date.now());
    expect((await mirrorInvoice()).balance).toBe('0.00'); // not applied yet

    await asSystem(db, 'test', (tx) => tx.updateTable('jobs').set({ run_at: new Date() }).where('id', '=', job.id).execute());
    expect(await worker.drain()).toBe(1);
    expect((await mirrorInvoice()).balance).toBe('50.00');
  });

  it('records the newest processed event time per entity (CDC starting point)', async () => {
    const c = await withTenant(db, tenant, (tx) => tx.selectFrom('sync_cursors').selectAll().where('entity_name', '=', 'Invoice').executeTakeFirstOrThrow());
    expect(c.last_event_time).not.toBeNull();
  });
});

describe('legacy webhook format', () => {
  const legacy = (name: string, op: string, id: string, lastUpdated: string) => ({
    eventNotifications: [{ realmId: realm, dataChangeEvent: { entities: [{ name, id, operation: op, lastUpdated }] } }],
  });

  it('a payment refreshes the invoices it applies to (Intuit only notifies about the Payment)', async () => {
    // Fresh invoice so earlier tests' balance edits don't interfere.
    const inv = fake.insert('Invoice', {
      CustomerRef: { value: customerId }, TxnDate: '2026-09-15', DueDate: '2026-10-15', TotalAmt: 7682, Balance: 7682,
      Line: [{ Id: '1', Amount: 7682, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 1, UnitPrice: 7682 } }],
    });
    await deliver(legacy('Invoice', 'Create', inv.Id, new Date().toISOString()));
    await worker.drain();

    // Receive $500 in QuickBooks: the fake applies it to the invoice's Balance, like QBO does.
    const res = await fake.fetch(`https://sandbox-quickbooks.api.intuit.com/v3/company/${realm}/payment?requestid=pay-1`, {
      method: 'POST', body: JSON.stringify({ CustomerRef: { value: customerId }, TotalAmt: 500, TxnDate: '2026-10-08', Line: [{ Amount: 500, LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }] }] }),
    });
    const payment = ((await res.json()) as { Payment: { Id: string; MetaData: { LastUpdatedTime: string } } }).Payment;

    const r = await deliver(legacy('Payment', 'Create', payment.Id, payment.MetaData.LastUpdatedTime));
    expect(r.status).toBe(200);
    expect(await worker.drain()).toBe(1);
    const row = await withTenant(db, tenant, (tx) => tx.selectFrom('qbo_invoices').select('balance').where('qbo_id', '=', inv.Id).executeTakeFirstOrThrow());
    expect(row.balance).toBe('7182.00');
  });

  it('dedupes a legacy redelivery by its derived id', async () => {
    const body = legacy('Customer', 'Update', customerId, '2026-10-08T22:00:00.000Z');
    await deliver(body);
    await deliver(body);
    const events = await withTenant(db, tenant, (tx) =>
      tx.selectFrom('webhook_events').select('id').where('event_id', '=', `legacy:${realm}:customer:${customerId}:updated:2026-10-08T22:00:00.000Z`).execute(),
    );
    expect(events).toHaveLength(1);
    await worker.drain();
  });

  it('replays a stored delivery that an older parser rejected', async () => {
    // Store a verified delivery directly, as if the parser had failed on it.
    const c = fake.insert('Customer', { DisplayName: 'Replay Test Co' });
    const raw = JSON.stringify(legacy('Customer', 'Create', c.Id, new Date().toISOString()));
    const d = await db.insertInto('webhook_deliveries').values({ signature: 'x', signature_valid: true, raw_body: raw }).returning('id').executeTakeFirstOrThrow();

    const first = await ingestStoredDelivery(db, d.id, 'sandbox', silent);
    const second = await ingestStoredDelivery(db, d.id, 'sandbox', silent);
    expect([first.accepted, second.duplicates]).toEqual([1, 1]);
    await worker.drain();
    const row = await withTenant(db, tenant, (tx) => tx.selectFrom('qbo_customers').select('display_name').where('qbo_id', '=', c.Id).executeTakeFirstOrThrow());
    expect(row.display_name).toBe('Replay Test Co');
  });

  it('never replays a delivery whose signature failed', async () => {
    const d = await db.insertInto('webhook_deliveries').values({ signature: 'bad', signature_valid: false, raw_body: '{}' }).returning('id').executeTakeFirstOrThrow();
    expect((await ingestStoredDelivery(db, d.id, 'sandbox', silent)).accepted).toBe(0);
  });
});

describe('nightly CDC reconcile', () => {
  it('catches changes and deletes that never arrived as webhooks', async () => {
    fake.update('Invoice', invoiceId, { Balance: 10 });        // missed update
    const lost = fake.insert('Customer', { DisplayName: 'Missed Webhook LLC' }); // missed create
    fake.remove('Customer', customerId);                        // missed delete

    const r = await reconcile(db, client, { log: silent });
    expect(r.mode).toBe('cdc');
    expect((await mirrorInvoice()).balance).toBe('10.00');
    const rows = await withTenant(db, tenant, (tx) =>
      tx.selectFrom('qbo_customers').select(['qbo_id', 'is_deleted']).where('qbo_id', 'in', [lost.Id, customerId]).execute(),
    );
    expect(Object.fromEntries(rows.map((x) => [x.qbo_id, x.is_deleted]))).toEqual({ [lost.Id]: false, [customerId]: true });
  });

  it('falls back to a paged query when an entity hits the CDC cap', async () => {
    fake.cdcCap = 3;
    for (let i = 0; i < 5; i++) fake.insert('Item', { Name: `Bulk ${i}`, Type: 'Service', UnitPrice: i });
    const r = await reconcile(db, client, { log: silent, maxObjects: 3 });
    fake.cdcCap = 1000;
    expect(r.mode === 'cdc' && r.fellBackToQuery).toContain('Item');
    const n = await withTenant(db, tenant, (tx) => tx.selectFrom('qbo_items').select('qbo_id').where('name', 'like', 'Bulk %').execute());
    expect(n).toHaveLength(5);
  });

  it('beyond the 30-day window it schedules a full sync instead', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    await withTenant(db, tenant, (tx) => tx.updateTable('sync_cursors').set({ cdc_through: old, last_full_sync_at: old }).execute());
    await asSystem(db, 'test', (tx) => tx.insertInto('jobs').values({ queue: Q.reconcile, tenant_id: tenant, payload: '{}' }).execute());
    await worker.drain();
    const full = await withTenant(db, tenant, (tx) => tx.selectFrom('jobs').select('status').where('queue', '=', Q.initialSync).execute());
    expect(full).toEqual([{ status: 'completed' }]); // enqueued by the reconcile handler, then run by the same drain
  });

  it('schedules one reconcile per tenant per day, no matter how often the scheduler ticks', async () => {
    const day = new Date('2031-01-01T09:00:00Z');
    await scheduleDailyReconcile(db, day);
    await scheduleDailyReconcile(db, day);
    const jobs = await withTenant(db, tenant, (tx) => tx.selectFrom('jobs').select('id').where('singleton_key', '=', `${tenant}:2031-01-01`).execute());
    expect(jobs).toHaveLength(1);
  });
});
