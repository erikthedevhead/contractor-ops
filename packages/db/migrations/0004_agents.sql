-- 0004_agents — conversations, model prices, run bookkeeping.

-- A conversation is the agent's task-scoped memory: the message history and
-- the confirmation tokens it has shown the user. Nothing persists beyond it.
CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent          agent_name NOT NULL,
  messages       jsonb NOT NULL DEFAULT '[]',   -- Anthropic MessageParam[]
  issued_tokens  jsonb NOT NULL DEFAULT '[]',   -- [{token, run_id, issued_at}] previews shown to the user
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_tenant_idx ON conversations (tenant_id, updated_at DESC);

ALTER TABLE agent_runs ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN intent text;
ALTER TABLE agent_runs ADD COLUMN model text;

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (current_setting('app.system_mode', true) = 'on'
         OR tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (current_setting('app.system_mode', true) = 'on'
         OR tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid);

-- List prices, USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-09).
-- Haiku 5.5 doubles in price for prompts over 100K tokens; this app's prompts
-- are capped far below that (see agent context limits), so one row suffices.
INSERT INTO model_prices (model, effective_from, input_usd_per_mtok, output_usd_per_mtok, cache_read_usd_per_mtok, cache_write_usd_per_mtok) VALUES
  ('claude-haiku-5-5',  '2026-01-01', 0.10, 0.50, 0.01, 0.125),
  ('claude-sonnet-5-5', '2026-01-01', 2.00, 10.00, 0.10, 2.50),
  ('claude-haiku-4-5',  '2025-10-01', 1.00, 5.00, 0.10, 1.25);
