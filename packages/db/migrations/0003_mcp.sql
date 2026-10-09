-- 0003_mcp — API-key resolution for the MCP server, tenant timezone.

-- Dates like "today" and "days past due" are the contractor's local dates, not UTC.
ALTER TABLE tenants ADD COLUMN timezone text NOT NULL DEFAULT 'America/Chicago';

-- API keys are looked up before a tenant is known, so they can't sit behind
-- tenant RLS. Instead the app role loses direct access entirely and can only
-- call this function, which returns the tenant for a (prefix, sha256) pair and
-- nothing else. Keys are created and revoked by the operator CLI as the owner.
CREATE FUNCTION resolve_api_key(p_prefix text, p_hash bytea)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, scopes text[])
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE api_keys k
     SET last_used_at = now()
   WHERE k.prefix = p_prefix
     AND k.key_hash = p_hash
     AND k.revoked_at IS NULL
  RETURNING k.id, k.tenant_id, k.scopes;
$$;

REVOKE ALL ON FUNCTION resolve_api_key(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text, bytea) TO contractor_ops_app;
REVOKE ALL ON api_keys FROM contractor_ops_app;
