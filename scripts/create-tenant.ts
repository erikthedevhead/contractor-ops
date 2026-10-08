// Usage:
//   pnpm tenant:create "Demo Remodeling Co"      -> new tenant + connect link
//   pnpm tenant:link <tenant-id>                  -> fresh connect link for an existing tenant
import { createDb } from '@co/db';
import { env } from '@co/shared';
import { signConnectLink } from '../apps/api/src/connect-link';

const e = env();
const db = createDb(e.DATABASE_URL, { max: 1 });
const [mode, arg] = process.argv.slice(2);

try {
  let tenantId: string;
  if (mode === '--link') {
    if (!arg) throw new Error('usage: pnpm tenant:link <tenant-id>');
    const t = await db.selectFrom('tenants').select(['id', 'name']).where('id', '=', arg).executeTakeFirst();
    if (!t) throw new Error(`tenant ${arg} not found`);
    tenantId = t.id;
    console.log(`Tenant: ${t.name}`);
  } else {
    const name = mode?.trim();
    if (!name) throw new Error('usage: pnpm tenant:create "<name>"');
    const t = await db.insertInto('tenants').values({ name }).returning(['id', 'name']).executeTakeFirstOrThrow();
    tenantId = t.id;
    console.log(`Created tenant: ${t.name}`);
  }
  console.log(`Tenant ID:      ${tenantId}`);
  console.log(`Connect link (valid 30 min):\n  ${e.PUBLIC_BASE_URL}/oauth/connect?t=${signConnectLink(e.CONNECT_LINK_SECRET, tenantId)}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
