import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './db-types';

// DATE columns stay 'YYYY-MM-DD' strings: converting them to JS Dates
// introduces timezone shifts that move invoices between aging buckets.
pg.types.setTypeParser(1082, (v) => v);

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(connectionString: string, opts: { max?: number } = {}): Db {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: opts.max ?? 10 }) }),
  });
}

/**
 * Run `fn` in a transaction scoped to one tenant. Row-level security policies
 * read app.current_tenant; set_config(..., true) makes it transaction-local,
 * so the setting can never leak to the next user of a pooled connection.
 * Every tenant data access in the app goes through here: there is no
 * unscoped path for tenant tables.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error('withTenant: tenantId must be a UUID');
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`.execute(tx);
    return fn(tx);
  });
}

/**
 * Cross-tenant system access (webhook realm routing, schedulers). Kept
 * deliberately separate and greppable: every call site is a reviewed exception.
 */
export async function asSystem<T>(db: Db, reason: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!reason) throw new Error('asSystem requires a reason');
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('app.system_mode', 'on', true)`.execute(tx);
    return fn(tx);
  });
}
