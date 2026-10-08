// Usage: pnpm reconcile <tenant-id>
// Runs the CDC reconcile immediately (the worker also runs it nightly).
import { createDb } from '@co/db';
import { dbMeter, QboClient, reconcile, TokenStore } from '@co/qbo';
import { env } from '@co/shared';

const e = env();
const tenantId = process.argv[2];
if (!tenantId) {
  console.error('usage: pnpm reconcile <tenant-id>');
  process.exit(1);
}
const db = createDb(e.DATABASE_URL, { max: 2 });
const qbo = { environment: e.QBO_ENV, clientId: e.QBO_CLIENT_ID, clientSecret: e.QBO_CLIENT_SECRET, redirectUri: e.QBO_REDIRECT_URI };
const tokens = new TokenStore({ db, ring: { keys: e.TOKEN_ENC_KEYS, activeVersion: e.TOKEN_ENC_ACTIVE_VERSION }, app: qbo });

reconcile(db, new QboClient(tenantId, { tokens, meter: dbMeter(db) }))
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
