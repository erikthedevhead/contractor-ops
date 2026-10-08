import { decrypt, encrypt, tokenAad, type KeyRing } from '@co/crypto';
import { withTenant, type Db } from '@co/db';
import { AppError, isAppError, logger as baseLogger, type Logger } from '@co/shared';
import type { QboAppConfig } from './config';
import { refreshTokens, type FetchLike, type TokenSet } from './oauth';

/** Refresh when fewer than this many ms remain on the access token. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface AccessGrant {
  accessToken: string;
  realmId: string;
  environment: 'sandbox' | 'production';
  /** Pass back as `staleVersion` after a 401 so concurrent callers refresh once, not N times. */
  tokenVersion: number;
}

export interface TokenStoreDeps {
  db: Db;
  ring: KeyRing;
  app: QboAppConfig;
  fetchFn?: FetchLike;
  now?: () => Date;
  log?: Logger;
}

/**
 * Owns QuickBooks tokens for every tenant.
 *
 * Refresh-token rotation: Intuit may return a new refresh token on any
 * refresh and invalidates the previous one. Two processes refreshing with the
 * same old token would race, and the loser gets invalid_grant, which looks
 * exactly like a revoked connection. So the refresh happens under a row lock
 * (SELECT ... FOR UPDATE): the second caller blocks, then sees the fresh token
 * and returns it without calling Intuit at all.
 */
export class TokenStore {
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(private readonly deps: TokenStoreDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? baseLogger;
  }

  /** Store tokens from a completed OAuth connect (or reconnect). */
  async saveConnection(tenantId: string, realmId: string, tokens: TokenSet): Promise<void> {
    const { db, ring, app } = this.deps;
    const access = encrypt(ring, tokens.accessToken, tokenAad(tenantId, realmId, 'access'));
    const refresh = encrypt(ring, tokens.refreshToken, tokenAad(tenantId, realmId, 'refresh'));
    try {
      await this.upsertConnection(tenantId, realmId, tokens, access, refresh);
    } catch (err) {
      // (environment, realm_id) is unique: one QuickBooks company maps to exactly
      // one tenant, which is what makes webhook realm -> tenant routing safe.
      if ((err as { code?: string }).code === '23505') {
        throw new AppError('BAD_REQUEST', 'This QuickBooks company is already connected to a different account', { details: { realmId } });
      }
      throw err;
    }
    this.log.info({ tenantId, realmId, responseKeys: tokens.responseKeys }, 'qbo connection saved');
  }

  private async upsertConnection(tenantId: string, realmId: string, tokens: TokenSet, access: Buffer, refresh: Buffer): Promise<void> {
    const { db, ring, app } = this.deps;
    await withTenant(db, tenantId, async (tx) => {
      await tx
        .insertInto('qbo_connections')
        .values({
          tenant_id: tenantId,
          environment: app.environment,
          realm_id: realmId,
          status: 'active',
          access_token_enc: access,
          refresh_token_enc: refresh,
          enc_key_version: ring.activeVersion,
          access_expires_at: tokens.accessExpiresAt,
          refresh_expires_at: tokens.refreshExpiresAt,
          last_refreshed_at: this.now(),
        })
        .onConflict((oc) =>
          oc.column('tenant_id').doUpdateSet((eb) => ({
            environment: app.environment,
            realm_id: realmId,
            status: 'active',
            access_token_enc: access,
            refresh_token_enc: refresh,
            enc_key_version: ring.activeVersion,
            access_expires_at: tokens.accessExpiresAt,
            refresh_expires_at: tokens.refreshExpiresAt,
            token_version: eb('qbo_connections.token_version', '+', 1),
            last_refreshed_at: this.now(),
            last_error: null,
            updated_at: this.now(),
          })),
        )
        .execute();
    });
  }

  /**
   * Returns a usable access token, refreshing if it is near expiry or if the
   * caller just got a 401 using `staleVersion`.
   */
  async getAccessToken(tenantId: string, opts: { staleVersion?: number } = {}): Promise<AccessGrant> {
    const { db, ring, app } = this.deps;

    const outcome = await withTenant(db, tenantId, async (tx) => {
      const row = await tx
        .selectFrom('qbo_connections')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .forUpdate()
        .executeTakeFirst();

      if (!row) return { kind: 'not_connected' as const };
      if (row.status !== 'active') return { kind: 'reauth' as const };

      const realmId = row.realm_id;
      const msLeft = row.access_expires_at.getTime() - this.now().getTime();
      const callerHasStale = opts.staleVersion !== undefined && opts.staleVersion === row.token_version;
      if (msLeft > REFRESH_SKEW_MS && !callerHasStale) {
        return {
          kind: 'ok' as const,
          grant: {
            accessToken: decrypt(ring, row.access_token_enc, tokenAad(tenantId, realmId, 'access')),
            realmId,
            environment: row.environment,
            tokenVersion: row.token_version,
          },
        };
      }

      const currentRefresh = decrypt(ring, row.refresh_token_enc, tokenAad(tenantId, realmId, 'refresh'));
      let tokens: TokenSet;
      try {
        tokens = await refreshTokens(app, currentRefresh, this.fetchFn, this.now());
      } catch (err) {
        if (isAppError(err) && err.code === 'QBO_REAUTH_REQUIRED') {
          // Persist the state change; the throw happens after commit (below).
          await tx
            .updateTable('qbo_connections')
            .set({ status: 'needs_reauth', last_error: 'invalid_grant', updated_at: this.now() })
            .where('tenant_id', '=', tenantId)
            .execute();
          return { kind: 'reauth' as const };
        }
        throw err; // transient: roll back, leave tokens untouched, let the caller retry
      }

      const nextVersion = row.token_version + 1;
      await tx
        .updateTable('qbo_connections')
        .set({
          access_token_enc: encrypt(ring, tokens.accessToken, tokenAad(tenantId, realmId, 'access')),
          refresh_token_enc: encrypt(ring, tokens.refreshToken, tokenAad(tenantId, realmId, 'refresh')),
          enc_key_version: ring.activeVersion,
          access_expires_at: tokens.accessExpiresAt,
          refresh_expires_at: tokens.refreshExpiresAt ?? row.refresh_expires_at,
          token_version: nextVersion,
          last_refreshed_at: this.now(),
          last_error: null,
          updated_at: this.now(),
        })
        .where('tenant_id', '=', tenantId)
        .execute();

      this.log.info({ tenantId, realmId, tokenVersion: nextVersion, responseKeys: tokens.responseKeys }, 'qbo tokens refreshed');
      return {
        kind: 'ok' as const,
        grant: { accessToken: tokens.accessToken, realmId, environment: row.environment, tokenVersion: nextVersion },
      };
    });

    if (outcome.kind === 'not_connected') throw new AppError('NOT_CONNECTED', 'QuickBooks is not connected for this tenant');
    if (outcome.kind === 'reauth') {
      this.log.warn({ tenantId }, 'qbo connection requires re-authorization');
      throw new AppError('QBO_REAUTH_REQUIRED', 'QuickBooks authorization is no longer valid; reconnect required');
    }
    return outcome.grant;
  }
}
