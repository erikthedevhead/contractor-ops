import { sql } from 'kysely';
import type { Tx } from '@co/db';
import { ToolError } from '../errors';

/**
 * Read tools. All of them:
 * - run inside withTenant(), so RLS limits every row to the caller's tenant
 *   (the explicit tenant_id predicates are for index use, not security)
 * - read only the local mirror: zero QuickBooks API calls, zero CorePlus quota
 * - return money as strings with 2 decimals (never floats) and dates as YYYY-MM-DD
 */

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** "Today" in the contractor's timezone; aging and expiry depend on it. */
export async function tenantToday(tx: Tx, tenantId: string): Promise<string> {
  const r = await sql<{ d: string }>`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM tenants WHERE id = ${tenantId}`.execute(tx);
  return r.rows[0]?.d ?? new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// find_customer
// ---------------------------------------------------------------------------
export interface CustomerMatch {
  customer_id: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  open_balance: string;
  last_activity_date: string | null;
  match_score: number;
}

export async function findCustomer(tx: Tx, tenantId: string, args: { query: string; limit?: number }) {
  const q = args.query.trim();
  if (q.length < 2) throw new ToolError('INVALID_ARGUMENT', 'query must be at least 2 characters');
  const like = `%${likeEscape(q)}%`;
  const limit = Math.min(args.limit ?? 5, 20);
  const r = await sql<CustomerMatch & { match_score: string }>`
    SELECT c.qbo_id AS customer_id, c.display_name, c.company_name, c.email, c.phone,
           coalesce((SELECT sum(i.balance) FROM qbo_invoices i
                      WHERE i.tenant_id = c.tenant_id AND i.customer_qbo_id = c.qbo_id
                        AND NOT i.is_deleted AND NOT i.is_voided AND i.balance > 0), 0)::numeric(14,2)::text AS open_balance,
           (SELECT max(d)::text FROM (
              SELECT txn_date AS d FROM qbo_invoices  WHERE tenant_id = c.tenant_id AND customer_qbo_id = c.qbo_id AND NOT is_deleted
              UNION ALL
              SELECT txn_date FROM qbo_estimates WHERE tenant_id = c.tenant_id AND customer_qbo_id = c.qbo_id AND NOT is_deleted) x) AS last_activity_date,
           round(greatest(similarity(c.display_name, ${q}),
                          word_similarity(${q}, c.display_name),
                          coalesce(word_similarity(${q}, c.company_name), 0))::numeric, 3)::text AS match_score
      FROM qbo_customers c
     WHERE c.tenant_id = ${tenantId} AND NOT c.is_deleted
       AND (c.display_name ILIKE ${like} OR c.company_name ILIKE ${like}
            OR word_similarity(${q}, c.display_name) > 0.45 OR similarity(c.display_name, ${q}) > 0.3)
     ORDER BY match_score DESC, c.display_name
     LIMIT ${limit}`.execute(tx);
  const matches = r.rows.map((m) => ({ ...m, match_score: Number(m.match_score) }));
  const ambiguous = matches.length > 1 && matches[1]!.match_score >= matches[0]!.match_score * 0.8;
  return {
    query: q,
    matches,
    ambiguous,
    note: matches.length === 0
      ? 'No customer matches. Do not guess; ask the user for the exact name.'
      : ambiguous
        ? 'Several customers match about equally well. Confirm which one with the user before acting on it.'
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// get_ar_aging
// ---------------------------------------------------------------------------
const BUCKETS = ['current', '1_30', '31_60', '61_90', 'over_90'] as const;
type Bucket = (typeof BUCKETS)[number];

const bucketFor = (daysPastDue: number): Bucket =>
  daysPastDue <= 0 ? 'current' : daysPastDue <= 30 ? '1_30' : daysPastDue <= 60 ? '31_60' : daysPastDue <= 90 ? '61_90' : 'over_90';

export async function getArAging(tx: Tx, tenantId: string, args: { as_of?: string; overdue_more_than_days?: number; customer_id?: string }) {
  const asOf = args.as_of ?? (await tenantToday(tx, tenantId));
  const rows = await sql<{
    invoice_id: string; doc_number: string | null; customer_id: string; customer_name: string;
    txn_date: string; due_date: string | null; total: string; balance: string; days_past_due: number;
  }>`
    SELECT i.qbo_id AS invoice_id, i.doc_number, i.customer_qbo_id AS customer_id,
           coalesce(c.display_name, '(unknown customer ' || i.customer_qbo_id || ')') AS customer_name,
           i.txn_date::text, i.due_date::text, i.total_amt::text AS total, i.balance::text AS balance,
           (${asOf}::date - coalesce(i.due_date, i.txn_date))::int AS days_past_due
      FROM qbo_invoices i
      LEFT JOIN qbo_customers c ON c.tenant_id = i.tenant_id AND c.qbo_id = i.customer_qbo_id
     WHERE i.tenant_id = ${tenantId} AND NOT i.is_deleted AND NOT i.is_voided AND i.balance > 0
       AND i.txn_date <= ${asOf}::date
       ${args.customer_id ? sql`AND i.customer_qbo_id = ${args.customer_id}` : sql``}
       ${args.overdue_more_than_days !== undefined ? sql`AND (${asOf}::date - coalesce(i.due_date, i.txn_date)) > ${args.overdue_more_than_days}` : sql``}
     ORDER BY days_past_due DESC, i.balance DESC`.execute(tx);

  const cents = (s: string) => Math.round(Number(s) * 100);
  const money = (c: number) => (c / 100).toFixed(2);
  const totals: Record<Bucket, number> = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
  const byCustomer = new Map<string, { customer_id: string; customer_name: string; balance: number; oldest_days_past_due: number; invoices: unknown[] }>();
  for (const r of rows.rows) {
    const b = bucketFor(r.days_past_due);
    totals[b] += cents(r.balance);
    const c = byCustomer.get(r.customer_id) ?? { customer_id: r.customer_id, customer_name: r.customer_name, balance: 0, oldest_days_past_due: r.days_past_due, invoices: [] };
    c.balance += cents(r.balance);
    c.oldest_days_past_due = Math.max(c.oldest_days_past_due, r.days_past_due);
    c.invoices.push({ ...r, bucket: b });
    byCustomer.set(r.customer_id, c);
  }
  const customers = [...byCustomer.values()]
    .sort((a, b) => b.balance - a.balance)
    .map((c) => ({ ...c, balance: money(c.balance) }));
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  return {
    as_of: asOf,
    filter: { overdue_more_than_days: args.overdue_more_than_days ?? null, customer_id: args.customer_id ?? null },
    total_open_balance: money(total),
    invoice_count: rows.rows.length,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, money(totals[b])])),
    customers,
    definitions: 'days_past_due = as_of - due_date. Buckets: current (not yet due), 1_30, 31_60, 61_90, over_90. "More than 60 days" means days_past_due > 60.',
  };
}

// ---------------------------------------------------------------------------
// list_open_estimates
// ---------------------------------------------------------------------------
export async function listOpenEstimates(tx: Tx, tenantId: string, args: { customer_id?: string; include_expired?: boolean; as_of?: string }) {
  const asOf = args.as_of ?? (await tenantToday(tx, tenantId));
  const rows = await sql<{
    estimate_id: string; doc_number: string | null; customer_id: string; customer_name: string;
    txn_date: string; expiration_date: string | null; expired: boolean; total: string; title: string | null; line_count: number;
  }>`
    SELECT e.qbo_id AS estimate_id, e.doc_number, e.customer_qbo_id AS customer_id,
           coalesce(c.display_name, '(unknown customer)') AS customer_name,
           e.txn_date::text, e.expiration_date::text,
           (e.expiration_date IS NOT NULL AND e.expiration_date < ${asOf}::date) AS expired,
           e.total_amt::text AS total, e.customer_memo AS title,
           (SELECT count(*)::int FROM qbo_txn_lines l WHERE l.tenant_id = e.tenant_id AND l.txn_type = 'Estimate' AND l.txn_qbo_id = e.qbo_id) AS line_count
      FROM qbo_estimates e
      LEFT JOIN qbo_customers c ON c.tenant_id = e.tenant_id AND c.qbo_id = e.customer_qbo_id
     WHERE e.tenant_id = ${tenantId} AND NOT e.is_deleted AND e.txn_status = 'Pending'
       ${args.customer_id ? sql`AND e.customer_qbo_id = ${args.customer_id}` : sql``}
       ${args.include_expired === false ? sql`AND (e.expiration_date IS NULL OR e.expiration_date >= ${asOf}::date)` : sql``}
     ORDER BY e.txn_date DESC`.execute(tx);
  const total = rows.rows.reduce((s, r) => s + Math.round(Number(r.total) * 100), 0);
  return { as_of: asOf, count: rows.rows.length, total_value: (total / 100).toFixed(2), estimates: rows.rows };
}

// ---------------------------------------------------------------------------
// get_revenue_by_item
// ---------------------------------------------------------------------------
export async function getRevenueByItem(tx: Tx, tenantId: string, args: { start_date: string; end_date: string }) {
  if (args.start_date > args.end_date) throw new ToolError('INVALID_ARGUMENT', 'start_date must be on or before end_date');
  const rows = await sql<{ item_id: string | null; item_name: string; revenue: string; quantity: string | null; line_count: number; invoice_count: number }>`
    SELECT l.item_qbo_id AS item_id, coalesce(it.name, '(no item)') AS item_name,
           sum(l.amount)::numeric(14,2)::text AS revenue,
           sum(l.qty)::text AS quantity,
           count(*)::int AS line_count,
           count(DISTINCT i.qbo_id)::int AS invoice_count
      FROM qbo_txn_lines l
      JOIN qbo_invoices i ON i.tenant_id = l.tenant_id AND i.qbo_id = l.txn_qbo_id
      LEFT JOIN qbo_items it ON it.tenant_id = l.tenant_id AND it.qbo_id = l.item_qbo_id
     WHERE l.tenant_id = ${tenantId} AND l.txn_type = 'Invoice'
       AND NOT i.is_deleted AND NOT i.is_voided
       AND i.txn_date BETWEEN ${args.start_date}::date AND ${args.end_date}::date
     GROUP BY l.item_qbo_id, it.name
     ORDER BY sum(l.amount) DESC`.execute(tx);
  const total = rows.rows.reduce((s, r) => s + Math.round(Number(r.revenue) * 100), 0);
  return {
    start_date: args.start_date,
    end_date: args.end_date,
    basis: 'Invoiced revenue (accrual) by invoice date, before tax; excludes voided and deleted invoices. Each item is a service type.',
    total_revenue: (total / 100).toFixed(2),
    items: rows.rows,
  };
}

// ---------------------------------------------------------------------------
// get_customer_job_history
// ---------------------------------------------------------------------------
export async function getCustomerJobHistory(tx: Tx, tenantId: string, args: { customer_id?: string; query?: string; limit?: number; include_lines?: boolean }) {
  if (!args.customer_id && !args.query?.trim()) {
    throw new ToolError('INVALID_ARGUMENT', 'Provide customer_id, query, or both.', { hint: 'Use query (e.g. "bathroom remodel walk-in shower") to find similar jobs across all customers.' });
  }
  const q = args.query?.trim() || null;
  const limit = Math.min(args.limit ?? 10, 25);
  const like = q ? `%${likeEscape(q)}%` : null;

  // A "job" is an estimate (with the invoice that billed it, if any), or an
  // invoice that was never estimated. Similarity is on the job title.
  const jobs = await sql<{
    source: 'estimate' | 'invoice'; job_id: string; customer_id: string; customer_name: string; date: string; status: string;
    title: string | null; estimate_id: string | null; estimate_total: string | null; invoice_id: string | null; invoiced_total: string | null;
    invoice_balance: string | null; score: string | null;
  }>`
    WITH jobs AS (
      SELECT 'estimate'::text AS source, e.qbo_id AS job_id, e.customer_qbo_id AS customer_id, e.txn_date AS date,
             CASE WHEN i.qbo_id IS NOT NULL THEN CASE WHEN i.balance = 0 THEN 'invoiced_paid' ELSE 'invoiced_open' END
                  ELSE lower(coalesce(e.txn_status, 'pending')) END AS status,
             e.customer_memo AS title, e.qbo_id AS estimate_id, e.total_amt::text AS estimate_total,
             i.qbo_id AS invoice_id, i.total_amt::text AS invoiced_total, i.balance::text AS invoice_balance
        FROM qbo_estimates e
        LEFT JOIN qbo_invoices i ON i.tenant_id = e.tenant_id AND i.linked_estimate_id = e.qbo_id AND NOT i.is_deleted AND NOT i.is_voided
       WHERE e.tenant_id = ${tenantId} AND NOT e.is_deleted
      UNION ALL
      SELECT 'invoice', i.qbo_id, i.customer_qbo_id, i.txn_date,
             CASE WHEN i.balance = 0 THEN 'invoiced_paid' ELSE 'invoiced_open' END,
             i.customer_memo, NULL, NULL, i.qbo_id, i.total_amt::text, i.balance::text
        FROM qbo_invoices i
       WHERE i.tenant_id = ${tenantId} AND NOT i.is_deleted AND NOT i.is_voided AND i.linked_estimate_id IS NULL
    )
    SELECT j.source, j.job_id, j.customer_id, coalesce(c.display_name, '(unknown)') AS customer_name, j.date::text AS date, j.status,
           j.title, j.estimate_id, j.estimate_total, j.invoice_id, j.invoiced_total, j.invoice_balance,
           ${q ? sql`round(greatest(word_similarity(${q}, coalesce(j.title, '')), similarity(coalesce(j.title, ''), ${q}))::numeric, 3)::text` : sql`NULL`} AS score
      FROM jobs j
      LEFT JOIN qbo_customers c ON c.tenant_id = ${tenantId} AND c.qbo_id = j.customer_id
     WHERE TRUE
       ${args.customer_id ? sql`AND j.customer_id = ${args.customer_id}` : sql``}
       ${q ? sql`AND (j.title ILIKE ${like} OR word_similarity(${q}, coalesce(j.title, '')) > 0.3)` : sql``}
     ORDER BY ${q ? sql`score DESC,` : sql``} j.date DESC
     LIMIT ${limit}`.execute(tx);

  const includeLines = args.include_lines ?? true;
  const lineRows = includeLines && jobs.rows.length
    ? await sql<{ txn_type: string; txn_qbo_id: string; item_id: string | null; item_name: string | null; description: string | null; qty: string | null; unit_price: string | null; amount: string }>`
        SELECT l.txn_type, l.txn_qbo_id, l.item_qbo_id AS item_id, it.name AS item_name, l.description,
               l.qty::text, l.unit_price::text, l.amount::text
          FROM qbo_txn_lines l
          LEFT JOIN qbo_items it ON it.tenant_id = l.tenant_id AND it.qbo_id = l.item_qbo_id
         WHERE l.tenant_id = ${tenantId}
           AND (l.txn_type, l.txn_qbo_id) IN (${sql.join(jobs.rows.map((j) => sql`(${j.source === 'estimate' ? 'Estimate' : 'Invoice'}, ${j.job_id})`))})
         ORDER BY l.line_num NULLS LAST, l.line_id`.execute(tx)
    : { rows: [] };

  return {
    filter: { customer_id: args.customer_id ?? null, query: q },
    count: jobs.rows.length,
    jobs: jobs.rows.map((j) => ({
      ...j,
      score: j.score === null ? undefined : Number(j.score),
      lines: includeLines
        ? lineRows.rows
            .filter((l) => l.txn_qbo_id === j.job_id && l.txn_type === (j.source === 'estimate' ? 'Estimate' : 'Invoice'))
            .map(({ txn_type: _t, txn_qbo_id: _i, ...l }) => l)
        : undefined,
    })),
  };
}
