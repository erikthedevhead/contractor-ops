import { createDb } from '@co/db';
import { dbMeter, initialSync, QboClient, TokenStore } from '@co/qbo';
import { env, logger } from '@co/shared';
import { createApp } from './app';

const e = env();
const db = createDb(e.DATABASE_URL);
const qbo = { environment: e.QBO_ENV, clientId: e.QBO_CLIENT_ID, clientSecret: e.QBO_CLIENT_SECRET, redirectUri: e.QBO_REDIRECT_URI };
const tokens = new TokenStore({ db, ring: { keys: e.TOKEN_ENC_KEYS, activeVersion: e.TOKEN_ENC_ACTIVE_VERSION }, app: qbo });

const app = createApp({
  db,
  tokens,
  qbo,
  connectLinkSecret: e.CONNECT_LINK_SECRET,
  // Day 1: run the initial sync in-process. Day 2 replaces this with a pg-boss job.
  onConnected: (tenantId) => {
    const client = new QboClient(tenantId, { tokens, meter: dbMeter(db) });
    initialSync(db, client).then(
      (stats) => logger.info({ tenantId, stats }, 'initial sync complete'),
      (err) => logger.error({ tenantId, err: String(err) }, 'initial sync failed; re-run with pnpm sync:initial'),
    );
  },
});

const server = app.listen(e.PORT, () => logger.info({ port: e.PORT }, 'api listening'));

const shutdown = () => {
  server.close(() => void db.destroy().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
