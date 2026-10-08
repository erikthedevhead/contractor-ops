/**
 * co-core: the API (OAuth, webhooks) and the job worker in one process.
 * One process keeps the 2 GB droplet comfortable; they share a DB pool and
 * the worker can be split out later without code changes.
 */
import { createDb, enqueue, withTenant } from '@co/db';
import { createApp } from '@co/api';
import { dbMeter, QboClient, TokenStore } from '@co/qbo';
import { env, logger } from '@co/shared';
import { Q, Worker } from '@co/worker';

const e = env();
const db = createDb(e.DATABASE_URL, { max: 10 });
const qbo = { environment: e.QBO_ENV, clientId: e.QBO_CLIENT_ID, clientSecret: e.QBO_CLIENT_SECRET, redirectUri: e.QBO_REDIRECT_URI };
const tokens = new TokenStore({ db, ring: { keys: e.TOKEN_ENC_KEYS, activeVersion: e.TOKEN_ENC_ACTIVE_VERSION }, app: qbo });
const clientFor = (tenantId: string) => new QboClient(tenantId, { tokens, meter: dbMeter(db) });

const app = createApp({
  db,
  tokens,
  qbo,
  connectLinkSecret: e.CONNECT_LINK_SECRET,
  webhookVerifier: e.QBO_WEBHOOK_VERIFIER || undefined,
  onConnected: (tenantId) => {
    withTenant(db, tenantId, (tx) => enqueue(tx, Q.initialSync, {}, { tenantId })).catch((err) =>
      logger.error({ tenantId, err: String(err) }, 'failed to enqueue initial sync'),
    );
  },
});

const worker = new Worker({ db, clientFor });
const server = app.listen(e.PORT, '127.0.0.1', () => logger.info({ port: e.PORT }, 'api listening'));
worker.start();
if (!e.QBO_WEBHOOK_VERIFIER) logger.warn('QBO_WEBHOOK_VERIFIER not set: /webhooks/qbo will answer 503');

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 15_000).unref();
  server.close();
  await worker.stop(); // finish the in-flight job
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
