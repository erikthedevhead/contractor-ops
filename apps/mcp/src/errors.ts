import { isAppError } from '@co/shared';
import { logger } from '@co/shared';

/**
 * Tool error contract. Every failure an agent can see has a stable code, a
 * human-readable message, a retryable flag, and (where useful) a hint about
 * what to do next. Unexpected errors are logged in full server-side and
 * reach the agent only as INTERNAL: no stack traces, no SQL, no provider bodies.
 */
export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_CONFIRMATION_TOKEN'
  | 'CONFIRMATION_EXPIRED'
  | 'WRITE_IN_PROGRESS'
  | 'WRITE_FAILED'
  | 'QUICKBOOKS_UNAVAILABLE'
  | 'QUICKBOOKS_REJECTED'
  | 'QUICKBOOKS_NOT_CONNECTED'
  | 'INTERNAL';

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string, readonly opts: { retryable?: boolean; hint?: string; details?: Record<string, unknown> } = {}) {
    super(message);
  }
}

export interface ToolErrorBody {
  error: { code: ToolErrorCode; message: string; retryable: boolean; hint?: string; details?: Record<string, unknown> };
}

export function toToolErrorBody(err: unknown, ctx: { tool: string; tenantId: string }): ToolErrorBody {
  if (err instanceof ToolError) {
    return { error: { code: err.code, message: err.message, retryable: err.opts.retryable ?? false, hint: err.opts.hint, details: err.opts.details } };
  }
  if (isAppError(err)) {
    switch (err.code) {
      case 'QBO_RATE_LIMITED':
      case 'QBO_UNAVAILABLE':
        return { error: { code: 'QUICKBOOKS_UNAVAILABLE', message: 'QuickBooks is temporarily unavailable.', retryable: true, hint: 'Wait briefly and retry the same call.' } };
      case 'QBO_REAUTH_REQUIRED':
      case 'NOT_CONNECTED':
        return { error: { code: 'QUICKBOOKS_NOT_CONNECTED', message: 'QuickBooks needs to be reconnected for this account.', retryable: false, hint: 'Tell the user to reconnect QuickBooks; reads from the local mirror still work.' } };
      case 'QBO_VALIDATION':
      case 'QBO_STALE_OBJECT':
      case 'QBO_NOT_FOUND':
        return { error: { code: 'QUICKBOOKS_REJECTED', message: `QuickBooks rejected the request: ${err.message}`, retryable: false } };
    }
  }
  logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err), ...ctx }, 'tool failed unexpectedly');
  return { error: { code: 'INTERNAL', message: 'Unexpected server error. It has been logged.', retryable: false } };
}
