// Regenerates packages/db/src/db-types.ts from the live schema (run after migrations).
import { execFileSync } from 'node:child_process';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
execFileSync(
  'pnpm',
  ['--filter', '@co/db', 'exec', 'kysely-codegen', '--dialect', 'postgres', '--url', url,
   '--out-file', 'src/db-types.ts', '--exclude-pattern', 'schema_migrations', '--date-parser', 'string'],
  { stdio: 'inherit' },
);
