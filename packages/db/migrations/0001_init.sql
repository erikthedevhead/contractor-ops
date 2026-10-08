-- 0001_init — Contractor Ops Agent base schema.
-- Runs as contractor_ops_owner. Default privileges (set when the database was
-- created) grant DML on every table here to contractor_ops_app.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy match: find_customer, similar jobs

CREATE TYPE qbo_env              AS ENUM ('sandbox', 'production');
CREATE TYPE connection_status    AS ENUM ('active', 'needs_reauth', 'revoked');
CREATE TYPE webhook_event_status AS ENUM ('received', 'processing', 'processed', 'ignored', 'failed');
CREATE TYPE pending_write_status AS ENUM ('pending', 'executing', 'committed', 'failed', 'expired', 'cancelled');
CREATE TYPE agent_name           AS ENUM ('office_manager', 'estimator');

-- ---------------------------------------------------------------------------
-- Tenancy & auth
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  monthly_spend_cap_usd  numeric(10,2) NOT NULL DEFAULT 25.00,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Looked up before the tenant is known, so not under RLS. Day 3 moves access
-- behind a SECURITY DEFINER resolver and revokes direct SELECT from the app role.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prefix        text NOT NULL UNIQUE,
  key_hash      bytea NOT NULL,
  label         text,
  scopes        text[] NOT NULL DEFAULT '{read}',
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- QuickBooks OAuth
-- ---------------------------------------------------------------------------
CREATE TABLE oauth_states (
  state        text PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

CREATE TABLE qbo_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  environment         qbo_env NOT NULL,
  realm_id            text NOT NULL,
  status              connection_status NOT NULL DEFAULT 'active',
  access_token_enc    bytea NOT NULL,     -- [ver][iv][ct][tag], AES-256-GCM, AAD-bound
  refresh_token_enc   bytea NOT NULL,
  enc_key_version     smallint NOT NULL,
  access_expires_at   timestamptz NOT NULL,
  refresh_expires_at  timestamptz,
  token_version       integer NOT NULL DEFAULT 0,
  last_refreshed_at   timestamptz,
  last_error          text,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, realm_id)
);

-- ---------------------------------------------------------------------------
-- Webhook ingestion (used from Day 2)
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id               bigserial PRIMARY KEY,
  received_at      timestamptz NOT NULL DEFAULT now(),
  signature        text,
  signature_valid  boolean NOT NULL,
  raw_body         text NOT NULL,
  event_count      integer
);

CREATE TABLE webhook_events (
  id            bigserial PRIMARY KEY,
  delivery_id   bigint NOT NULL REFERENCES webhook_deliveries(id),
  event_id      text NOT NULL UNIQUE,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  realm_id      text NOT NULL,
  event_type    text NOT NULL,
  entity_name   text NOT NULL,
  operation     text NOT NULL,
  entity_id     text NOT NULL,
  event_time    timestamptz NOT NULL,
  data          jsonb,
  status        webhook_event_status NOT NULL DEFAULT 'received',
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  processed_at  timestamptz
);
CREATE INDEX webhook_events_entity_idx ON webhook_events (tenant_id, entity_name, entity_id, event_time DESC);
CREATE INDEX webhook_events_pending_idx ON webhook_events (status) WHERE status IN ('received', 'failed');

CREATE TABLE sync_cursors (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_name        text NOT NULL,
  last_full_sync_at  timestamptz,
  last_event_time    timestamptz,
  cdc_through        timestamptz,
  PRIMARY KEY (tenant_id, entity_name)
);

CREATE TABLE dead_letters (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
  queue       text NOT NULL,
  job_id      text NOT NULL,
  payload     jsonb NOT NULL,
  error       jsonb NOT NULL,
  attempts    integer NOT NULL,
  failed_at   timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  UNIQUE (queue, job_id)
);

-- ---------------------------------------------------------------------------
-- Mirror tables. All writes go through guarded upserts:
--   ON CONFLICT (...) DO UPDATE ... WHERE existing.sync_token < EXCLUDED.sync_token
-- ---------------------------------------------------------------------------
CREATE TABLE qbo_customers (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qbo_id          text NOT NULL,
  sync_token      integer NOT NULL,
  qbo_updated_at  timestamptz NOT NULL,
  is_deleted      boolean NOT NULL DEFAULT false,
  merged_into_id  text,
  display_name    text NOT NULL,
  company_name    text,
  email           text,
  phone           text,
  balance         numeric(14,2),
  active          boolean NOT NULL DEFAULT true,
  raw             jsonb NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, qbo_id)
);
CREATE INDEX qbo_customers_name_trgm ON qbo_customers USING gin (display_name gin_trgm_ops);

CREATE TABLE qbo_items (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qbo_id          text NOT NULL,
  sync_token      integer NOT NULL,
  qbo_updated_at  timestamptz NOT NULL,
  is_deleted      boolean NOT NULL DEFAULT false,
  name            text NOT NULL,
  item_type       text NOT NULL,
  unit_price      numeric(14,4),
  purchase_cost   numeric(14,4),
  active          boolean NOT NULL DEFAULT true,
  raw             jsonb NOT NULL,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, qbo_id)
);

CREATE TABLE qbo_invoices (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qbo_id             text NOT NULL,
  sync_token         integer NOT NULL,
  qbo_updated_at     timestamptz NOT NULL,
  is_deleted         boolean NOT NULL DEFAULT false,
  is_voided          boolean NOT NULL DEFAULT false,
  customer_qbo_id    text NOT NULL,
  doc_number         text,
  txn_date           date NOT NULL,
  due_date           date,
  total_amt          numeric(14,2) NOT NULL,
  balance            numeric(14,2) NOT NULL,
  linked_estimate_id text,
  private_note       text,
  customer_memo      text,
  raw                jsonb NOT NULL,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, qbo_id)
);
CREATE INDEX qbo_invoices_open_idx ON qbo_invoices (tenant_id, due_date)
  WHERE balance > 0 AND NOT is_deleted AND NOT is_voided;
CREATE INDEX qbo_invoices_customer_idx ON qbo_invoices (tenant_id, customer_qbo_id, txn_date DESC);

CREATE TABLE qbo_estimates (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qbo_id            text NOT NULL,
  sync_token        integer NOT NULL,
  qbo_updated_at    timestamptz NOT NULL,
  is_deleted        boolean NOT NULL DEFAULT false,
  customer_qbo_id   text NOT NULL,
  doc_number        text,
  txn_date          date NOT NULL,
  expiration_date   date,
  txn_status        text,
  total_amt         numeric(14,2) NOT NULL,
  private_note      text,
  customer_memo     text,
  created_by_agent  boolean NOT NULL DEFAULT false,
  raw               jsonb NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, qbo_id)
);
CREATE INDEX qbo_estimates_open_idx ON qbo_estimates (tenant_id, txn_date DESC)
  WHERE txn_status = 'Pending' AND NOT is_deleted;

CREATE TABLE qbo_txn_lines (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  txn_type      text NOT NULL CHECK (txn_type IN ('Invoice', 'Estimate')),
  txn_qbo_id    text NOT NULL,
  line_id       text NOT NULL,
  line_num      integer,
  item_qbo_id   text,
  description   text,
  qty           numeric(14,4),
  unit_price    numeric(14,4),
  amount        numeric(14,2) NOT NULL,
  PRIMARY KEY (tenant_id, txn_type, txn_qbo_id, line_id)
);
CREATE INDEX qbo_txn_lines_item_idx ON qbo_txn_lines (tenant_id, item_qbo_id);
CREATE INDEX qbo_txn_lines_desc_trgm ON qbo_txn_lines USING gin (description gin_trgm_ops);

CREATE TABLE qbo_payments (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  qbo_id           text NOT NULL,
  sync_token       integer NOT NULL,
  qbo_updated_at   timestamptz NOT NULL,
  is_deleted       boolean NOT NULL DEFAULT false,
  customer_qbo_id  text NOT NULL,
  txn_date         date NOT NULL,
  total_amt        numeric(14,2) NOT NULL,
  unapplied_amt    numeric(14,2),
  raw              jsonb NOT NULL,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, qbo_id)
);

CREATE TABLE qbo_payment_applications (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_qbo_id   text NOT NULL,
  invoice_qbo_id   text NOT NULL,
  amount           numeric(14,2) NOT NULL,
  PRIMARY KEY (tenant_id, payment_qbo_id, invoice_qbo_id)
);

-- Seeder bookkeeping: seed_key -> created QuickBooks object.
CREATE TABLE seed_ledger (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seed_key        text NOT NULL,
  entity_name     text NOT NULL,
  qbo_id          text NOT NULL,
  qbo_request_id  uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seed_key)
);

-- ---------------------------------------------------------------------------
-- Guarded writes (Day 3)
-- ---------------------------------------------------------------------------
CREATE TABLE pending_writes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id        uuid REFERENCES api_keys(id),
  agent_run_id      uuid,
  tool_name         text NOT NULL,
  payload           jsonb NOT NULL,
  payload_sha256    bytea NOT NULL,
  preview           jsonb NOT NULL,
  qbo_request_id    uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status            pending_write_status NOT NULL DEFAULT 'pending',
  expires_at        timestamptz NOT NULL,
  confirmed_at      timestamptz,
  committed_qbo_id  text,
  committed_at      timestamptz,
  error             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Metering
-- ---------------------------------------------------------------------------
CREATE TABLE qbo_api_calls (
  id                      bigserial PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  method                  text NOT NULL,
  endpoint                text NOT NULL,
  entity_name             text,
  status_code             integer,
  attempt                 smallint NOT NULL DEFAULT 1,
  latency_ms              integer NOT NULL,
  counts_toward_coreplus  boolean NOT NULL,
  intuit_tid              text,
  qbo_request_id          uuid,
  job_id                  text,
  agent_run_id            uuid,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX qbo_api_calls_tenant_month_idx ON qbo_api_calls (tenant_id, created_at);

CREATE TABLE model_prices (
  model                      text NOT NULL,
  effective_from             date NOT NULL,
  input_usd_per_mtok         numeric(10,4) NOT NULL,
  output_usd_per_mtok        numeric(10,4) NOT NULL,
  cache_read_usd_per_mtok    numeric(10,4),
  cache_write_usd_per_mtok   numeric(10,4),
  PRIMARY KEY (model, effective_from)
);

CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent           agent_name NOT NULL,
  parent_run_id   uuid REFERENCES agent_runs(id),
  a2a_task_id     text,
  eval_case_id    text,
  user_input      text NOT NULL,
  final_output    text,
  status          text NOT NULL DEFAULT 'running',
  total_cost_usd  numeric(12,6) NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE TABLE agent_steps (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_no      integer NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('llm', 'tool', 'a2a', 'guard')),
  name         text,
  input        jsonb,
  output       jsonb,
  error        jsonb,
  latency_ms   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_no)
);

CREATE TABLE llm_calls (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id              uuid REFERENCES agent_runs(id),
  step_no             integer,
  agent               agent_name NOT NULL,
  model               text NOT NULL,
  purpose             text NOT NULL,
  input_tokens        integer NOT NULL,
  output_tokens       integer NOT NULL,
  cache_read_tokens   integer NOT NULL DEFAULT 0,
  cache_write_tokens  integer NOT NULL DEFAULT 0,
  cost_usd            numeric(12,6) NOT NULL,
  latency_ms          integer NOT NULL,
  stop_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_tenant_month_idx ON llm_calls (tenant_id, created_at);

CREATE TABLE tenant_spend (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month         date NOT NULL,
  spent_usd     numeric(12,6) NOT NULL DEFAULT 0,
  reserved_usd  numeric(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);

-- ---------------------------------------------------------------------------
-- Evals (dev tooling; dedicated eval tenant; no RLS)
-- ---------------------------------------------------------------------------
CREATE TABLE eval_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  git_sha     text NOT NULL,
  config      jsonb NOT NULL,
  summary     jsonb,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE eval_results (
  run_id        uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id       text NOT NULL,
  iteration     smallint NOT NULL,
  category      text NOT NULL,
  passed        boolean NOT NULL,
  score         numeric(6,4),
  failure_mode  text,
  expected      jsonb NOT NULL,
  actual        jsonb,
  tool_calls    jsonb,
  cost_usd      numeric(12,6),
  latency_ms    integer,
  agent_run_id  uuid,
  PRIMARY KEY (run_id, case_id, iteration)
);

-- ---------------------------------------------------------------------------
-- Row-level security. App connects as a non-owner role; FORCE applies the
-- policy to the owner too. Tenant path: set_config('app.current_tenant', id, true)
-- System path (webhook routing, schedulers): set_config('app.system_mode', 'on', true)
-- Both are transaction-local (third arg = true), so nothing leaks across a pooled connection.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'oauth_states', 'qbo_connections', 'webhook_events', 'sync_cursors', 'dead_letters',
    'qbo_customers', 'qbo_items', 'qbo_invoices', 'qbo_estimates', 'qbo_txn_lines',
    'qbo_payments', 'qbo_payment_applications', 'seed_ledger', 'pending_writes', 'qbo_api_calls',
    'agent_runs', 'agent_steps', 'llm_calls', 'tenant_spend'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
      USING (
        current_setting('app.system_mode', true) = 'on'
        OR tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid
      )
      WITH CHECK (
        current_setting('app.system_mode', true) = 'on'
        OR tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid
      )$p$, t);
  END LOOP;
END $$;
