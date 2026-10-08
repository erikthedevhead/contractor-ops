import { defineConfig } from 'vitest/config';

// DB tests read .env.test (local Postgres with the same two roles as prod).
try {
  process.loadEnvFile('.env.test');
} catch {
  /* CI may provide env directly */
}
process.env.LOG_LEVEL ??= 'silent';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.unit.test.ts', 'apps/*/test/**/*.unit.test.ts', 'scripts/test/**/*.unit.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['packages/*/test/**/*.db.test.ts', 'apps/*/test/**/*.db.test.ts', 'scripts/test/**/*.db.test.ts'],
          fileParallelism: false, // one shared database
        },
      },
    ],
  },
});
