import { withTenant, type Db } from '@co/db';
import { AppError, isAppError, logger as baseLogger, type Logger } from '@co/shared';
import { INTUIT } from './config';
import type { FetchLike } from './oauth';
import { backoffDelay, DEFAULT_RETRY, parseRetryAfter, sleep as realSleep, type RetryPolicy } from './retry';
import type { TokenStore } from './tokens';
import type { QboFault } from './types';

export interface ApiCallRecord {
  tenantId: string;
  method: string;
  endpoint: string;          // templated, realm removed: /v3/company/{realm}/query
  entityName: string | null;
  statusCode: number | null; // null = network error
  attempt: number;
  latencyMs: number;
  countsTowardCoreplus: boolean;
  intuitTid: string | null;
  qboRequestId: string | null;
}

/** Where call records go. Production: qbo_api_calls. Tests: an array. */
export type MeterSink = (rec: ApiCallRecord) => Promise<void> | void;

export interface QboClientDeps {
  tokens: TokenStore;
  meter: MeterSink;
  fetchFn?: FetchLike;      // fault-injection seam
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: Logger;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  /** Required for POST. Reused across retries so QuickBooks dedupes them. */
  requestId?: string;
  entityName?: string;
}

/**
 * Tenant-bound QuickBooks API client.
 *
 * Retries: 429, 5xx and network errors, with full-jitter backoff.
 * 401: refresh once (lock-coordinated in TokenStore), then retry.
 * Writes: a POST without a requestid is refused, so no write can ever be
 * retried in a way that creates duplicates.
 * Every attempt is metered, including failures, because failed attempts still
 * cost latency and 2xx reads count against the Intuit CorePlus quota.
 */
export class QboClient {
  private readonly fetchFn: FetchLike;
  private readonly policy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: Logger;

  constructor(readonly tenantId: string, private readonly deps: QboClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.policy = deps.retry ?? DEFAULT_RETRY;
    this.sleep = deps.sleep ?? realSleep;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? baseLogger;
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, opts);
  }

  post<T>(path: string, body: unknown, opts: RequestOptions & { requestId: string }): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body });
  }

  async request<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<T> {
    if (method === 'POST' && !opts.requestId) {
      throw new AppError('INTERNAL', 'POST to QuickBooks without a requestid is not allowed (duplicate risk)');
    }

    let grant = await this.deps.tokens.getAccessToken(this.tenantId);
    let refreshedAfter401 = false;

    for (let attempt = 1; ; attempt++) {
      const url = new URL(`${INTUIT.apiBase[grant.environment]}/v3/company/${grant.realmId}${path}`);
      url.searchParams.set('minorversion', String(INTUIT.minorVersion));
      if (opts.requestId) url.searchParams.set('requestid', opts.requestId);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

      const started = performance.now();
      let res: Response | undefined;
      let networkError: unknown;
      try {
        res = await this.fetchFn(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${grant.accessToken}`,
            Accept: 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        networkError = err;
      }
      const latencyMs = Math.round(performance.now() - started);
      const status = res?.status ?? null;

      await this.meter({
        method,
        endpoint: `/v3/company/{realm}${path}`,
        entityName: opts.entityName ?? null,
        statusCode: status,
        attempt,
        latencyMs,
        countsTowardCoreplus: method === 'GET' && status !== null && status >= 200 && status < 300,
        intuitTid: res?.headers.get('intuit_tid') ?? null,
        qboRequestId: opts.requestId ?? null,
      });

      if (res && res.ok) return (await res.json()) as T;

      // 401: token rejected. Refresh exactly once per request.
      if (status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        grant = await this.deps.tokens.getAccessToken(this.tenantId, { staleVersion: grant.tokenVersion });
        attempt--; // an auth refresh isn't a backoff attempt
        continue;
      }

      const error = res ? await this.toError(res) : new AppError('QBO_UNAVAILABLE', 'network error calling QuickBooks', { retryable: true, cause: networkError });
      if (!error.retryable || attempt >= this.policy.maxAttempts) {
        this.log.warn({ tenantId: this.tenantId, path, status, attempt, code: error.code }, 'qbo request failed');
        throw error;
      }
      const retryAfter = res ? parseRetryAfter(res.headers.get('retry-after')) : undefined;
      const delay = backoffDelay(attempt, this.policy, this.random, retryAfter);
      this.log.debug({ tenantId: this.tenantId, path, status, attempt, delay }, 'qbo request retrying');
      await this.sleep(delay);
    }
  }

  private async meter(rec: Omit<ApiCallRecord, 'tenantId'>): Promise<void> {
    try {
      await this.deps.meter({ tenantId: this.tenantId, ...rec });
    } catch (err) {
      // Metering must never break the request path.
      this.log.error({ err: isAppError(err) ? err.toJSON() : String(err) }, 'failed to record qbo api call');
    }
  }

  private async toError(res: Response): Promise<AppError> {
    const status = res.status;
    let fault: QboFault['Fault'] | undefined;
    try {
      fault = ((await res.json()) as Partial<QboFault>).Fault;
    } catch {
      /* non-JSON body */
    }
    const first = fault?.Error?.[0];
    const details = { status, faultType: fault?.type, qboCode: first?.code, qboMessage: first?.Message, element: first?.element };

    if (status === 429) return new AppError('QBO_RATE_LIMITED', 'QuickBooks rate limit hit', { retryable: true, status, details });
    if (status >= 500) return new AppError('QBO_UNAVAILABLE', `QuickBooks returned HTTP ${status}`, { retryable: true, status, details });
    if (status === 401 || status === 403) return new AppError('QBO_AUTH_EXPIRED', 'QuickBooks rejected the access token', { status, details });
    if (first?.code === '5010') return new AppError('QBO_STALE_OBJECT', 'QuickBooks object was modified by someone else (stale SyncToken)', { status, details });
    if (first?.code === '610' || status === 404) return new AppError('QBO_NOT_FOUND', first?.Message ?? 'QuickBooks object not found', { status, details });
    if (status === 400) return new AppError('QBO_VALIDATION', first?.Message ?? 'QuickBooks rejected the request', { status, details });
    return new AppError('QBO_UNKNOWN', `QuickBooks returned HTTP ${status}`, { status, details });
  }
}

/** Production meter: one row per attempt in qbo_api_calls. */
export function dbMeter(db: Db): MeterSink {
  return async (rec) => {
    await withTenant(db, rec.tenantId, (tx) =>
      tx
        .insertInto('qbo_api_calls')
        .values({
          tenant_id: rec.tenantId,
          method: rec.method,
          endpoint: rec.endpoint,
          entity_name: rec.entityName,
          status_code: rec.statusCode,
          attempt: rec.attempt,
          latency_ms: rec.latencyMs,
          counts_toward_coreplus: rec.countsTowardCoreplus,
          intuit_tid: rec.intuitTid,
          qbo_request_id: rec.qboRequestId,
        })
        .execute(),
    );
  };
}
