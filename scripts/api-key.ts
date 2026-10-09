// Operator CLI for MCP API keys. Runs as the schema owner (the app role can't read api_keys).
//   pnpm api-key create <tenant-id> [--write] [--label "office manager agent"]
//   pnpm api-key list <tenant-id>
//   pnpm api-key revoke <prefix>
import { createDb } from '@co/db';
import { createApiKey, revokeApiKey, type Scope } from '@co/mcp';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
const db = createDb(url, { max: 1 });
const [cmd, arg, ...rest] = process.argv.slice(2);

try {
  if (cmd === 'create' && arg) {
    const scopes: Scope[] = rest.includes('--write') ? ['read', 'write:estimate'] : ['read'];
    const label = rest.includes('--label') ? rest[rest.indexOf('--label') + 1] : undefined;
    const { key, prefix } = await createApiKey(db, arg, scopes, label);
    console.log(`Created key ${prefix} for tenant ${arg} with scopes [${scopes.join(', ')}]`);
    console.log('Store it now; it is not shown again:\n');
    console.log(`  ${key}\n`);
  } else if (cmd === 'list' && arg) {
    const rows = await db.selectFrom('api_keys').select(['prefix', 'label', 'scopes', 'created_at', 'last_used_at', 'revoked_at'])
      .where('tenant_id', '=', arg).orderBy('created_at').execute();
    console.table(rows.map((r) => ({ ...r, scopes: r.scopes.join(' ') })));
  } else if (cmd === 'revoke' && arg) {
    console.log((await revokeApiKey(db, arg)) ? `Revoked ${arg}` : `No active key ${arg}`);
  } else {
    console.error('usage: pnpm api-key create <tenant-id> [--write] [--label <text>] | list <tenant-id> | revoke <prefix>');
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
