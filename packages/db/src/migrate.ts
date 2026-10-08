/**
 * Minimal, inspectable migration runner.
 * - Applies migrations/NNNN_*.sql in order, each in its own transaction.
 * - Records a SHA-256 of each applied file; editing an applied migration is
 *   an error instead of silent drift.
 * - Holds a Postgres advisory lock so two deploys can't migrate concurrently.
 * Runs as the schema owner (MIGRATION_DATABASE_URL).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const LOCK_KEY = 74_201_001; // arbitrary, project-specific

export async function migrate(connectionString: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Applied migration ${file} was modified (checksum mismatch). Add a new migration instead.`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (applied.length === 0) log('database is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

// CLI entry: `pnpm db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url).then(
    () => process.exit(0),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
