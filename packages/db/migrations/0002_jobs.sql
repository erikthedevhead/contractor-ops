-- 0002_jobs — Postgres-backed job queue (FOR UPDATE SKIP LOCKED).
-- Chosen over pg-boss: pg-boss needs DDL rights at runtime (it creates queue
-- partitions), which would force the app onto the owner role and weaken the
-- RLS story. This table is ~1 screen of SQL and every state is inspectable.

CREATE TYPE job_status AS ENUM ('queued', 'running', 'completed', 'failed', 'dead');

CREATE TABLE jobs (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenants(id) ON DELETE CASCADE,
  queue          text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}',
  status         job_status NOT NULL DEFAULT 'queued',
  singleton_key  text,                      -- dedupe: one job per key per queue, ever
  attempts       integer NOT NULL DEFAULT 0,
  max_attempts   integer NOT NULL DEFAULT 6,
  run_at         timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  locked_by      text,
  last_error     jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE UNIQUE INDEX jobs_singleton_idx ON jobs (queue, singleton_key) WHERE singleton_key IS NOT NULL;
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status IN ('queued', 'failed');
CREATE INDEX jobs_running_idx ON jobs (locked_at) WHERE status = 'running';

ALTER TABLE dead_letters ADD COLUMN source_job_id bigint REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs
  USING (current_setting('app.system_mode', true) = 'on'
         OR tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (current_setting('app.system_mode', true) = 'on'
         OR tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);
