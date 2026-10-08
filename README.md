# Contractor Ops Agent

An MCP server and agent system that lets a contractor ask questions and take
actions against their QuickBooks Online data. Portfolio project; full write-up,
architecture diagram and eval results land at the end of the week.

## Status

| Day | Scope | State |
|---|---|---|
| 1 | Scaffold, schema + RLS, QuickBooks OAuth + encrypted token storage, seeder, initial sync | done |
| 2 | Webhooks (CloudEvents), job queue, idempotency, retries, dead-letter, CDC reconciliation | done |
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

## What Day 2 proves

- **Webhooks that can't lose or double-apply events.** Signature verified over
  raw bytes; raw delivery persisted first; each event deduped on its CloudEvents
  id and its processing job enqueued in the same transaction; 200 returned
  without touching QuickBooks. Duplicate, out-of-order and late events all
  converge on the same row. (Tested end to end over HTTP.)
- **A job queue with real failure semantics.** `FOR UPDATE SKIP LOCKED` claims,
  exponential backoff with jitter, dead-letter after max attempts or on
  non-retryable errors, replay from the CLI, and recovery of jobs abandoned by
  a crashed worker. The tests caught a real Postgres gotcha along the way
  (an un-materialized `IN (SELECT ... LIMIT n)` can lock more than n rows).
- **A nightly safety net.** CDC reconcile catches missed creates, updates and
  deletes; falls back to a paged query when an entity hits CDC's 1,000-object
  cap; schedules a full re-sync when the gap exceeds CDC's 30-day window.

## Operating it

```bash
pnpm dev                      # API + worker locally
pnpm reconcile <tenant-id>    # run CDC reconcile now
pnpm dlq list                 # dead-lettered jobs
pnpm dlq replay <id>          # requeue one
bash infra/deploy.sh          # deploy to the droplet
```

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
apps/api            OAuth connect/callback, webhook ingestion
apps/worker         job runner, handlers, nightly reconcile scheduler
apps/core           co-core process: API + worker
infra/              PM2 file, nginx site, deploy script
packages/shared     env validation, logger, error taxonomy, uuidv5
packages/crypto     AES-256-GCM key ring
packages/db         SQL migrations, runner, Kysely client, withTenant/asSystem
packages/qbo        OAuth, TokenStore, QboClient (retry/meter), mirror upserts, sync
scripts/            keygen, tenant:create/link, seed:sandbox, sync:initial
docs/decisions.md   why things are the way they are
```
