import { sql } from 'kysely';
import { withTenant, type Db } from '@co/db';

/** Per-tenant usage for the current month: what this customer costs us. */
export async function usageReport(db: Db, tenantId: string, now = new Date()) {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  return withTenant(db, tenantId, async (tx) => {
    const cap = await sql<{ cap: string; spent: string | null; reserved: string | null }>`
      SELECT t.monthly_spend_cap_usd::text AS cap, s.spent_usd::text AS spent, s.reserved_usd::text AS reserved
        FROM tenants t LEFT JOIN tenant_spend s ON s.tenant_id = t.id AND s.month = ${month}::date
       WHERE t.id = ${tenantId}`.execute(tx);
    const byModel = await sql<{ model: string; purpose: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: string; avg_latency_ms: number }>`
      SELECT model, purpose, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
             sum(cache_read_tokens)::int AS cache_read_tokens, sum(cost_usd)::numeric(12,6)::text AS cost_usd, avg(latency_ms)::int AS avg_latency_ms
        FROM llm_calls WHERE tenant_id = ${tenantId} AND created_at >= ${month}::date
       GROUP BY model, purpose ORDER BY sum(cost_usd) DESC`.execute(tx);
    const runs = await sql<{ status: string; runs: number; cost_usd: string; avg_cost_usd: string }>`
      SELECT status, count(*)::int AS runs, sum(total_cost_usd)::numeric(12,6)::text AS cost_usd, avg(total_cost_usd)::numeric(12,6)::text AS avg_cost_usd
        FROM agent_runs WHERE tenant_id = ${tenantId} AND started_at >= ${month}::date GROUP BY status`.execute(tx);
    const qbo = await sql<{ calls: number; coreplus: number; errors: number }>`
      SELECT count(*)::int AS calls, count(*) FILTER (WHERE counts_toward_coreplus)::int AS coreplus,
             count(*) FILTER (WHERE status_code IS NULL OR status_code >= 400)::int AS errors
        FROM qbo_api_calls WHERE tenant_id = ${tenantId} AND created_at >= ${month}::date`.execute(tx);
    const c = cap.rows[0];
    return {
      month: month.slice(0, 7),
      spend: { cap_usd: c?.cap ?? null, spent_usd: c?.spent ?? '0', reserved_usd: c?.reserved ?? '0' },
      llm: byModel.rows,
      agent_runs: runs.rows,
      quickbooks_api: qbo.rows[0],
    };
  });
}
