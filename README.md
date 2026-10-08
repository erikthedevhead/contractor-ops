# Contractor Ops Agent

An MCP server and agent system that lets a contractor ask questions and take
actions against their QuickBooks Online data. Portfolio project; full write-up,
architecture diagram and eval results land at the end of the week.

## Status

| Day | Scope | State |
|---|---|---|
| 1 | Scaffold, schema + RLS, QuickBooks OAuth + encrypted token storage, seeder, initial sync | done |
| 2 | Webhooks (CloudEvents), job queue, idempotency, retries, dead-letter, CDC reconciliation | |
| 3 | MCP server (SDK v2), tenant-scoped API keys, two-step write | |
| 4 | Office Manager agent loop, cost metering, spend caps | |
| 5 | Estimator agent over A2A | |
| 6 | Evals + fault injection | |
| 7 | Deploy, docs, demo | |

## What Day 1 proves

- **OAuth done properly.** Signed, expiring connect links; single-use OAuth
  state; tokens encrypted at rest with AES-256-GCM, key versioning, and AAD that
  binds each ciphertext to its tenant, realm and column.
- **Refresh-token rotation without races.** Refresh happens under a row lock;
  N concurrent callers produce exactly one refresh. `invalid_grant` flips the
  connection to `needs_reauth` and stops hammering Intuit; transient failures
  leave tokens untouched. (Tested.)
- **Tenant isolation in the database.** RLS with `FORCE`, a non-owner app role,
  transaction-local tenant context. Tests prove cross-tenant reads, writes,
  updates and deletes all fail.
- **Retries that can't create duplicates.** Full-jitter backoff on 429/5xx/network,
  `Retry-After` honored, one token refresh on 401, and every POST must carry a
  `requestid` that is reused across retries.
- **Order-independent sync.** Mirror upserts only apply a higher `SyncToken`, so
  duplicate and out-of-order updates are no-ops.
- **Integration cost visibility.** Every QuickBooks call attempt is metered per
  tenant, flagged when it counts toward Intuit's CorePlus quota.

## Local setup

Requirements: Node 22+, pnpm 9, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env            # then fill in values (see below)
cp .env.test.example .env.test  # local test database credentials
pnpm keygen                     # paste output into .env
pnpm db:migrate
pnpm test
```

## Repo layout

```
apps/api            OAuth connect/callback, health (Day 2: webhooks)
packages/shared     env validation, logger, error taxonomy, uuidv5
packages/crypto     AES-256-GCM key ring
packages/db         SQL migrations, runner, Kysely client, withTenant/asSystem
packages/qbo        OAuth, TokenStore, QboClient (retry/meter), mirror upserts, sync
scripts/            keygen, tenant:create/link, seed:sandbox, sync:initial
docs/decisions.md   why things are the way they are
```
