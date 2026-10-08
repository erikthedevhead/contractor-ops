/**
 * Error taxonomy shared by the integration layer, MCP tools and agents.
 * `retryable` drives the retry policy; `code` is what tools hand back to the
 * agent so it can recover without ever seeing a stack trace.
 */
export type ErrorCode =
  | 'QBO_RATE_LIMITED'
  | 'QBO_UNAVAILABLE'
  | 'QBO_AUTH_EXPIRED'      // access token rejected: refresh and retry once
  | 'QBO_REAUTH_REQUIRED'   // refresh token invalid/revoked: a human must reconnect
  | 'QBO_VALIDATION'
  | 'QBO_NOT_FOUND'
  | 'QBO_STALE_OBJECT'      // SyncToken conflict
  | 'QBO_UNKNOWN'
  | 'NOT_CONNECTED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

export interface AppErrorOptions {
  retryable?: boolean;
  status?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly opts: AppErrorOptions;
  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.opts = opts;
  }
  get retryable(): boolean {
    return this.opts.retryable ?? false;
  }
  /** Safe, serializable shape for logs and tool responses. */
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.opts.details };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
