import { randomBytes } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { asSystem, withTenant, type Db } from '@co/db';
import { buildAuthorizeUrl, exchangeCode, type FetchLike, type QboAppConfig, type TokenStore } from '@co/qbo';
import { ingestDelivery } from './webhooks';
import { isAppError, logger as baseLogger, type Logger } from '@co/shared';
import { verifyConnectLink } from './connect-link';

export interface AppDeps {
  db: Db;
  tokens: TokenStore;
  qbo: QboAppConfig;
  connectLinkSecret: string;
  /** Intuit webhook verifier token. Without it the webhook endpoint answers 503. */
  webhookVerifier?: string;
  /** Called after a successful connect (Day 1: kick off initial sync; Day 2: enqueue a job). */
  onConnected?: (tenantId: string, realmId: string) => void;
  fetchFn?: FetchLike;
  log?: Logger;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export function createApp(deps: AppDeps) {
  const log = deps.log ?? baseLogger;
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  /**
   * Intuit webhooks. Raw body parser: the signature is over the exact bytes,
   * so the body must not be parsed and re-serialized before verification.
   */
  app.post('/webhooks/qbo', express.raw({ type: () => true, limit: '1mb' }), async (req: Request, res: Response) => {
    if (!deps.webhookVerifier) {
      log.error('webhook received but QBO_WEBHOOK_VERIFIER is not configured');
      return void res.status(503).end();
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await ingestDelivery(deps.db, {
      rawBody: raw,
      signature: req.get('intuit-signature'),
      verifierToken: deps.webhookVerifier,
      environment: deps.qbo.environment,
    }, log);
    res.status(result.status).end();
  });

  /** Step 1: signed link -> one-time OAuth state -> redirect to Intuit. */
  app.get('/oauth/connect', async (req: Request, res: Response) => {
    const link = typeof req.query.t === 'string' ? verifyConnectLink(deps.connectLinkSecret, req.query.t) : null;
    if (!link) return void page(res, 400, 'Link invalid or expired', 'Ask for a new connect link (pnpm tenant:create or tenant:link).');

    const state = randomBytes(32).toString('base64url');
    await withTenant(deps.db, link.tenantId, (tx) =>
      tx.insertInto('oauth_states').values({ state, tenant_id: link.tenantId, expires_at: new Date(Date.now() + STATE_TTL_MS) }).execute(),
    );
    res.redirect(302, buildAuthorizeUrl(deps.qbo, state));
  });

  /** Step 2: Intuit redirects back with code + realmId + our state. */
  app.get('/oauth/callback', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.error) {
      log.warn({ error: q.error }, 'oauth callback returned an error');
      return void page(res, 400, 'QuickBooks connection was not completed', `Intuit returned: ${q.error}`);
    }
    if (!q.code || !q.state || !q.realmId) return void page(res, 400, 'Missing parameters', 'Expected code, state and realmId.');

    // The state row tells us which tenant this is, so the lookup necessarily
    // happens before a tenant is known: a narrow, single-purpose system read.
    // Consuming it in the same statement makes the state single-use.
    const consumed = await asSystem(deps.db, 'oauth state lookup', (tx) =>
      tx
        .updateTable('oauth_states')
        .set({ consumed_at: new Date() })
        .where('state', '=', q.state!)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', new Date())
        .returning('tenant_id')
        .executeTakeFirst(),
    );
    if (!consumed) return void page(res, 400, 'Connection request expired or already used', 'Start again from a fresh connect link.');

    try {
      const tokens = await exchangeCode(deps.qbo, q.code, deps.fetchFn);
      await deps.tokens.saveConnection(consumed.tenant_id, q.realmId, tokens);
    } catch (err) {
      const msg = isAppError(err) ? err.message : 'Unexpected error while connecting.';
      log.error({ tenantId: consumed.tenant_id, err: isAppError(err) ? err.toJSON() : String(err) }, 'oauth callback failed');
      return void page(res, 502, 'Could not complete the QuickBooks connection', msg);
    }

    log.info({ tenantId: consumed.tenant_id, realmId: q.realmId }, 'quickbooks connected');
    deps.onConnected?.(consumed.tenant_id, q.realmId);
    page(res, 200, 'QuickBooks connected', 'Initial sync has started. You can close this tab.');
  });

  // Express 5 forwards async errors here.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    log.error({ err: isAppError(err) ? err.toJSON() : String(err) }, 'unhandled request error');
    page(res, 500, 'Something went wrong', 'The error has been logged.');
  });

  return app;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(res: Response, status: number, title: string, body: string) {
  res
    .status(status)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.4rem">${esc(title)}</h1><p>${esc(body)}</p></body>`);
}
