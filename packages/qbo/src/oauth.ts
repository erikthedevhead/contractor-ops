import { z } from 'zod';
import { AppError } from '@co/shared';
import { INTUIT, type QboAppConfig } from './config';

/**
 * Token endpoint response. We read only what we need and log only key names
 * (never values). Intuit's newer max-lifetime field for refresh tokens is
 * picked up if present; x_refresh_token_expires_in is the long-standing one.
 */
const TokenResponse = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.coerce.number().int().positive(),
    x_refresh_token_expires_in: z.coerce.number().int().positive().optional(),
  })
  .loose();

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  /** Response field names (no values), for diagnosing Intuit-side changes. */
  responseKeys: string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function buildAuthorizeUrl(cfg: QboAppConfig, state: string): string {
  const u = new URL(INTUIT.authorizeUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', INTUIT.scope);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeCode(cfg: QboAppConfig, code: string, fetchFn: FetchLike = fetch, now = new Date()): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }, fetchFn, now);
}

export async function refreshTokens(cfg: QboAppConfig, refreshToken: string, fetchFn: FetchLike = fetch, now = new Date()): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchFn, now);
}

export async function revokeToken(cfg: QboAppConfig, token: string, fetchFn: FetchLike = fetch): Promise<void> {
  const res = await fetchFn(INTUIT.revokeUrl, {
    method: 'POST',
    headers: { ...basicAuth(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new AppError('QBO_UNKNOWN', `token revoke failed with HTTP ${res.status}`);
}

async function tokenRequest(cfg: QboAppConfig, form: Record<string, string>, fetchFn: FetchLike, now: Date): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchFn(INTUIT.tokenUrl, {
      method: 'POST',
      headers: { ...basicAuth(cfg), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (cause) {
    throw new AppError('QBO_UNAVAILABLE', 'token endpoint unreachable', { retryable: true, cause });
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const err = (json as { error?: string } | undefined)?.error;
    // invalid_grant = refresh token expired, revoked, or already rotated away.
    // No amount of retrying fixes it: a human has to reconnect.
    if (err === 'invalid_grant') {
      throw new AppError('QBO_REAUTH_REQUIRED', 'QuickBooks authorization is no longer valid; reconnect required', { status: res.status });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new AppError('QBO_UNAVAILABLE', `token endpoint returned HTTP ${res.status}`, { retryable: true, status: res.status });
    }
    throw new AppError('QBO_UNKNOWN', `token endpoint returned HTTP ${res.status}${err ? ` (${err})` : ''}`, { status: res.status });
  }

  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw new AppError('QBO_UNKNOWN', 'unexpected token response shape');
  const t = parsed.data;
  const ms = now.getTime();
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAt: new Date(ms + t.expires_in * 1000),
    refreshExpiresAt: t.x_refresh_token_expires_in ? new Date(ms + t.x_refresh_token_expires_in * 1000) : null,
    responseKeys: Object.keys(json as object).sort(),
  };
}

function basicAuth(cfg: QboAppConfig): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}` };
}
