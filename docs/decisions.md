# Design decisions

Short records of choices that a reviewer might question. Newest first.

## D5. Job queue: a Postgres table, not pg-boss
**Day 2.** pg-boss creates queue partitions at runtime, which needs DDL rights
and would force the app onto the schema-owner role, undoing the point of RLS
with a non-owner role. The queue here is one table plus ~150 lines:
`FOR UPDATE SKIP LOCKED` claims inside a `MATERIALIZED` CTE, singleton keys for
dedupe, jittered backoff, dead-lettering, replay and stale-lock reaping. Every
state is visible with a SELECT, which matters when debugging an integration.
The webhook endpoint enqueues in the same transaction that records the event,
so there is never an event without a job or a job without an event.

## D4. Data layer: plain SQL migrations + Kysely (not Prisma)
**Day 1.** Every interesting database behavior in this project is raw SQL:
row-level security policies, guarded upserts (`ON CONFLICT ... DO UPDATE ... WHERE
sync_token < EXCLUDED.sync_token`), partial and trigram indexes, the
reserve-then-settle spend cap, and `SELECT ... FOR UPDATE` around token refresh.
An ORM would be bypassed for all of it. Kysely keeps those queries typed
(types are generated from the live schema with `pnpm db:types`) without hiding
SQL, and it is also what `@a2a-js/sdk`'s Postgres task store uses, so the
project has one query layer instead of two. Migrations are numbered `.sql`
files applied by a 60-line runner with checksums and an advisory lock.

## D3. Seed data: custom remodel catalog layered over the sandbox sample company
Deterministic (fixed PRNG seed + stored anchor date), idempotent (ledger +
deterministic QuickBooks `requestid`), with planted edge cases the evals depend
on (60 vs 61 days past due, partial payment, similar customer names, a customer
with no history, expired and rejected estimates).

## D2. Multi-tenancy enforced by Postgres RLS, not application WHERE clauses
The app connects as a non-owner role. Every tenant table has `FORCE ROW LEVEL
SECURITY` and a policy on `app.current_tenant`, set transaction-locally by
`withTenant()`. Cross-tenant access exists only through `asSystem(reason)`,
which is greppable and used in exactly the places that must route before a
tenant is known (OAuth state lookup, webhook realm routing).

## D1. Protocol versions
MCP spec 2026-07-28 with TypeScript SDK v2 (v1.x is in maintenance). A2A spec
v1.0 with `@a2a-js/sdk` 1.x. QuickBooks webhooks in CloudEvents format
(legacy format retired July 31, 2026). QuickBooks `minorversion=75` pinned.
