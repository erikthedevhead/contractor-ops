/**
 * Day 3 end to end: a real MCP client (SDK v2, protocol 2026-07-28) over HTTP
 * against the real Express wiring, on top of the seeded fake QuickBooks.
 * Expected values come from the seed plan, not from the code under test.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sql } from 'kysely';
import { asSystem, withTenant } from '@co/db';
import { initialSync, QboClient, TokenStore } from '@co/qbo';
import { createApp } from '../../api/src/app';
import { dropTenant, makeTenant, ownerDb, testDb } from '../../../packages/db/test/helpers';
import { FakeQbo } from '../../../packages/qbo/test/fake-qbo';
import { buildPlan, daysBetween } from '../../../scripts/seed/catalog';
import { runSeed } from '../../../scripts/seed/run';
import { createApiKey, revokeApiKey } from '../src/keys';
import { mcpRouter } from '../src/server';

const ANCHOR = '2026-10-08';
const plan = buildPlan(ANCHOR);
const db = testDb();
const owner = ownerDb();
const fake = new FakeQbo();
const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;
const app = { environment: 'sandbox' as const, clientId: 'cid-000000', clientSecret: 'sec-000000', redirectUri: 'http://x/cb' };
const tokens = new TokenStore({ db, ring: { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 }, app, log: silent });
const clientFor = (t: string) => new QboClient(t, { tokens, meter: () => {}, fetchFn: fake.fetch, sleep: async () => {}, log: silent });

let tenantA: string;
let tenantB: string;
let keys: { aRead: string; aWrite: string; bWrite: string; revoked: string };
let server: Server;
let url: URL;
const clients: Client[] = [];

async function connect(key?: string): Promise<Client> {
  const c = new Client({ name: 'test-agent', version: '0.0.1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(new StreamableHTTPClientTransport(url, key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : {}));
  clients.push(c);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), body: r.structuredContent as any };
}

const posts = () => fake.requests.filter((r) => r.method === 'POST').length;
const balanceOf = (j: (typeof plan.jobs)[number]) => j.subtotal - j.payments.reduce((s, p) => s + p.amount, 0);

beforeAll(async () => {
  tenantA = await makeTenant(db, 'mcp-a');
  tenantB = await makeTenant(db, 'mcp-b');
  for (const [t, realm] of [[tenantA, `9341mcpA${Date.now()}`], [tenantB, `9341mcpB${Date.now()}`]] as const) {
    await tokens.saveConnection(t, realm, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: null, responseKeys: [] });
  }
  await runSeed({ db, client: clientFor(tenantA), tenantId: tenantA, anchor: ANCHOR, writeSpacingMs: 0, manifestPath: null, log: () => {} });
  await initialSync(db, clientFor(tenantA), { log: silent });

  keys = {
    aRead: (await createApiKey(owner, tenantA, ['read'], 'read-only')).key,
    aWrite: (await createApiKey(owner, tenantA, ['read', 'write:estimate'], 'office manager')).key,
    bWrite: (await createApiKey(owner, tenantB, ['read', 'write:estimate'])).key,
    revoked: '',
  };
  const r = await createApiKey(owner, tenantA, ['read']);
  await revokeApiKey(owner, r.prefix);
  keys.revoked = r.key;

  const express = createApp({ db, tokens, qbo: app, connectLinkSecret: 'ab'.repeat(32), mcp: mcpRouter({ db, clientFor, log: silent }), log: silent });
  server = express.listen(0);
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
}, 60_000);

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  server.close();
  await dropTenant(db, tenantA);
  await dropTenant(db, tenantB);
  await db.destroy();
  await owner.destroy();
});

describe('authentication', () => {
  it('rejects missing, malformed, unknown and revoked keys with 401', async () => {
    for (const k of [undefined, 'nope', `cok_00000000_${'a'.repeat(43)}`, keys.revoked]) {
      await expect(connect(k)).rejects.toThrow(/401|authoriz/i);
    }
  });

  it('the app role cannot read api_keys directly (only through the resolver)', async () => {
    await expect(db.selectFrom('api_keys').selectAll().execute()).rejects.toThrow(/permission denied/);
  });

  it('lists exactly the six tools, with read-only annotations on reads', async () => {
    const c = await connect(keys.aRead);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_estimate_draft', 'find_customer', 'get_ar_aging', 'get_customer_job_history', 'get_revenue_by_item', 'list_open_estimates',
    ]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(t.name !== 'create_estimate_draft');
    // No tool lets the caller choose a tenant.
    for (const t of tools) expect(JSON.stringify(t.inputSchema)).not.toMatch(/tenant/i);
  });
});

describe('read tools match the seed plan', () => {
  it('find_customer: partial name is ambiguous between the two Johnsons', async () => {
    const c = await connect(keys.aRead);
    const r = await call(c, 'find_customer', { query: 'Johnson' });
    expect(r.isError).toBe(false);
    expect(r.body.matches.map((m: any) => m.display_name).sort()).toEqual(['Johnson Property Management', 'Mark Johnson']);
    expect(r.body.ambiguous).toBe(true);
  });

  it('find_customer: tolerates a misspelling', async () => {
    const r = await call(await connect(keys.aRead), 'find_customer', { query: 'Lindquist' });
    expect(r.body.matches[0].display_name).toBe('Hannah Lindqvist');
  });

  it('find_customer: no match says so instead of guessing', async () => {
    const r = await call(await connect(keys.aRead), 'find_customer', { query: 'Zebulon Fairweather' });
    expect(r.body.matches).toEqual([]);
    expect(r.body.note).toMatch(/Do not guess/);
  });

  it('get_ar_aging: "more than 60 days" includes the 61-day invoice and excludes the 60-day one', async () => {
    const r = await call(await connect(keys.aRead), 'get_ar_aging', { as_of: ANCHOR, overdue_more_than_days: 60 });
    const expected = plan.jobs.filter((j) => j.invoice && balanceOf(j) > 0 && daysBetween(j.invoice.dueDate, ANCHOR) > 60);
    expect(r.body.invoice_count).toBe(expected.length);
    expect(r.body.total_open_balance).toBe(expected.reduce((s, j) => s + balanceOf(j), 0).toFixed(2));
    expect(r.body.total_open_balance).toBe('25898.50');
    const days = r.body.customers.flatMap((c: any) => c.invoices.map((i: any) => i.days_past_due));
    expect(days).toContain(61);
    expect(days).not.toContain(60);
  });

  it('get_ar_aging: full aging totals and buckets add up', async () => {
    const r = await call(await connect(keys.aRead), 'get_ar_aging', { as_of: ANCHOR });
    expect(r.body.total_open_balance).toBe('78327.00');
    const bucketSum = Object.values(r.body.buckets as Record<string, string>).reduce((s, v) => s + Number(v), 0);
    expect(bucketSum.toFixed(2)).toBe('78327.00');
    expect(Number(r.body.buckets.current)).toBeGreaterThan(0); // three invoices not yet due
  });

  it('list_open_estimates: pending only, expired one flagged', async () => {
    const r = await call(await connect(keys.aRead), 'list_open_estimates', { as_of: ANCHOR });
    const pending = plan.jobs.filter((j) => j.estimate.status === 'Pending');
    expect(r.body.count).toBe(pending.length);
    expect(r.body.estimates.filter((e: any) => e.expired)).toHaveLength(1);
    const active = await call(await connect(keys.aRead), 'list_open_estimates', { as_of: ANCHOR, include_expired: false });
    expect(active.body.count).toBe(pending.length - 1);
  });

  it('get_revenue_by_item: totals equal invoiced subtotals for the period', async () => {
    const r = await call(await connect(keys.aRead), 'get_revenue_by_item', { start_date: '2025-01-01', end_date: ANCHOR });
    const expected = plan.jobs.filter((j) => j.invoice).reduce((s, j) => s + j.subtotal, 0);
    expect(r.body.total_revenue).toBe(expected.toFixed(2));
    expect(r.body.items.some((i: any) => i.item_name === 'Tile Install - Premium (sq ft)')).toBe(true);
  });

  it('get_revenue_by_item: rejects an inverted range with a clear error', async () => {
    const r = await call(await connect(keys.aRead), 'get_revenue_by_item', { start_date: '2026-10-01', end_date: '2026-09-01' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('INVALID_ARGUMENT');
  });

  it('get_customer_job_history: similar-job search ranks bathroom remodels and returns priced lines', async () => {
    const r = await call(await connect(keys.aRead), 'get_customer_job_history', { query: 'bathroom remodel walk-in shower', limit: 5 });
    expect(r.body.count).toBe(5);
    expect(r.body.jobs[0].title).toMatch(/bathroom remodel - walk-in shower/i);
    expect(r.body.jobs[0].lines.length).toBeGreaterThan(5);
    expect(r.body.jobs[0].lines[0]).toHaveProperty('item_id');
  });

  it('get_customer_job_history: says when the list is partial (no silent truncation)', async () => {
    const c = await connect(keys.aRead);
    const bathrooms = plan.jobs.filter((j) => j.type === 'bathroom').length;
    const r = await call(c, 'get_customer_job_history', { query: 'bath', limit: 5, include_lines: false });
    expect(r.body).toMatchObject({ count: 5, truncated: true });
    expect(r.body.total_matches).toBeGreaterThanOrEqual(bathrooms);
    expect(r.body.note).toMatch(/Showing 5 of/);
    const all = await call(c, 'get_customer_job_history', { query: 'bath', limit: 25, include_lines: false });
    expect(all.body.truncated).toBe(false);
  });

  it('get_customer_job_history: requires a filter', async () => {
    const r = await call(await connect(keys.aRead), 'get_customer_job_history', {});
    expect(r.body.error.code).toBe('INVALID_ARGUMENT');
  });

  it('an unknown customer_id is NOT_FOUND, never a plausible-looking zero', async () => {
    const c = await connect(keys.aRead);
    for (const [tool, args] of [
      ['get_ar_aging', { customer_id: '<customer_id from above>' }],
      ['list_open_estimates', { customer_id: '999999' }],
      ['get_customer_job_history', { customer_id: '999999' }],
    ] as const) {
      const r = await call(c, tool, args);
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe('NOT_FOUND');
      expect(r.body.error.hint).toMatch(/find_customer/);
    }
  });

  it('schema validation errors come back as tool errors, not exceptions', async () => {
    const r = await call(await connect(keys.aRead), 'get_ar_aging', { as_of: 'last tuesday' });
    expect(r.isError).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('tenant B sees none of tenant A\'s data through any read tool', async () => {
    const b = await connect(keys.bWrite);
    expect((await call(b, 'find_customer', { query: 'Johnson' })).body.matches).toEqual([]);
    expect((await call(b, 'get_ar_aging', { as_of: ANCHOR })).body.invoice_count).toBe(0);
    expect((await call(b, 'get_customer_job_history', { query: 'bathroom' })).body.count).toBe(0);
  });

  it('tenant B cannot draft against tenant A\'s customer ids', async () => {
    const aCustomer = plan.customers[0]!;
    const id = (await call(await connect(keys.aRead), 'find_customer', { query: aCustomer.displayName })).body.matches[0].customer_id;
    const r = await call(await connect(keys.bWrite), 'create_estimate_draft', { customer_id: id, lines: [{ item_id: '1', quantity: 1, unit_price: 1 }] });
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('create_estimate_draft: two-step guarded write', () => {
  let customerId: string;
  let itemIds: { tile: string; vanity: string };

  beforeAll(async () => {
    const c = await connect(keys.aRead);
    customerId = (await call(c, 'find_customer', { query: 'Mark Johnson' })).body.matches[0].customer_id;
    const items = await withTenant(db, tenantA, (tx) => tx.selectFrom('qbo_items').select(['qbo_id', 'name']).execute());
    itemIds = {
      tile: items.find((i) => i.name === 'Tile Install - Standard (sq ft)')!.qbo_id,
      vanity: items.find((i) => i.name === 'Vanity Install (each)')!.qbo_id,
    };
  });

  const draft = () => ({
    customer_id: customerId,
    title: 'Full bathroom remodel - Johnson',
    lines: [{ item_id: itemIds.tile, quantity: 110 }, { item_id: itemIds.vanity, quantity: 1, unit_price: 700 }],
  });

  it('a read-only key cannot even preview', async () => {
    const r = await call(await connect(keys.aRead), 'create_estimate_draft', draft());
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('step 1 writes nothing to QuickBooks and returns a priced preview', async () => {
    const before = posts();
    const r = await call(await connect(keys.aWrite), 'create_estimate_draft', draft());
    expect(r.isError).toBe(false);
    expect(posts()).toBe(before);
    expect(r.body.status).toBe('preview');
    expect(r.body.preview.subtotal).toBe((110 * 12 + 700).toFixed(2)); // item default price for tile, explicit for vanity
    expect(r.body.next_step).toMatch(/explicitly approve/);
  });

  it('step 2 writes exactly once; replaying the token returns the same estimate without writing', async () => {
    const c = await connect(keys.aWrite);
    const { body: p } = await call(c, 'create_estimate_draft', draft());
    const before = posts();
    const first = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(first.body.status).toBe('created');
    expect(posts()).toBe(before + 1);

    const again = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(again.body).toMatchObject({ status: 'created', estimate_id: first.body.estimate_id, already_committed: true });
    expect(posts()).toBe(before + 1);

    const mirrored = await withTenant(db, tenantA, (tx) =>
      tx.selectFrom('qbo_estimates').select(['created_by_agent', 'txn_status']).where('qbo_id', '=', first.body.estimate_id).executeTakeFirstOrThrow(),
    );
    expect(mirrored).toEqual({ created_by_agent: true, txn_status: 'Pending' });
  });

  it('step 2 refuses any arguments besides the token', async () => {
    const c = await connect(keys.aWrite);
    const { body: p } = await call(c, 'create_estimate_draft', draft());
    const r = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token, lines: [{ item_id: itemIds.tile, quantity: 999 }] });
    expect(r.body.error.code).toBe('INVALID_ARGUMENT');
  });

  it('a token is bound to its tenant', async () => {
    const { body: p } = await call(await connect(keys.aWrite), 'create_estimate_draft', draft());
    const r = await call(await connect(keys.bWrite), 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(r.body.error.code).toBe('INVALID_CONFIRMATION_TOKEN');
  });

  it('an expired token cannot be used', async () => {
    const c = await connect(keys.aWrite);
    const { body: p } = await call(c, 'create_estimate_draft', draft());
    await asSystem(db, 'test', (tx) => tx.updateTable('pending_writes').set({ expires_at: sql`now() - interval '1 minute'` }).where('id', '=', p.confirmation_token).execute());
    const before = posts();
    const r = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(r.body.error.code).toBe('CONFIRMATION_EXPIRED');
    expect(posts()).toBe(before);
  });

  it('QuickBooks outage on step 2: retryable error, then the same token succeeds with ONE estimate', async () => {
    const c = await connect(keys.aWrite);
    const { body: p } = await call(c, 'create_estimate_draft', draft());
    const estimatesBefore = fake.all('Estimate').length;

    fake.injected.push(503, 503, 503, 503, 503);
    const failed = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(failed.body.error).toMatchObject({ code: 'QUICKBOOKS_UNAVAILABLE', retryable: true });

    const ok = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(ok.body.status).toBe('created');
    expect(fake.all('Estimate').length).toBe(estimatesBefore + 1);
    // Every attempt for this draft used one requestid.
    const ids = new Set(fake.requests.filter((r) => r.method === 'POST' && r.path === '/estimate').slice(-6).map((r) => r.requestId));
    expect(ids.size).toBe(1);
  });

  it('a lost response (QuickBooks created it, we never heard back) does not duplicate on retry', async () => {
    const c = await connect(keys.aWrite);
    const { body: p } = await call(c, 'create_estimate_draft', draft());
    const row = await withTenant(db, tenantA, (tx) => tx.selectFrom('pending_writes').select('qbo_request_id').where('id', '=', p.confirmation_token).executeTakeFirstOrThrow());
    // Simulate: the POST reached QuickBooks, then our process died before recording it.
    await fake.fetch(`https://sandbox-quickbooks.api.intuit.com/v3/company/x/estimate?requestid=${row.qbo_request_id}`, {
      method: 'POST', body: JSON.stringify({ CustomerRef: { value: customerId }, Line: [{ Amount: 1, DetailType: 'SalesItemLineDetail' }] }),
    });
    await asSystem(db, 'test', (tx) => tx.updateTable('pending_writes').set({ status: 'executing', confirmed_at: sql`now() - interval '5 minutes'` }).where('id', '=', p.confirmation_token).execute());
    const estimatesBefore = fake.all('Estimate').length;

    const r = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(r.body.status).toBe('created');
    expect(fake.all('Estimate').length).toBe(estimatesBefore); // QuickBooks returned the original
  });

  it('a tampered stored draft is never sent', async () => {
    const c = await connect(keys.aWrite);
    const { body: p } = await call(c, 'create_estimate_draft', draft());
    await asSystem(db, 'test', (tx) =>
      tx.updateTable('pending_writes').set({ payload: sql`jsonb_set(payload, '{Line,0,Amount}', '99999')` }).where('id', '=', p.confirmation_token).execute(),
    );
    const before = posts();
    const r = await call(c, 'create_estimate_draft', { confirmation_token: p.confirmation_token });
    expect(r.body.error.code).toBe('WRITE_FAILED');
    expect(posts()).toBe(before);
  });

  it('unknown items and customers fail in step 1 with a hint', async () => {
    const c = await connect(keys.aWrite);
    const badItem = await call(c, 'create_estimate_draft', { customer_id: customerId, lines: [{ item_id: '999999', quantity: 1 }] });
    expect(badItem.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(badItem.body.error.hint).toBeTruthy();
    const badCustomer = await call(c, 'create_estimate_draft', { customer_id: '999999', lines: [{ item_id: itemIds.tile, quantity: 1 }] });
    expect(badCustomer.body.error.code).toBe('NOT_FOUND');
  });

  it('a made-up token is rejected', async () => {
    const r = await call(await connect(keys.aWrite), 'create_estimate_draft', { confirmation_token: '00000000-0000-4000-8000-000000000000' });
    expect(r.body.error.code).toBe('INVALID_CONFIRMATION_TOKEN');
  });
});
