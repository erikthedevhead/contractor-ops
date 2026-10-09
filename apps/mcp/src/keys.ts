import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@co/db';

/**
 * Per-tenant API keys for the MCP server.
 *
 * Format: cok_<8 hex prefix>_<43 char base64url secret>   (256 bits of entropy)
 * Stored: prefix (for lookup and display) + sha256(full key). The plaintext is
 * shown once at creation and never stored. A fast hash is appropriate here:
 * the key is random and high-entropy, so there is nothing to brute-force.
 */
export const SCOPES = ['read', 'write:estimate'] as const;
export type Scope = (typeof SCOPES)[number];

const KEY_RE = /^cok_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const prefix = randomBytes(4).toString('hex');
  const key = `cok_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: hashKey(key) };
}

export const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest();

export function parseApiKey(key: string): { prefix: string } | null {
  const m = KEY_RE.exec(key);
  return m ? { prefix: m[1]! } : null;
}

export interface ResolvedKey {
  apiKeyId: string;
  tenantId: string;
  scopes: string[];
}

/** Runs as the app role through the SECURITY DEFINER resolver; the app cannot read api_keys directly. */
export async function resolveApiKey(db: Db, key: string): Promise<ResolvedKey | null> {
  const parsed = parseApiKey(key);
  if (!parsed) return null;
  const res = await sql<{ api_key_id: string; tenant_id: string; scopes: string[] }>`
    SELECT * FROM resolve_api_key(${parsed.prefix}, ${hashKey(key)})`.execute(db);
  const row = res.rows[0];
  return row ? { apiKeyId: row.api_key_id, tenantId: row.tenant_id, scopes: row.scopes } : null;
}

/** Operator-side (owner connection): create a key. Returns the plaintext once. */
export async function createApiKey(ownerDb: Db, tenantId: string, scopes: Scope[], label?: string): Promise<{ key: string; prefix: string }> {
  const { key, prefix, hash } = generateApiKey();
  await ownerDb.insertInto('api_keys').values({ tenant_id: tenantId, prefix, key_hash: hash, scopes, label: label ?? null }).execute();
  return { key, prefix };
}

export async function revokeApiKey(ownerDb: Db, prefix: string): Promise<boolean> {
  const r = await ownerDb.updateTable('api_keys').set({ revoked_at: new Date() }).where('prefix', '=', prefix).where('revoked_at', 'is', null).executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Constant-time string compare for the rare places a key is compared in app code. */
export const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
