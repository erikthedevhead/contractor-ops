import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@co/db';
import { TokenStore, type QboAppConfig } from '@co/qbo';
import { dropTenant, makeTenant, testDb } from '../../../packages/db/test/helpers';
import { createApp } from '../src/app';
import { signConnectLink } from '../src/connect-link';

const db = testDb();
const secret = randomBytes(32).toString('hex');
const qbo: QboAppConfig = { environment: 'sandbox', clientId: 'cid-000000', clientSecret: 'sec-000000', redirectUri: 'http://localhost/oauth/callback' };

const intuitToken = async () =>
  new Response(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, x_refresh_token_expires_in: 8_726_400 }), { status: 200 });

const tokens = new TokenStore({ db, ring: { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 }, app: qbo, fetchFn: intuitToken });
const connected: string[] = [];
let server: Server;
let base: string;
let tenant: string;

beforeAll(async () => {
  tenant = await makeTenant(db, 'oauth');
  const app = createApp({ db, tokens, qbo, connectLinkSecret: secret, fetchFn: intuitToken, onConnected: (t) => void connected.push(t) });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await dropTenant(db, tenant);
  await db.destroy();
});

const get = (path: string) => fetch(base + path, { redirect: 'manual' });

async function startConnect(): Promise<string> {
  const res = await get(`/oauth/connect?t=${signConnectLink(secret, tenant)}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
  expect(loc.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
  expect(loc.searchParams.get('redirect_uri')).toBe(qbo.redirectUri);
  return loc.searchParams.get('state')!;
}

describe('OAuth connect flow', () => {
  it('rejects an invalid connect link', async () => {
    expect((await get('/oauth/connect?t=bogus')).status).toBe(400);
  });

  it('rejects a callback with an unknown state', async () => {
    expect((await get('/oauth/callback?code=c&state=nope&realmId=1')).status).toBe(400);
  });

  it('connects, stores encrypted tokens, and makes the state single-use', async () => {
    const state = await startConnect();
    const realm = `9341${Date.now()}`;
    const ok = await get(`/oauth/callback?code=abc&state=${state}&realmId=${realm}`);
    expect(ok.status).toBe(200);
    expect(connected).toEqual([tenant]);

    const row = await withTenant(db, tenant, (tx) => tx.selectFrom('qbo_connections').selectAll().executeTakeFirstOrThrow());
    expect(row.realm_id).toBe(realm);
    expect(row.status).toBe('active');
    expect(row.access_token_enc.includes(Buffer.from('acc'))).toBe(false);

    const replay = await get(`/oauth/callback?code=abc&state=${state}&realmId=${realm}`);
    expect(replay.status).toBe(400);
  });

  it('handles a user who clicks Cancel at Intuit', async () => {
    const res = await get('/oauth/callback?error=access_denied&state=x');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('access_denied');
  });

  it('escapes reflected error text', async () => {
    const res = await get('/oauth/callback?error=%3Cscript%3Ealert(1)%3C/script%3E');
    expect(await res.text()).not.toContain('<script>');
  });
});
