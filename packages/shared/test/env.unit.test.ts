import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '../src/env';

const base = {
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://a:b@localhost/c',
  TOKEN_ENC_ACTIVE_VERSION: '1',
  CONNECT_LINK_SECRET: 'ab'.repeat(32),
  QBO_CLIENT_ID: 'client-id-000',
  QBO_CLIENT_SECRET: 'client-secret-000',
  QBO_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
};
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe('env validation', () => {
  it('never echoes a malformed key into the error', () => {
    const secretish = 'SFhKo0oWWnTOPSECRETVALUEabcdefghijklmnopqr=';
    process.env = { ...base, TOKEN_ENC_KEYS: secretish };
    let message = '';
    try {
      env();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('TOKEN_ENC_KEYS');
    expect(message).toContain('must be JSON');
    expect(message).not.toContain('SFhKo');
  });

  it('accepts a proper key ring', () => {
    process.env = { ...base, TOKEN_ENC_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }) };
    expect(env().TOKEN_ENC_KEYS.get(1)).toHaveLength(32);
  });
});
