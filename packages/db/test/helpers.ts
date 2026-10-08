import { createDb, type Db } from '../src/client';

export function testDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set (copy .env.test)');
  return createDb(url, { max: 5 });
}

/** tenants has no RLS: creating one is the only unscoped write. */
export async function makeTenant(db: Db, name = 'test'): Promise<string> {
  const row = await db.insertInto('tenants').values({ name: `${name}-${Date.now()}` }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

export async function dropTenant(db: Db, id: string) {
  await db.deleteFrom('tenants').where('id', '=', id).execute();
}
