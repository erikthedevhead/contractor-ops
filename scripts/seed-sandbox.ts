/**
 * Seeds the QuickBooks SANDBOX company with a remodeling contractor's history:
 * 21 service items, 16 customers, 40 jobs (estimates -> invoices -> payments).
 *
 * Usage:
 *   pnpm seed:sandbox <tenant-id> [--anchor YYYY-MM-DD] [--dry-run]
 *
 * Idempotency (the same pattern the agent's writes use):
 *   1. seed_ledger maps each seed key to the QuickBooks object it created;
 *      keys already in the ledger are skipped.
 *   2. Each create carries requestid = uuidv5(tenant:seedKey). If the process
 *      dies after QuickBooks created an object but before the ledger write,
 *      the re-run sends the same requestid and QuickBooks returns the original
 *      object instead of creating a duplicate.
 *   3. Name collisions on items/customers (QuickBooks error 6240) are resolved
 *      by adopting the existing object.
 * The anchor date is stored on first run, so re-running on a later day
 * reproduces the same plan.
 */
import { createDb } from '@co/db';
import { dbMeter, QboClient, TokenStore } from '@co/qbo';
import { AppError, env } from '@co/shared';
import { runSeed } from './seed/run';

const args = process.argv.slice(2);
const tenantId = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--anchor');
const dryRun = args.includes('--dry-run');
const anchor = args.includes('--anchor') ? args[args.indexOf('--anchor') + 1] : undefined;

if (!tenantId) {
  console.error('usage: pnpm seed:sandbox <tenant-id> [--anchor YYYY-MM-DD] [--dry-run]');
  process.exit(1);
}

const e = env();
if (e.QBO_ENV !== 'sandbox') {
  console.error('Refusing to seed: QBO_ENV is not "sandbox".');
  process.exit(1);
}

const db = createDb(e.DATABASE_URL, { max: 2 });
const qbo = { environment: e.QBO_ENV, clientId: e.QBO_CLIENT_ID, clientSecret: e.QBO_CLIENT_SECRET, redirectUri: e.QBO_REDIRECT_URI };
const tokens = new TokenStore({ db, ring: { keys: e.TOKEN_ENC_KEYS, activeVersion: e.TOKEN_ENC_ACTIVE_VERSION }, app: qbo });
const client = new QboClient(tenantId, { tokens, meter: dbMeter(db) });

runSeed({ db, client, tenantId, anchor, dryRun })
  .then(() => {
    if (!dryRun) console.log(`Next: pnpm sync:initial ${tenantId}`);
  })
  .catch((err) => {
    console.error(err instanceof AppError ? `${err.code}: ${err.message} ${JSON.stringify(err.opts.details ?? {})}` : err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
