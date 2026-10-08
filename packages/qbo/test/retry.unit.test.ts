import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_RETRY, parseRetryAfter } from '../src/retry';

describe('backoff with full jitter', () => {
  it('stays within [0, base * 2^(n-1)] and respects the cap', () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(DEFAULT_RETRY.capMs, DEFAULT_RETRY.baseMs * 2 ** (attempt - 1));
      expect(backoffDelay(attempt, DEFAULT_RETRY, () => 0)).toBe(0);
      expect(backoffDelay(attempt, DEFAULT_RETRY, () => 0.999999)).toBeLessThan(ceiling);
    }
  });

  it('honors a larger Retry-After but never beyond the cap', () => {
    expect(backoffDelay(1, DEFAULT_RETRY, () => 0, 3000)).toBe(3000);
    expect(backoffDelay(1, DEFAULT_RETRY, () => 0, 600_000)).toBe(DEFAULT_RETRY.capMs);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    const now = new Date('2026-10-07T12:00:00Z');
    expect(parseRetryAfter('Wed, 07 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});
