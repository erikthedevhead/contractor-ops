import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, DecryptionError, encrypt, keyVersionOf, tokenAad, type KeyRing } from '../src/index';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ring1: KeyRing = { keys: new Map([[1, k1]]), activeVersion: 1 };
const ring12: KeyRing = { keys: new Map([[1, k1], [2, k2]]), activeVersion: 2 };
const aad = tokenAad('tenant-a', '9341', 'refresh');

describe('AES-256-GCM token envelope', () => {
  it('round-trips', () => {
    expect(decrypt(ring1, encrypt(ring1, 'secret-token', aad), aad)).toBe('secret-token');
  });

  it('uses a fresh IV per encryption', () => {
    expect(encrypt(ring1, 'same', aad).equals(encrypt(ring1, 'same', aad))).toBe(false);
  });

  it('rejects a blob moved to another tenant (AAD mismatch)', () => {
    const blob = encrypt(ring1, 'secret', aad);
    expect(() => decrypt(ring1, blob, tokenAad('tenant-b', '9341', 'refresh'))).toThrow(DecryptionError);
  });

  it('rejects a blob swapped between access and refresh columns', () => {
    const blob = encrypt(ring1, 'secret', aad);
    expect(() => decrypt(ring1, blob, tokenAad('tenant-a', '9341', 'access'))).toThrow(DecryptionError);
  });

  it('rejects tampered ciphertext', () => {
    const blob = encrypt(ring1, 'secret', aad);
    blob[20] = blob[20]! ^ 0xff;
    expect(() => decrypt(ring1, blob, aad)).toThrow(DecryptionError);
  });

  it('supports key rotation: old blobs decrypt, new blobs use the active key', () => {
    const old = encrypt(ring1, 'old', aad);
    const fresh = encrypt(ring12, 'new', aad);
    expect(keyVersionOf(old)).toBe(1);
    expect(keyVersionOf(fresh)).toBe(2);
    expect(decrypt(ring12, old, aad)).toBe('old');
    expect(decrypt(ring12, fresh, aad)).toBe('new');
  });

  it('error messages never leak plaintext', () => {
    const blob = encrypt(ring1, 'super-secret-value', aad);
    try {
      decrypt(ring1, blob, 'wrong');
    } catch (e) {
      expect(String(e)).not.toContain('super-secret-value');
    }
  });
});
