-- 0006_a2a — task store for the Estimator's A2A server.
-- Rendered with `a2a-db upgrade --sql --dialect postgres --store tasks
-- --tasks-table-name a2a_tasks` from @a2a-js/sdk 1.3.0, then folded into our
-- migration runner so one tool owns the schema. The ledger insert keeps
-- `a2a-db status` truthful.
--
-- Tenant isolation: the SDK scopes every read and write by (tenant, owner),
-- and the server's UserBuilder sets owner = the caller's tenant id (from its
-- API key). The SDK does not set app.current_tenant, so this table relies on
-- that scoping rather than RLS. A test asserts tenant B cannot read tenant A's task.

create table if not exists "a2a_a2a_tasks_migrations" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null);

create table "a2a_tasks" (
  "tenant" varchar(255) collate "C" not null,
  "owner" varchar(255) collate "C" not null,
  "id" varchar(36) collate "C" not null,
  "context_id" varchar(36) collate "C" not null,
  "status_last_updated" bigint not null,
  "status_state" varchar(255) collate "C",
  "status" text,
  "artifacts" text,
  "history" text,
  "metadata" text,
  "protocol_version" varchar(255),
  constraint "a2a_tasks_pkey" primary key ("tenant", "owner", "id")
);
create index "a2a_tasks_scope_updated_idx" on "a2a_tasks" ("tenant", "owner", "status_last_updated", "id");
create index "a2a_tasks_scope_context_updated_idx" on "a2a_tasks" ("tenant", "owner", "context_id", "status_last_updated", "id");

insert into "a2a_a2a_tasks_migrations" ("name", "timestamp") values ('0001_create_tasks', '2026-10-09T00:00:00.000Z');
