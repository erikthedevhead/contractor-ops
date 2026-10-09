-- 0007 — a pinned "today" for evaluation tenants.
-- Aging answers ("more than 60 days") depend on today's date, so eval ground
-- truth would drift daily. Eval tenants pin today to the seed anchor; for
-- every real tenant this is NULL and today is computed from the timezone.
ALTER TABLE tenants ADD COLUMN frozen_today date;
COMMENT ON COLUMN tenants.frozen_today IS 'Evaluation tenants only: overrides "today" for date-relative answers. NULL for real tenants.';
