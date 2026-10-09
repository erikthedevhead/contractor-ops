-- 0005 — failed turns record an 'error' step, so causes are visible in the
-- database, not only in process logs.
ALTER TABLE agent_steps DROP CONSTRAINT agent_steps_kind_check;
ALTER TABLE agent_steps ADD CONSTRAINT agent_steps_kind_check CHECK (kind IN ('llm', 'tool', 'a2a', 'guard', 'error'));
