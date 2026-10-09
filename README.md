# Contractor Ops Agent

An MCP server and agent system that lets a contractor ask questions and take
actions against their QuickBooks Online data. Portfolio project; full write-up,
architecture diagram and eval results land at the end of the week.

## Status

| Day | Scope | State |
|---|---|---|
| 1 | Scaffold, schema + RLS, QuickBooks OAuth + encrypted token storage, seeder, initial sync | done |
| 2 | Webhooks (CloudEvents), job queue, idempotency, retries, dead-letter, CDC reconciliation | done |
| 3 | MCP server (SDK v2), tenant-scoped API keys, two-step write | done |
| 4 | Office Manager agent loop, cost metering, spend caps | done |
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
- **Built against the real thing, not the docs.** The live sandbox sent Intuit's
  legacy payload format despite the documented retirement, and payments don't
  notify about the invoices they change. Both are handled; see D6 in
  `docs/decisions.md`. The first rejected delivery was recovered by replaying it
  from the stored raw body.
- **A nightly safety net.** CDC reconcile catches missed creates, updates and
  deletes; falls back to a paged query when an entity hits CDC's 1,000-object
  cap; schedules a full re-sync when the gap exceeds CDC's 30-day window.

## What Day 3 proves

- **MCP on the current spec.** TypeScript SDK v2, protocol 2026-07-28,
  stateless: one server instance per request, built for exactly one
  authenticated tenant. Six tools, five read-only, all answered from the
  Postgres mirror (zero QuickBooks calls, zero quota).
- **No tenant parameter exists.** The tenant comes from the API key; no tool
  schema mentions a tenant, so no argument (or prompt injection) can reach
  another tenant's data. RLS enforces it again underneath. Tested.
- **Keys handled like credentials.** 256-bit keys, stored as SHA-256 with a
  display prefix; the app role cannot read the keys table at all and resolves
  keys only through a `SECURITY DEFINER` function. Scopes: `read` and
  `write:estimate`.
- **A write that can't happen by accident or twice.** `create_estimate_draft`
  previews first and writes only with a single-use, tenant-bound, 15-minute
  confirmation token. The exact QuickBooks body is fixed and hash-checked at
  preview time; every retry reuses one `requestid`; a replayed token returns the
  original estimate. Tested through outages, lost responses and tampering.
- **Errors an agent can act on.** Every failure is `{code, message, retryable,
  hint}`; unexpected errors are logged server-side and surface only as
  `INTERNAL`.

## What Day 4 proves

- **A custom agent loop, fully inspectable.** No framework. Each turn is
  `route -> [model -> tools]* -> answer`; every model call, tool call and guard
  decision is a row in `agent_steps`, so any answer can be traced to the exact
  tool results it was built from.
- **MCP is the agent's only path to data.** The agent is an MCP client using the
  caller's API key, so it inherits the caller's tenant and scopes: a read-only
  key produces an agent that cannot write.
- **Model routing.** A Haiku 5.5 classification call (structured JSON output)
  picks the model per turn: Haiku 5.5 for lookups, Sonnet 5.5 for analysis and
  estimating. Routing fails closed: if the router errors, the turn runs as a
  plain lookup that can never unlock a write.
- **Per-tenant cost tracking and a hard cap.** Every call is priced from a
  `model_prices` table (input, output, cache read/write) and logged to
  `llm_calls`. Each call reserves its worst-case cost before running and settles
  afterwards, so concurrent requests can't overshoot the monthly cap (tested
  with 20 concurrent reservations against a cap that fits 5). `GET /agent/usage`
  shows the month's spend by model, runs, and QuickBooks calls.
- **The agent cannot write without the user's say-so.** Beyond the MCP server's
  two-step write, the runtime blocks any confirmation unless the token was shown
  to the user in an earlier turn and the current message is an explicit
  approval. A model that "helpfully" confirms its own draft is stopped and the
  attempt is recorded as a guard step. Tested across four turns.

## Operating it

```bash
pnpm dev                      # API + worker locally
pnpm reconcile <tenant-id>    # run CDC reconcile now
pnpm dlq list                 # dead-lettered jobs
pnpm dlq replay <id>          # requeue one
pnpm webhooks:reingest <id>   # replay a stored delivery through the current parser
bash infra/deploy.sh          # deploy to the droplet
pnpm dev:agent                # Office Manager on :3200 (needs pnpm dev running)
MCP_API_KEY=... pnpm chat     # talk to it
pnpm api-key create <tenant> [--write]   # MCP key (shown once)
MCP_API_KEY=... pnpm mcp:call get_ar_aging '{"overdue_more_than_days":60}'
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
apps/mcp            MCP server: tools, API-key auth, guarded estimate write
apps/core           co-core process: API + worker + MCP
apps/office-manager co-office-manager process: /chat and /usage
packages/agent      agent loop, router, pricing, spend cap, MCP toolbox
infra/              PM2 file, nginx site, deploy script
packages/shared     env validation, logger, error taxonomy, uuidv5
packages/crypto     AES-256-GCM key ring
packages/db         SQL migrations, runner, Kysely client, withTenant/asSystem
packages/qbo        OAuth, TokenStore, QboClient (retry/meter), mirror upserts, sync
scripts/            keygen, tenant:create/link, seed:sandbox, sync:initial
docs/decisions.md   why things are the way they are
```
