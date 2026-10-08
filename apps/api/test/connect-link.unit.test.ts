import { describe, expect, it } from 'vitest';
import { signConnectLink, verifyConnectLink } from '../src/connect-link';

const secret = 'ab'.repeat(32);
const tid = '11111111-2222-4333-8444-555555555555';

describe('connect links', () => {
  it('round-trips', () => {
    expect(verifyConnectLink(secret, signConnectLink(secret, tid))).toEqual({ tenantId: tid });
  });
  it('expires', () => {
    const t = signConnectLink(secret, tid, 1000, 0);
    expect(verifyConnectLink(secret, t, 2000)).toBeNull();
  });
  it('rejects a payload retargeted to another tenant', () => {
    const [, sig] = signConnectLink(secret, tid).split('.');
    const forged = Buffer.from(JSON.stringify({ tid: 'other', exp: Date.now() + 1e6 })).toString('base64url');
    expect(verifyConnectLink(secret, `${forged}.${sig}`)).toBeNull();
  });
  it('rejects a link signed with a different secret', () => {
    expect(verifyConnectLink(secret, signConnectLink('cd'.repeat(32), tid))).toBeNull();
  });
  it('rejects garbage', () => {
    expect(verifyConnectLink(secret, 'nope')).toBeNull();
    expect(verifyConnectLink(secret, 'a.b.c')).toBeNull();
  });
});
