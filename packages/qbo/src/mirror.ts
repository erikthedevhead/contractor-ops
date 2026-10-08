import type { Tx } from '@co/db';
import type { QboCustomer, QboEstimate, QboInvoice, QboItem, QboPayment, SalesLine } from './types';

/**
 * QuickBooks JSON -> mirror rows, and guarded upserts.
 *
 * The guard: ON CONFLICT ... DO UPDATE ... WHERE existing.sync_token < EXCLUDED.sync_token.
 * SyncToken increments on every change to an entity, so it is a per-entity
 * version number. Webhook events arrive out of order and sometimes twice;
 * this guard makes applying them idempotent and order-independent: an older
 * version can never overwrite a newer one. Returns true if the row changed.
 */

const num = (v: number | undefined | null) => (v === undefined || v === null ? null : String(v));
const syncTok = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`invalid SyncToken "${v}"`);
  return n;
};
const isDeleted = (e: { status?: string }) => e.status === 'Deleted';

export async function upsertCustomer(tx: Tx, tenantId: string, c: QboCustomer): Promise<boolean> {
  const row = {
    tenant_id: tenantId,
    qbo_id: c.Id,
    sync_token: syncTok(c.SyncToken),
    qbo_updated_at: new Date(c.MetaData.LastUpdatedTime),
    is_deleted: isDeleted(c),
    display_name: c.DisplayName ?? `(deleted ${c.Id})`,
    company_name: c.CompanyName ?? null,
    email: c.PrimaryEmailAddr?.Address ?? null,
    phone: c.PrimaryPhone?.FreeFormNumber ?? null,
    balance: num(c.Balance),
    active: c.Active ?? true,
    raw: JSON.stringify(c),
    synced_at: new Date(),
  };
  const res = await tx
    .insertInto('qbo_customers')
    .values(row)
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'qbo_id'])
        .doUpdateSet((eb) => ({
          sync_token: eb.ref('excluded.sync_token'),
          qbo_updated_at: eb.ref('excluded.qbo_updated_at'),
          is_deleted: eb.ref('excluded.is_deleted'),
          display_name: eb.ref('excluded.display_name'),
          company_name: eb.ref('excluded.company_name'),
          email: eb.ref('excluded.email'),
          phone: eb.ref('excluded.phone'),
          balance: eb.ref('excluded.balance'),
          active: eb.ref('excluded.active'),
          raw: eb.ref('excluded.raw'),
          synced_at: eb.ref('excluded.synced_at'),
        }))
        .where('qbo_customers.sync_token', '<', (eb) => eb.ref('excluded.sync_token')),
    )
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
}

export async function upsertItem(tx: Tx, tenantId: string, i: QboItem): Promise<boolean> {
  const res = await tx
    .insertInto('qbo_items')
    .values({
      tenant_id: tenantId,
      qbo_id: i.Id,
      sync_token: syncTok(i.SyncToken),
      qbo_updated_at: new Date(i.MetaData.LastUpdatedTime),
      is_deleted: isDeleted(i),
      name: i.Name ?? `(deleted ${i.Id})`,
      item_type: i.Type ?? 'Unknown',
      unit_price: num(i.UnitPrice),
      purchase_cost: num(i.PurchaseCost),
      active: i.Active ?? true,
      raw: JSON.stringify(i),
      synced_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'qbo_id'])
        .doUpdateSet((eb) => ({
          sync_token: eb.ref('excluded.sync_token'),
          qbo_updated_at: eb.ref('excluded.qbo_updated_at'),
          is_deleted: eb.ref('excluded.is_deleted'),
          name: eb.ref('excluded.name'),
          item_type: eb.ref('excluded.item_type'),
          unit_price: eb.ref('excluded.unit_price'),
          purchase_cost: eb.ref('excluded.purchase_cost'),
          active: eb.ref('excluded.active'),
          raw: eb.ref('excluded.raw'),
          synced_at: eb.ref('excluded.synced_at'),
        }))
        .where('qbo_items.sync_token', '<', (eb) => eb.ref('excluded.sync_token')),
    )
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
}

export async function upsertInvoice(tx: Tx, tenantId: string, inv: QboInvoice): Promise<boolean> {
  const linkedEstimate = inv.LinkedTxn?.find((l) => l.TxnType === 'Estimate')?.TxnId ?? null;
  const res = await tx
    .insertInto('qbo_invoices')
    .values({
      tenant_id: tenantId,
      qbo_id: inv.Id,
      sync_token: syncTok(inv.SyncToken),
      qbo_updated_at: new Date(inv.MetaData.LastUpdatedTime),
      is_deleted: isDeleted(inv),
      is_voided: isVoided(inv),
      customer_qbo_id: inv.CustomerRef?.value ?? '',
      doc_number: inv.DocNumber ?? null,
      txn_date: inv.TxnDate ?? '1970-01-01',
      due_date: inv.DueDate ?? null,
      total_amt: String(inv.TotalAmt ?? 0),
      balance: String(inv.Balance ?? 0),
      linked_estimate_id: linkedEstimate,
      private_note: inv.PrivateNote ?? null,
      customer_memo: inv.CustomerMemo?.value ?? null,
      raw: JSON.stringify(inv),
      synced_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'qbo_id'])
        .doUpdateSet((eb) => ({
          sync_token: eb.ref('excluded.sync_token'),
          qbo_updated_at: eb.ref('excluded.qbo_updated_at'),
          is_deleted: eb.ref('excluded.is_deleted'),
          is_voided: eb.ref('excluded.is_voided'),
          customer_qbo_id: eb.ref('excluded.customer_qbo_id'),
          doc_number: eb.ref('excluded.doc_number'),
          txn_date: eb.ref('excluded.txn_date'),
          due_date: eb.ref('excluded.due_date'),
          total_amt: eb.ref('excluded.total_amt'),
          balance: eb.ref('excluded.balance'),
          linked_estimate_id: eb.ref('excluded.linked_estimate_id'),
          private_note: eb.ref('excluded.private_note'),
          customer_memo: eb.ref('excluded.customer_memo'),
          raw: eb.ref('excluded.raw'),
          synced_at: eb.ref('excluded.synced_at'),
        }))
        .where('qbo_invoices.sync_token', '<', (eb) => eb.ref('excluded.sync_token')),
    )
    .executeTakeFirst();
  const changed = Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
  if (changed) await replaceLines(tx, tenantId, 'Invoice', inv.Id, isDeleted(inv) ? [] : inv.Line ?? []);
  return changed;
}

export async function upsertEstimate(tx: Tx, tenantId: string, est: QboEstimate): Promise<boolean> {
  const res = await tx
    .insertInto('qbo_estimates')
    .values({
      tenant_id: tenantId,
      qbo_id: est.Id,
      sync_token: syncTok(est.SyncToken),
      qbo_updated_at: new Date(est.MetaData.LastUpdatedTime),
      is_deleted: isDeleted(est),
      customer_qbo_id: est.CustomerRef?.value ?? '',
      doc_number: est.DocNumber ?? null,
      txn_date: est.TxnDate ?? '1970-01-01',
      expiration_date: est.ExpirationDate ?? null,
      txn_status: est.TxnStatus ?? null,
      total_amt: String(est.TotalAmt ?? 0),
      private_note: est.PrivateNote ?? null,
      customer_memo: est.CustomerMemo?.value ?? null,
      raw: JSON.stringify(est),
      synced_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'qbo_id'])
        .doUpdateSet((eb) => ({
          sync_token: eb.ref('excluded.sync_token'),
          qbo_updated_at: eb.ref('excluded.qbo_updated_at'),
          is_deleted: eb.ref('excluded.is_deleted'),
          customer_qbo_id: eb.ref('excluded.customer_qbo_id'),
          doc_number: eb.ref('excluded.doc_number'),
          txn_date: eb.ref('excluded.txn_date'),
          expiration_date: eb.ref('excluded.expiration_date'),
          txn_status: eb.ref('excluded.txn_status'),
          total_amt: eb.ref('excluded.total_amt'),
          private_note: eb.ref('excluded.private_note'),
          customer_memo: eb.ref('excluded.customer_memo'),
          raw: eb.ref('excluded.raw'),
          synced_at: eb.ref('excluded.synced_at'),
        }))
        .where('qbo_estimates.sync_token', '<', (eb) => eb.ref('excluded.sync_token')),
    )
    .executeTakeFirst();
  const changed = Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
  if (changed) await replaceLines(tx, tenantId, 'Estimate', est.Id, isDeleted(est) ? [] : est.Line ?? []);
  return changed;
}

export async function upsertPayment(tx: Tx, tenantId: string, p: QboPayment): Promise<boolean> {
  const res = await tx
    .insertInto('qbo_payments')
    .values({
      tenant_id: tenantId,
      qbo_id: p.Id,
      sync_token: syncTok(p.SyncToken),
      qbo_updated_at: new Date(p.MetaData.LastUpdatedTime),
      is_deleted: isDeleted(p),
      customer_qbo_id: p.CustomerRef?.value ?? '',
      txn_date: p.TxnDate ?? '1970-01-01',
      total_amt: String(p.TotalAmt ?? 0),
      unapplied_amt: num(p.UnappliedAmt),
      raw: JSON.stringify(p),
      synced_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'qbo_id'])
        .doUpdateSet((eb) => ({
          sync_token: eb.ref('excluded.sync_token'),
          qbo_updated_at: eb.ref('excluded.qbo_updated_at'),
          is_deleted: eb.ref('excluded.is_deleted'),
          customer_qbo_id: eb.ref('excluded.customer_qbo_id'),
          txn_date: eb.ref('excluded.txn_date'),
          total_amt: eb.ref('excluded.total_amt'),
          unapplied_amt: eb.ref('excluded.unapplied_amt'),
          raw: eb.ref('excluded.raw'),
          synced_at: eb.ref('excluded.synced_at'),
        }))
        .where('qbo_payments.sync_token', '<', (eb) => eb.ref('excluded.sync_token')),
    )
    .executeTakeFirst();
  const changed = Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
  if (changed) {
    await tx.deleteFrom('qbo_payment_applications').where('tenant_id', '=', tenantId).where('payment_qbo_id', '=', p.Id).execute();
    const apps = isDeleted(p) ? [] : paymentApplications(p);
    if (apps.length > 0) {
      await tx
        .insertInto('qbo_payment_applications')
        .values(apps.map((a) => ({ tenant_id: tenantId, payment_qbo_id: p.Id, invoice_qbo_id: a.invoiceId, amount: String(a.amount) })))
        .execute();
    }
  }
  return changed;
}

/** Sales lines only; subtotal/discount/group lines are presentation, not work items. */
export function salesLines(lines: SalesLine[]) {
  return lines
    .filter((l) => l.DetailType === 'SalesItemLineDetail' && l.Id)
    .map((l) => ({
      lineId: l.Id!,
      lineNum: l.LineNum ?? null,
      itemQboId: l.SalesItemLineDetail?.ItemRef?.value ?? null,
      description: l.Description ?? null,
      qty: num(l.SalesItemLineDetail?.Qty),
      unitPrice: num(l.SalesItemLineDetail?.UnitPrice),
      amount: String(l.Amount),
    }));
}

/** A payment can split across invoices; sum per invoice. */
export function paymentApplications(p: QboPayment): Array<{ invoiceId: string; amount: number }> {
  const byInvoice = new Map<string, number>();
  for (const line of p.Line ?? []) {
    for (const link of line.LinkedTxn ?? []) {
      if (link.TxnType !== 'Invoice') continue;
      byInvoice.set(link.TxnId, Math.round(((byInvoice.get(link.TxnId) ?? 0) + line.Amount) * 100) / 100);
    }
  }
  return [...byInvoice].map(([invoiceId, amount]) => ({ invoiceId, amount }));
}

function isVoided(inv: QboInvoice): boolean {
  // QuickBooks voids zero the amounts and prefix PrivateNote with "Voided".
  return inv.TotalAmt === 0 && /^voided\b/i.test(inv.PrivateNote ?? '');
}

async function replaceLines(tx: Tx, tenantId: string, txnType: 'Invoice' | 'Estimate', txnId: string, lines: SalesLine[]) {
  await tx.deleteFrom('qbo_txn_lines').where('tenant_id', '=', tenantId).where('txn_type', '=', txnType).where('txn_qbo_id', '=', txnId).execute();
  const rows = salesLines(lines);
  if (rows.length === 0) return;
  await tx
    .insertInto('qbo_txn_lines')
    .values(
      rows.map((r) => ({
        tenant_id: tenantId,
        txn_type: txnType,
        txn_qbo_id: txnId,
        line_id: r.lineId,
        line_num: r.lineNum,
        item_qbo_id: r.itemQboId,
        description: r.description,
        qty: r.qty,
        unit_price: r.unitPrice,
        amount: r.amount,
      })),
    )
    .execute();
}

