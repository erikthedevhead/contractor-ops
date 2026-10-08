/**
 * End-to-end Day 1 path against a fake QuickBooks:
 *   seed (idempotent, crash-safe) -> initial sync -> mirror matches the plan.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withTenant } from '@co/db';
import { initialSync, QboClient, TokenStore, type ApiCallRecord } from '@co/qbo';
import { dropTenant, makeTenant, testDb } from '../../packages/db/test/helpers';
import { FakeQbo } from '../../packages/qbo/test/fake-qbo';
import { buildPlan, daysBetween } from '../seed/catalog';
import { runSeed } from '../seed/run';

const ANCHOR = '2026-10-08';
const db = testDb();
const fake = new FakeQbo();
const meter: ApiCallRecord[] = [];
const app = { environment: 'sandbox' as const, clientId: 'cid-000000', clientSecret: 'sec-000000', redirectUri: 'http://x/cb' };
const tokens = new TokenStore({ db, ring: { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 }, app });
let tenant: string;
let client: QboClient;

const plan = buildPlan(ANCHOR);
const expectedCounts = {
  Item: plan.items.length,
  Customer: plan.customers.length,
  Estimate: plan.jobs.length,
  Invoice: plan.jobs.filter((j) => j.invoice).length,
  Payment: plan.jobs.reduce((n, j) => n + j.payments.length, 0),
};
const quiet = () => {};

beforeAll(async () => {
  tenant = await makeTenant(db, 'seed');
  await tokens.saveConnection(tenant, `9341seed${Date.now()}`, {
    accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: null, responseKeys: [],
  });
  client = new QboClient(tenant, { tokens, meter: (r) => void meter.push(r), fetchFn: fake.fetch, sleep: async () => {} });
});
afterAll(async () => {
  await dropTenant(db, tenant);
  await db.destroy();
});

describe('seed -> sync', () => {
  it('creates the full plan in QuickBooks', async () => {
    const r = await runSeed({ db, client, tenantId: tenant, anchor: ANCHOR, writeSpacingMs: 0, manifestPath: null, log: quiet });
    const total = Object.values(expectedCounts).reduce((a, b) => a + b, 0);
    expect(r.created).toBe(total);
    for (const [entity, n] of Object.entries(expectedCounts)) expect(fake.all(entity)).toHaveLength(n);
    // Every write carried a requestid.
    expect(fake.requests.filter((q) => q.method === 'POST' && !q.requestId)).toHaveLength(0);
  });

  it('is a no-op when re-run', async () => {
    const before = fake.requests.filter((q) => q.method === 'POST').length;
    const r = await runSeed({ db, client, tenantId: tenant, writeSpacingMs: 0, manifestPath: null, log: quiet });
    expect(r.created).toBe(0);
    expect(r.anchor).toBe(ANCHOR); // stored anchor reused
    expect(fake.requests.filter((q) => q.method === 'POST').length).toBe(before);
  });

  it('survives a crash between QuickBooks create and ledger write without duplicating', async () => {
    // Simulate: QuickBooks created invoice J10 but our ledger write never happened.
    await withTenant(db, tenant, (tx) => tx.deleteFrom('seed_ledger').where('seed_key', '=', 'invoice:J10').execute());
    const r = await runSeed({ db, client, tenantId: tenant, writeSpacingMs: 0, manifestPath: null, log: quiet });
    expect(r.created).toBe(1); // re-sent with the same requestid...
    expect(fake.all('Invoice')).toHaveLength(expectedCounts.Invoice); // ...and QuickBooks deduped it
  });

  it('adopts an existing customer on a duplicate-name error instead of failing', async () => {
    await withTenant(db, tenant, (tx) => tx.deleteFrom('seed_ledger').where('seed_key', '=', 'customer:c_oconnor').execute());
    const r = await runSeed({ db, client, tenantId: tenant, writeSpacingMs: 0, manifestPath: null, log: quiet });
    expect(r.created).toBe(1);
    expect(fake.all('Customer')).toHaveLength(expectedCounts.Customer);
  });

  it('refuses to re-seed with a different anchor', async () => {
    await expect(runSeed({ db, client, tenantId: tenant, anchor: '2027-01-01', manifestPath: null, log: quiet })).rejects.toThrow(/anchor/);
  });

  it('initial sync mirrors everything and matches the plan', async () => {
    const stats = await initialSync(db, client, { log: { info() {}, warn() {}, error() {}, debug() {} } as never });
    expect(Object.fromEntries(stats.map((s) => [s.entity, s.fetched]))).toEqual(expectedCounts);

    const ar = await withTenant(db, tenant, (tx) =>
      tx.selectFrom('qbo_invoices').select(sql<string>`sum(balance)`.as('open')).where('balance', '>', '0').executeTakeFirstOrThrow(),
    );
    const expectedAr = plan.jobs
      .filter((j) => j.invoice)
      .reduce((s, j) => s + j.subtotal - j.payments.reduce((p, x) => p + x.amount, 0), 0);
    expect(Number(ar.open)).toBeCloseTo(expectedAr, 2);

    // Preview of get_ar_aging ground truth: "> 60 days past due" as of the anchor.
    const over60 = await withTenant(db, tenant, (tx) =>
      tx
        .selectFrom('qbo_invoices')
        .select('qbo_id')
        .where('balance', '>', '0')
        .where(sql<boolean>`${sql.lit(ANCHOR)}::date - due_date > 60`)
        .execute(),
    );
    const expectedOver60 = plan.jobs.filter(
      (j) => j.invoice && j.subtotal - j.payments.reduce((p, x) => p + x.amount, 0) > 0 && daysBetween(j.invoice.dueDate, ANCHOR) > 60,
    );
    expect(over60).toHaveLength(expectedOver60.length);

    // Line items and estimate links made it across.
    const lines = await withTenant(db, tenant, (tx) =>
      tx.selectFrom('qbo_txn_lines').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    );
    const planLines = plan.jobs.reduce((n, j) => n + j.lines.length * (j.invoice ? 2 : 1), 0);
    expect(lines.n).toBe(planLines);
    const linked = await withTenant(db, tenant, (tx) =>
      tx.selectFrom('qbo_invoices').select(sql<number>`count(*)::int`.as('n')).where('linked_estimate_id', 'is not', null).executeTakeFirstOrThrow(),
    );
    expect(linked.n).toBe(expectedCounts.Invoice);
  });

  it('re-running initial sync changes nothing (guarded upserts)', async () => {
    const stats = await initialSync(db, client, { log: { info() {}, warn() {}, error() {}, debug() {} } as never });
    expect(stats.every((s) => s.changed === 0)).toBe(true);
  });

  it('metered reads as CorePlus and writes as not', () => {
    const reads = meter.filter((m) => m.method === 'GET' && m.statusCode === 200);
    const writes = meter.filter((m) => m.method === 'POST');
    expect(reads.every((m) => m.countsTowardCoreplus)).toBe(true);
    expect(writes.every((m) => !m.countsTowardCoreplus)).toBe(true);
  });
});
