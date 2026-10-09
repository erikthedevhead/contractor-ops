import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { withTenant, type Db } from '@co/db';
import { isAppError } from '@co/shared';
import { upsertEstimate, type QboClient, type QboEstimate } from '@co/qbo';
import { ToolError } from '../errors';
import { tenantToday } from './read';

/**
 * create_estimate_draft: the only tool that writes to QuickBooks.
 *
 * Step 1 (no token): validate against the mirror, build the EXACT QuickBooks
 *   request body, store it as a pending write, return a human-readable preview
 *   plus a single-use confirmation token. Nothing is sent to QuickBooks.
 * Step 2 (token only): atomically move pending -> executing, verify the stored
 *   body is unchanged (hash), send it with the pending write's fixed requestid,
 *   and record the result.
 *
 * Guarantees:
 * - no write without a prior preview (step 2 accepts nothing but the token)
 * - a token is tenant-bound (RLS) and works once; replaying it after success
 *   returns the original result instead of writing again
 * - every retry of the same token reuses the same requestid, so a timeout
 *   followed by a retry cannot create a second estimate in QuickBooks
 * - a step-2 worker that died mid-call is recovered after 2 minutes the same way
 */

export const CONFIRMATION_TTL_MINUTES = 15;
const STUCK_EXECUTING_MS = 2 * 60 * 1000;

export interface DraftLineInput {
  item_id: string;
  quantity: number;
  unit_price?: number;
  description?: string;
}

export interface DraftInput {
  customer_id: string;
  lines: DraftLineInput[];
  title?: string;
  valid_for_days?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Key-sorted JSON. jsonb reorders keys on storage, so hashes must be over a canonical form. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export async function previewEstimate(db: Db, tenantId: string, input: DraftInput, ctx: { apiKeyId?: string; agentRunId?: string } = {}) {
  if (!input.lines.length) throw new ToolError('INVALID_ARGUMENT', 'An estimate needs at least one line.');

  return withTenant(db, tenantId, async (tx) => {
    const customer = await tx.selectFrom('qbo_customers').select(['qbo_id', 'display_name', 'is_deleted', 'active'])
      .where('qbo_id', '=', input.customer_id).executeTakeFirst();
    if (!customer || customer.is_deleted) {
      throw new ToolError('NOT_FOUND', `No customer with id ${input.customer_id}.`, { hint: 'Use find_customer to get a valid customer_id.' });
    }
    if (!customer.active) throw new ToolError('INVALID_ARGUMENT', `Customer ${customer.display_name} is inactive in QuickBooks.`);

    const itemIds = [...new Set(input.lines.map((l) => l.item_id))];
    const items = await tx.selectFrom('qbo_items').select(['qbo_id', 'name', 'unit_price', 'is_deleted', 'active'])
      .where('qbo_id', 'in', itemIds).execute();
    const byId = new Map(items.filter((i) => !i.is_deleted).map((i) => [i.qbo_id, i]));
    const missing = itemIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new ToolError('NOT_FOUND', `Unknown item id(s): ${missing.join(', ')}.`, { hint: 'Use item ids returned by get_customer_job_history or get_revenue_by_item.' });
    }

    const lines = input.lines.map((l, idx) => {
      const item = byId.get(l.item_id)!;
      const unitPrice = l.unit_price ?? (item.unit_price === null ? null : Number(item.unit_price));
      if (unitPrice === null) throw new ToolError('INVALID_ARGUMENT', `Line ${idx + 1}: item "${item.name}" has no default price; provide unit_price.`);
      if (!(l.quantity > 0)) throw new ToolError('INVALID_ARGUMENT', `Line ${idx + 1}: quantity must be positive.`);
      return { item_id: item.qbo_id, item_name: item.name, quantity: l.quantity, unit_price: round2(unitPrice), amount: round2(l.quantity * unitPrice), description: l.description ?? item.name };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const today = await tenantToday(tx, tenantId);
    const validFor = input.valid_for_days ?? 30;
    const expiration = new Date(`${today}T12:00:00Z`);
    expiration.setUTCDate(expiration.getUTCDate() + validFor);
    const expirationDate = expiration.toISOString().slice(0, 10);

    // The exact body step 2 will send. Hashed so it can't be altered in between.
    const payload = {
      CustomerRef: { value: customer.qbo_id },
      TxnDate: today,
      ExpirationDate: expirationDate,
      TxnStatus: 'Pending',
      ...(input.title ? { CustomerMemo: { value: input.title.slice(0, 1000) } } : {}),
      PrivateNote: 'Drafted by Contractor Ops agent; approved by user before creation.',
      Line: lines.map((l) => ({
        DetailType: 'SalesItemLineDetail',
        Amount: l.amount,
        Description: l.description,
        SalesItemLineDetail: { ItemRef: { value: l.item_id }, Qty: l.quantity, UnitPrice: l.unit_price },
      })),
    };
    const payloadJson = canonicalJson(payload);
    const preview = {
      customer: { customer_id: customer.qbo_id, name: customer.display_name },
      title: input.title ?? null,
      date: today,
      expires_on: expirationDate,
      lines,
      subtotal: subtotal.toFixed(2),
      tax_note: 'Subtotal before any sales tax QuickBooks applies.',
    };

    const row = await tx
      .insertInto('pending_writes')
      .values({
        tenant_id: tenantId,
        api_key_id: ctx.apiKeyId ?? null,
        agent_run_id: ctx.agentRunId ?? null,
        tool_name: 'create_estimate_draft',
        payload: payloadJson,
        payload_sha256: sha256(payloadJson),
        preview: JSON.stringify(preview),
        expires_at: sql<Date>`now() + make_interval(mins => ${CONFIRMATION_TTL_MINUTES})`,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();

    return {
      status: 'preview' as const,
      confirmation_token: row.id,
      token_expires_at: row.expires_at.toISOString(),
      preview,
      next_step: 'Nothing has been written. Show this preview to the user. Only if they explicitly approve, call create_estimate_draft again with ONLY {"confirmation_token": "<token>"}.',
    };
  });
}

export async function confirmEstimate(db: Db, client: QboClient, tenantId: string, token: string) {
  // Claim the token atomically: pending (or stuck executing) -> executing.
  const claimed = await withTenant(db, tenantId, async (tx) => {
    const r = await sql<{ id: string; payload: unknown; payload_sha256: Buffer; qbo_request_id: string; preview: unknown }>`
      UPDATE pending_writes SET status = 'executing', confirmed_at = now()
       WHERE id = ${token} AND tenant_id = ${tenantId} AND expires_at > now()
         AND (status = 'pending' OR (status = 'executing' AND confirmed_at < now() - make_interval(secs => ${STUCK_EXECUTING_MS / 1000})))
      RETURNING id, payload, payload_sha256, qbo_request_id, preview`.execute(tx);
    return r.rows[0];
  });

  if (!claimed) return explainUnclaimable(db, tenantId, token);

  if (!sha256(canonicalJson(claimed.payload)).equals(claimed.payload_sha256)) {
    await setStatus(db, tenantId, token, 'failed', { code: 'PAYLOAD_TAMPERED' });
    throw new ToolError('WRITE_FAILED', 'The stored draft failed its integrity check and was not sent.', { hint: 'Create a new preview.' });
  }

  let created: QboEstimate;
  try {
    const res = await client.post<{ Estimate: QboEstimate }>('/estimate', claimed.payload, { requestId: claimed.qbo_request_id, entityName: 'Estimate' });
    created = res.Estimate;
  } catch (err) {
    if (isAppError(err) && err.retryable) {
      // Back to pending: the same token (and so the same requestid) can be retried safely.
      await setStatus(db, tenantId, token, 'pending', err.toJSON());
    } else {
      await setStatus(db, tenantId, token, 'failed', isAppError(err) ? err.toJSON() : { message: String(err) });
    }
    throw err; // mapped to a tool error by the server layer
  }

  await withTenant(db, tenantId, async (tx) => {
    await tx.updateTable('pending_writes')
      .set({ status: 'committed', committed_qbo_id: created.Id, committed_at: new Date(), error: null })
      .where('id', '=', token).execute();
    await upsertEstimate(tx, tenantId, created);
    await tx.updateTable('qbo_estimates').set({ created_by_agent: true }).where('qbo_id', '=', created.Id).execute();
  });
  return committedResult(created.Id, created.DocNumber ?? null, String(created.TotalAmt), false);
}

function committedResult(estimateId: string, docNumber: string | null, total: string, alreadyCommitted: boolean) {
  return {
    status: 'created' as const,
    estimate_id: estimateId,
    doc_number: docNumber,
    total: Number(total).toFixed(2),
    already_committed: alreadyCommitted,
    note: alreadyCommitted ? 'This token was already used; returning the estimate it created. No second estimate was written.' : undefined,
  };
}

async function explainUnclaimable(db: Db, tenantId: string, token: string): Promise<ReturnType<typeof committedResult>> {
  const row = await withTenant(db, tenantId, (tx) =>
    tx.selectFrom('pending_writes').select(['status', 'expires_at', 'committed_qbo_id', 'error'])
      .where('id', '=', token).executeTakeFirst(),
  );
  if (!row) {
    throw new ToolError('INVALID_CONFIRMATION_TOKEN', 'That confirmation token does not exist for this account.', { hint: 'Call create_estimate_draft without a token to get a new preview.' });
  }
  if (row.status === 'committed' && row.committed_qbo_id) {
    const est = await withTenant(db, tenantId, (tx) =>
      tx.selectFrom('qbo_estimates').select(['doc_number', 'total_amt']).where('qbo_id', '=', row.committed_qbo_id!).executeTakeFirst(),
    );
    return committedResult(row.committed_qbo_id, est?.doc_number ?? null, est?.total_amt ?? '0', true);
  }
  if (row.status === 'executing') {
    throw new ToolError('WRITE_IN_PROGRESS', 'This estimate is being created right now.', { retryable: true, hint: 'Wait a few seconds and call again with the same token.' });
  }
  if (row.status === 'pending' && row.expires_at <= new Date()) {
    await setStatus(db, tenantId, token, 'expired', null);
  }
  if (row.status === 'expired' || row.status === 'pending') {
    throw new ToolError('CONFIRMATION_EXPIRED', `Confirmation tokens are valid for ${CONFIRMATION_TTL_MINUTES} minutes; this one has expired.`, { hint: 'Create a new preview and get the user\'s approval again.' });
  }
  throw new ToolError('WRITE_FAILED', 'This draft could not be created in QuickBooks and was not retried.', { details: { reason: row.error ?? null }, hint: 'Fix the problem and create a new preview.' });
}

async function setStatus(db: Db, tenantId: string, token: string, status: 'pending' | 'failed' | 'expired', error: unknown) {
  await withTenant(db, tenantId, (tx) =>
    tx.updateTable('pending_writes').set({ status, error: error === null ? null : JSON.stringify(error) }).where('id', '=', token).execute(),
  );
}
