import { describe, expect, it } from 'vitest';
import { uuidv5 } from '../src/ids';

describe('uuidv5', () => {
  it('matches the RFC 4122 reference vector', () => {
    // DNS namespace + "www.example.com" is the canonical v5 test vector.
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
  it('is deterministic and input-sensitive', () => {
    const ns = '6f1c2a4e-8b3d-5e7f-9a1b-2c3d4e5f6a7b';
    expect(uuidv5('seed:E001', ns)).toBe(uuidv5('seed:E001', ns));
    expect(uuidv5('seed:E001', ns)).not.toBe(uuidv5('seed:E002', ns));
  });
});
