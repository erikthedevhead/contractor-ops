import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@co/db';
import type { KeyRing } from '@co/crypto';
import { dropTenant, makeTenant, testDb } from '../../db/test/helpers';
import { TokenStore } from '../src/tokens';
import type { QboAppConfig } from '../src/config';

const db = testDb();
const ring: KeyRing = { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 };
const app: QboAppConfig = { environment: 'sandbox', clientId: 'cid-000000', clientSecret: 'secret-000000', redirectUri: 'http://localhost/cb' };
const tenants: string[] = [];

afterAll(async () => {
  for (const t of tenants) await dropTenant(db, t);
  await db.destroy();
});

/** Fake Intuit token endpoint: rotates the refresh token on every call. */
function fakeIntuit(opts: { delayMs?: number; fail?: 'invalid_grant' | 503 } = {}) {
  let n = 0;
  const seenRefreshTokens: string[] = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    seenRefreshTokens.push(form.get('refresh_token') ?? '');
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail === 'invalid_grant') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    if (opts.fail === 503) return new Response('down', { status: 503 });
    n++;
    return new Response(JSON.stringify({
      access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8_726_400,
    }), { status: 200 });
  };
  return { fetchFn, seenRefreshTokens, count: () => n };
}

let realmSeq = 0;
const nextRealm = () => `9341000${process.pid}${++realmSeq}`;

async function connected(store: TokenStore, accessExpiresInMs: number, realm = nextRealm()) {
  const t = await makeTenant(db, 'tokens');
  tenants.push(t);
  await store.saveConnection(t, realm, {
    accessToken: 'access-0', refreshToken: 'refresh-0',
    accessExpiresAt: new Date(Date.now() + accessExpiresInMs), refreshExpiresAt: null, responseKeys: [],
  });
  return t;
}

describe('TokenStore', () => {
  let intuit: ReturnType<typeof fakeIntuit>;
  beforeEach(() => { intuit = fakeIntuit({ delayMs: 50 }); });

  it('stores tokens encrypted, never in plaintext', async () => {
    const store = new TokenStore({ db, ring, app, fetchFn: intuit.fetchFn });
    const t = await connected(store, 3_600_000);
    const row = await withTenant(db, t, (tx) => tx.selectFrom('qbo_connections').selectAll().executeTakeFirstOrThrow());
    expect(row.access_token_enc.toString('latin1')).not.toContain('access-0');
    expect(row.refresh_token_enc.toString('latin1')).not.toContain('refresh-0');
    expect((await store.getAccessToken(t)).accessToken).toBe('access-0');
    expect(intuit.count()).toBe(0); // still fresh: no refresh call
  });

  it('concurrent callers with an expiring token trigger exactly one refresh', async () => {
    const store = new TokenStore({ db, ring, app, fetchFn: intuit.fetchFn });
    const t = await connected(store, 60_000); // inside the 5-minute skew
    const grants = await Promise.all(Array.from({ length: 5 }, () => store.getAccessToken(t)));
    expect(intuit.count()).toBe(1);
    expect(new Set(grants.map((g) => g.accessToken))).toEqual(new Set(['access-1']));
    // The rotated refresh token was persisted; the old one is never reused.
    expect(intuit.seenRefreshTokens).toEqual(['refresh-0']);
    await store.getAccessToken(t, { staleVersion: grants[0]!.tokenVersion });
    expect(intuit.seenRefreshTokens).toEqual(['refresh-0', 'refresh-1']);
  });

  it('a 401 from an already-superseded token does not refresh again', async () => {
    const store = new TokenStore({ db, ring, app, fetchFn: intuit.fetchFn });
    const t = await connected(store, 3_600_000);
    const first = await store.getAccessToken(t);
    await store.getAccessToken(t, { staleVersion: first.tokenVersion }); // refresh #1
    await store.getAccessToken(t, { staleVersion: first.tokenVersion }); // stale version: no refresh
    expect(intuit.count()).toBe(1);
  });

  it('invalid_grant marks the connection needs_reauth and stops calling Intuit', async () => {
    const bad = fakeIntuit({ fail: 'invalid_grant' });
    const store = new TokenStore({ db, ring, app, fetchFn: bad.fetchFn });
    const t = await connected(store, 0);
    await expect(store.getAccessToken(t)).rejects.toMatchObject({ code: 'QBO_REAUTH_REQUIRED' });
    const row = await withTenant(db, t, (tx) => tx.selectFrom('qbo_connections').select(['status', 'last_error']).executeTakeFirstOrThrow());
    expect(row).toEqual({ status: 'needs_reauth', last_error: 'invalid_grant' });
    await expect(store.getAccessToken(t)).rejects.toMatchObject({ code: 'QBO_REAUTH_REQUIRED' });
    expect(bad.seenRefreshTokens).toHaveLength(1);
  });

  it('a transient token-endpoint failure leaves stored tokens untouched', async () => {
    const down = fakeIntuit({ fail: 503 });
    const store = new TokenStore({ db, ring, app, fetchFn: down.fetchFn });
    const t = await connected(store, 0);
    await expect(store.getAccessToken(t)).rejects.toMatchObject({ code: 'QBO_UNAVAILABLE', retryable: true });
    const ok = new TokenStore({ db, ring, app, fetchFn: intuit.fetchFn });
    expect((await ok.getAccessToken(t)).accessToken).toBe('access-1');
    expect(intuit.seenRefreshTokens).toEqual(['refresh-0']);
  });

  it('reconnecting reactivates a needs_reauth connection', async () => {
    const bad = fakeIntuit({ fail: 'invalid_grant' });
    const store = new TokenStore({ db, ring, app, fetchFn: bad.fetchFn });
    const realm = nextRealm();
    const t = await connected(store, 0, realm);
    await store.getAccessToken(t).catch(() => {});
    await store.saveConnection(t, realm, {
      accessToken: 'new-access', refreshToken: 'new-refresh', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: null, responseKeys: [],
    });
    expect((await store.getAccessToken(t)).accessToken).toBe('new-access');
  });

  it('refuses to connect one QuickBooks company to two tenants', async () => {
    const store = new TokenStore({ db, ring, app, fetchFn: intuit.fetchFn });
    const realm = nextRealm();
    await connected(store, 3_600_000, realm);
    await expect(connected(store, 3_600_000, realm)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('throws NOT_CONNECTED for a tenant without a connection', async () => {
    const t = await makeTenant(db, 'none');
    tenants.push(t);
    const store = new TokenStore({ db, ring, app, fetchFn: intuit.fetchFn });
    await expect(store.getAccessToken(t)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
