/**
 * Exponential backoff with full jitter (AWS architecture blog's "full jitter"):
 *   delay = random(0, min(cap, base * 2^attempt))
 * Full jitter spreads retries from many workers so a 429 doesn't turn into a
 * synchronized thundering herd. A server-provided Retry-After wins when larger.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseMs: 500, capMs: 20_000 };

export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random, retryAfterMs?: number): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  const jittered = Math.floor(random() * exp);
  return retryAfterMs !== undefined ? Math.min(policy.capMs, Math.max(jittered, retryAfterMs)) : jittered;
}

/** Retry-After as seconds or HTTP date -> ms. */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
