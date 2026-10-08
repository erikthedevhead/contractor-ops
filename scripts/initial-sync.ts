// Usage: pnpm sync:initial <tenant-id>
// Full pull of Customers, Items, Estimates, Invoices, Payments into the mirror. Safe to re-run.
import { createDb, withTenant } from '@co/db';
import { dbMeter, initialSync, QboClient, TokenStore } from '@co/qbo';
import { env } from '@co/shared';
import { sql } from 'kysely';

const e = env();
const tenantId = process.argv[2];
if (!tenantId) {
  console.error('usage: pnpm sync:initial <tenant-id>');
  process.exit(1);
}

const db = createDb(e.DATABASE_URL, { max: 2 });
const qbo = { environment: e.QBO_ENV, clientId: e.QBO_CLIENT_ID, clientSecret: e.QBO_CLIENT_SECRET, redirectUri: e.QBO_REDIRECT_URI };
const tokens = new TokenStore({ db, ring: { keys: e.TOKEN_ENC_KEYS, activeVersion: e.TOKEN_ENC_ACTIVE_VERSION }, app: qbo });
const client = new QboClient(tenantId, { tokens, meter: dbMeter(db) });

try {
  const started = new Date();
  const stats = await initialSync(db, client);
  console.table(stats);
  const calls = await withTenant(db, tenantId, (tx) =>
    tx
      .selectFrom('qbo_api_calls')
      .select([sql<number>`count(*)::int`.as('calls'), sql<number>`count(*) filter (where counts_toward_coreplus)::int`.as('coreplus')])
      .where('created_at', '>=', started)
      .executeTakeFirstOrThrow(),
  );
  console.log(`QuickBooks API calls this run: ${calls.calls} (${calls.coreplus} count toward CorePlus)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
