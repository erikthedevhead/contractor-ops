import { describe, expect, it } from 'vitest';
import { AppError } from '@co/shared';
import { QboClient, type ApiCallRecord } from '../src/http';
import type { TokenStore } from '../src/tokens';

/** Minimal TokenStore double: version bumps on each forced refresh. */
function fakeTokens() {
  let version = 1;
  const calls: Array<{ staleVersion?: number }> = [];
  const store = {
    async getAccessToken(_tenantId: string, opts: { staleVersion?: number } = {}) {
      calls.push(opts);
      if (opts.staleVersion === version) version++;
      return { accessToken: `tok-v${version}`, realmId: '9341', environment: 'sandbox' as const, tokenVersion: version };
    },
  };
  return { store: store as unknown as TokenStore, calls };
}

function scripted(responses: Array<Response | Error>) {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const next = responses.shift();
    if (!next) throw new Error('no more scripted responses');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: Array<Response | Error>) {
  const tokens = fakeTokens();
  const meter: ApiCallRecord[] = [];
  const sleeps: number[] = [];
  const s = scripted(responses);
  const c = new QboClient('tenant-1', {
    tokens: tokens.store,
    meter: (r) => void meter.push(r),
    fetchFn: s.fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  return { c, meter, sleeps, seen: s.seen, tokenCalls: tokens.calls };
}

describe('QboClient', () => {
  it('retries 429 then succeeds, metering every attempt', async () => {
    const { c, meter, sleeps } = client([json(429, {}), json(503, {}), json(200, { ok: true })]);
    await expect(c.get('/companyinfo/9341')).resolves.toEqual({ ok: true });
    expect(meter.map((m) => m.statusCode)).toEqual([429, 503, 200]);
    expect(meter.map((m) => m.countsTowardCoreplus)).toEqual([false, false, true]);
    expect(sleeps).toHaveLength(2);
  });

  it('reuses the same requestid on every retry of a write', async () => {
    const { c, seen } = client([new Error('ECONNRESET'), json(500, {}), json(200, { Estimate: { Id: '1' } })]);
    await c.post('/estimate', { Line: [] }, { requestId: 'req-abc' });
    const ids = seen.map((s) => new URL(s.url).searchParams.get('requestid'));
    expect(ids).toEqual(['req-abc', 'req-abc', 'req-abc']);
  });

  it('refuses a POST without a requestid', async () => {
    const { c, seen } = client([]);
    await expect(c.request('POST', '/estimate', { body: {} })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(seen).toHaveLength(0);
  });

  it('on 401 refreshes once with the stale version, then retries with the new token', async () => {
    const { c, seen, tokenCalls } = client([json(401, {}), json(200, { ok: 1 })]);
    await c.get('/query', { query: { query: 'select * from Customer' } });
    expect(tokenCalls).toEqual([{}, { staleVersion: 1 }]);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer tok-v1', 'Bearer tok-v2']);
  });

  it('does not loop on repeated 401s', async () => {
    const { c } = client([json(401, {}), json(401, {})]);
    await expect(c.get('/query')).rejects.toMatchObject({ code: 'QBO_AUTH_EXPIRED' });
  });

  it('does not retry validation errors and surfaces the QuickBooks message', async () => {
    const fault = { Fault: { type: 'ValidationFault', Error: [{ code: '2020', Message: 'Required param missing' }] } };
    const { c, meter } = client([json(400, fault)]);
    const err = await c.get('/estimate/1').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'QBO_VALIDATION', message: 'Required param missing' });
    expect(meter).toHaveLength(1);
  });

  it('maps stale SyncToken (5010) to QBO_STALE_OBJECT', async () => {
    const fault = { Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } };
    const { c } = client([json(400, fault)]);
    await expect(c.post('/estimate', {}, { requestId: 'r' })).rejects.toMatchObject({ code: 'QBO_STALE_OBJECT' });
  });

  it('gives up after maxAttempts with a retryable error', async () => {
    const { c, meter } = client(Array.from({ length: 5 }, () => json(429, {})));
    await expect(c.get('/query')).rejects.toMatchObject({ code: 'QBO_RATE_LIMITED', retryable: true });
    expect(meter).toHaveLength(5);
  });

  it('honors Retry-After', async () => {
    const { c, sleeps } = client([json(429, {}, { 'retry-after': '3' }), json(200, {})]);
    await c.get('/query');
    expect(sleeps).toEqual([3000]);
  });

  it('pins minorversion=75 and templates the realm out of metered endpoints', async () => {
    const { c, seen, meter } = client([json(200, {})]);
    await c.get('/companyinfo/9341');
    expect(new URL(seen[0]!.url).searchParams.get('minorversion')).toBe('75');
    expect(seen[0]!.url).toContain('sandbox-quickbooks.api.intuit.com/v3/company/9341/');
    expect(meter[0]!.endpoint).toBe('/v3/company/{realm}/companyinfo/9341');
  });
});
