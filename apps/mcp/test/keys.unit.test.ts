import { describe, expect, it } from 'vitest';
import { generateApiKey, hashKey, parseApiKey } from '../src/keys';
import { canonicalJson } from '../src/tools/estimate';

describe('API keys', () => {
  it('generates parseable, high-entropy keys whose hash matches', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^cok_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKey(key)).toEqual({ prefix });
    expect(hashKey(key).equals(hash)).toBe(true);
    expect(generateApiKey().key).not.toBe(key);
  });
  it('rejects malformed keys before touching the database', () => {
    for (const bad of ['', 'cok_123', 'Bearer x', `cok_zzzzzzzz_${'a'.repeat(43)}`, `cok_12345678_${'a'.repeat(42)}`]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });
});

describe('canonicalJson', () => {
  it('is key-order independent (jsonb reorders keys)', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe(canonicalJson({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });
});
