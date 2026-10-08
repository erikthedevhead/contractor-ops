import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for secrets at rest (QuickBooks tokens).
 *
 * Blob layout: [version:1][iv:12][ciphertext:n][tag:16]
 *
 * - version: which key in the ring encrypted it, so keys can rotate without a
 *   flag day (new writes use the active key; old rows still decrypt).
 * - AAD binds the ciphertext to its context (tenant, realm, field). A blob
 *   copied into another tenant's row, or swapped between the access and
 *   refresh columns, fails authentication instead of silently decrypting.
 */
export interface KeyRing {
  keys: ReadonlyMap<number, Buffer>;
  activeVersion: number;
}

const IV_LEN = 12;
const TAG_LEN = 16;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function encrypt(ring: KeyRing, plaintext: string, aad: string): Buffer {
  const key = ring.keys.get(ring.activeVersion);
  if (!key || key.length !== 32) throw new Error('active encryption key missing or not 32 bytes');
  if (ring.activeVersion < 1 || ring.activeVersion > 255) throw new Error('key version must be 1..255');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([ring.activeVersion]), iv, ct, cipher.getAuthTag()]);
}

export function decrypt(ring: KeyRing, blob: Uint8Array, aad: string): string {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new DecryptionError('ciphertext too short');
  const version = buf[0]!;
  const key = ring.keys.get(version);
  if (!key) throw new DecryptionError(`no key for version ${version}`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Never include key material, plaintext or ciphertext in the message.
    throw new DecryptionError('authentication failed (wrong key, wrong context, or tampered data)');
  }
}

export function keyVersionOf(blob: Uint8Array): number {
  return blob[0] ?? 0;
}

/** AAD convention for QuickBooks token columns. */
export const tokenAad = (tenantId: string, realmId: string, field: 'access' | 'refresh') =>
  `qbo-token:v1:${tenantId}:${realmId}:${field}`;
