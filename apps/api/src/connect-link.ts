import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring "connect QuickBooks" links. The operator runs
 * `pnpm tenant:create`, which prints one; whoever opens it within the TTL
 * can connect that tenant's QuickBooks company. No session system needed for
 * the demo, and the link can't be forged or retargeted to another tenant.
 */
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signConnectLink(secretHex: string, tenantId: string, ttlMs = 30 * 60 * 1000, now = Date.now()): string {
  const payload = b64u(JSON.stringify({ tid: tenantId, exp: now + ttlMs }));
  const sig = b64u(createHmac('sha256', Buffer.from(secretHex, 'hex')).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyConnectLink(secretHex: string, token: string, now = Date.now()): { tenantId: string } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { tid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { tid?: string; exp?: number };
    if (typeof tid !== 'string' || typeof exp !== 'number' || exp < now) return null;
    return { tenantId: tid };
  } catch {
    return null;
  }
}
