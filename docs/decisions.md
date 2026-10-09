# Design decisions

Short records of choices that a reviewer might question. Newest first.

## D9. The Estimator is read-only and grounded by code, not by prompt
**Day 5.** An estimating agent that invents a line item or a price produces a
plausible, wrong number that a contractor might send to a customer. So the
guarantees are structural: the Estimator's tool list contains only
`find_customer` and `get_customer_job_history` plus a local `submit_estimate`;
its submission is checked against the set of jobs, items and prices it actually
retrieved in that run; arithmetic is done in code. Writing stays with the
Office Manager behind the two-gate write guard (D8).

Also found while testing: tool results over the size cap were cut mid-string,
handing the model invalid JSON. Oversized results are now wrapped as valid
JSON marked `result_truncated`, and long line descriptions are shortened in
job history so 20 comparable jobs fit.

## D8. Write guard in the agent runtime, not only in the tool
**Day 4.** The MCP server already refuses to write without a preview and a
token. But the server cannot know whether a *human* saw the preview: a model
could request a preview and confirm it in the same turn. So the agent runtime
adds a second gate: a confirmation is forwarded only if (a) its token was
issued in an earlier turn of this conversation, i.e. the user has seen it, and
(b) the router classified the user's current message as an explicit approval.
Otherwise the call never reaches MCP, the model gets a CONFIRMATION_REQUIRED
error, and a `guard` step is recorded. Both gates fail closed.

Model choice: the docs as of October 2026 list Claude Haiku 5.5 at $0.10/$0.50
per MTok, about 10x cheaper than Haiku 4.5, so the plan's "small model" became
Haiku 5.5. Prices live in `model_prices`, not code.

## D7. MCP auth: per-tenant API keys, not MCP OAuth
**Day 3.** The MCP spec's authorization model is OAuth 2.1 with protected
resource metadata. That is the right answer for third-party clients (Claude
Desktop, IDEs) connecting on a user's behalf. Here the only clients are this
system's own agents, server-to-server, so a scoped API key per tenant is the
proportionate choice. The tenant is derived from the key, never from tool
arguments. Moving to OAuth means replacing one Express middleware
(`requireBearerAuth` from `@modelcontextprotocol/express` with a token
verifier); the per-request server factory already takes the principal from
`authInfo`. Listed under "Production vs. prototype".

## D6. Accept both Intuit webhook formats
**Day 2, found in the live sandbox.** Intuit's docs say the legacy webhook
format was retired in July 2026, but a new app's "CloudEvents payload" setting
still defaults to disabled, and the sandbox sent the legacy shape. The endpoint
detects and parses either. Legacy events have no id, so one is derived from
(realm, entity, id, operation, lastUpdated); redeliveries dedupe the same way
CloudEvents retries do. The first live delivery was rejected by the original
CloudEvents-only parser; because raw deliveries are persisted before parsing,
it was recovered afterwards with `pnpm webhooks:reingest`.

Also found live: receiving a payment notifies only about the Payment, never
the Invoice whose balance it changed. The processor now refreshes every
invoice a payment applies to (before and after the change).

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
