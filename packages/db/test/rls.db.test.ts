import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, withTenant } from '../src/client';
import { dropTenant, makeTenant, testDb } from './helpers';

const db = testDb();
let a: string;
let b: string;

const customer = (tenant: string, id: string) => ({
  tenant_id: tenant, qbo_id: id, sync_token: 0, qbo_updated_at: new Date(), display_name: `C${id}`, raw: '{}',
});

beforeAll(async () => {
  a = await makeTenant(db, 'rls-a');
  b = await makeTenant(db, 'rls-b');
  await withTenant(db, a, (tx) => tx.insertInto('qbo_customers').values(customer(a, '1')).execute());
  await withTenant(db, b, (tx) => tx.insertInto('qbo_customers').values(customer(b, '1')).execute());
});
afterAll(async () => {
  await dropTenant(db, a);
  await dropTenant(db, b);
  await db.destroy();
});

describe('row-level security (app role)', () => {
  it('a tenant sees only its own rows, even with no WHERE clause', async () => {
    const rows = await withTenant(db, a, (tx) => tx.selectFrom('qbo_customers').select('tenant_id').execute());
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([a]));
  });

  it('with no tenant set, tenant tables return nothing', async () => {
    const rows = await db.selectFrom('qbo_customers').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('cannot write a row for another tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(db, a, (tx) => tx.insertInto('qbo_customers').values(customer(b, '999')).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant\'s rows', async () => {
    const upd = await withTenant(db, a, (tx) =>
      tx.updateTable('qbo_customers').set({ display_name: 'pwned' }).where('tenant_id', '=', b).executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const del = await withTenant(db, a, (tx) => tx.deleteFrom('qbo_customers').where('tenant_id', '=', b).executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(0);
  });

  it('tenant setting is transaction-local and does not leak to the next query on the pool', async () => {
    await withTenant(db, a, (tx) => tx.selectFrom('qbo_customers').selectAll().execute());
    const after = await db.selectFrom('qbo_customers').selectAll().execute();
    expect(after).toHaveLength(0);
  });

  it('system mode sees across tenants (explicit, reasoned exception)', async () => {
    const rows = await asSystem(db, 'test', (tx) =>
      tx.selectFrom('qbo_customers').select('tenant_id').where('tenant_id', 'in', [a, b]).execute(),
    );
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([a, b]));
  });

  it('rejects a non-UUID tenant id before touching the database', async () => {
    await expect(withTenant(db, "x' OR 1=1 --", async () => 1)).rejects.toThrow(/UUID/);
  });
});
