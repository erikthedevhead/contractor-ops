import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@co/db';
import { dropTenant, makeTenant, testDb } from '../../db/test/helpers';
import { upsertCustomer, upsertInvoice, upsertPayment } from '../src/mirror';
import type { QboInvoice } from '../src/types';

const db = testDb();
let t: string;

beforeAll(async () => { t = await makeTenant(db, 'mirror'); });
afterAll(async () => { await dropTenant(db, t); await db.destroy(); });

const meta = (ts: string) => ({ LastUpdatedTime: ts });

const invoice = (sync: string, total: number, lines: Array<[string, number]>): QboInvoice => ({
  Id: '100', SyncToken: sync, MetaData: meta(`2026-09-0${sync}T10:00:00Z`),
  CustomerRef: { value: 'c1' }, TxnDate: '2026-08-01', DueDate: '2026-08-31', TotalAmt: total, Balance: total,
  LinkedTxn: [{ TxnId: 'e9', TxnType: 'Estimate' }],
  Line: [
    ...lines.map(([id, amt]) => ({ Id: id, Amount: amt, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: 'i1' }, Qty: 1, UnitPrice: amt } })),
    { Amount: total, DetailType: 'SubTotalLineDetail' },
  ],
});

describe('guarded mirror upserts', () => {
  it('applies newer versions and ignores older or duplicate ones (out-of-order delivery)', async () => {
    const r = await withTenant(db, t, async (tx) => ({
      v2: await upsertInvoice(tx, t, invoice('2', 300, [['1', 100], ['2', 200]])),
      v1: await upsertInvoice(tx, t, invoice('1', 100, [['1', 100]])),   // older arrives late
      v2again: await upsertInvoice(tx, t, invoice('2', 300, [['1', 100], ['2', 200]])), // duplicate
    }));
    expect(r).toEqual({ v2: true, v1: false, v2again: false });

    const row = await withTenant(db, t, (tx) =>
      tx.selectFrom('qbo_invoices').selectAll().where('qbo_id', '=', '100').executeTakeFirstOrThrow(),
    );
    expect(row.sync_token).toBe(2);
    expect(row.total_amt).toBe('300.00');
    expect(row.linked_estimate_id).toBe('e9');
    expect(row.txn_date).toBe('2026-08-01'); // DATE stays a string: no timezone drift
  });

  it('replaces lines wholesale when the parent changes', async () => {
    await withTenant(db, t, (tx) => upsertInvoice(tx, t, invoice('3', 150, [['5', 150]])));
    const lines = await withTenant(db, t, (tx) =>
      tx.selectFrom('qbo_txn_lines').select(['line_id', 'amount']).where('txn_qbo_id', '=', '100').execute(),
    );
    expect(lines).toEqual([{ line_id: '5', amount: '150.00' }]);
  });

  it('marks deletions from CDC-style payloads', async () => {
    await withTenant(db, t, (tx) =>
      upsertCustomer(tx, t, { Id: 'c1', SyncToken: '0', MetaData: meta('2026-09-01T00:00:00Z'), DisplayName: 'Mark Johnson' }),
    );
    await withTenant(db, t, (tx) =>
      upsertCustomer(tx, t, { Id: 'c1', SyncToken: '1', MetaData: meta('2026-09-02T00:00:00Z'), DisplayName: 'Mark Johnson', status: 'Deleted' }),
    );
    const c = await withTenant(db, t, (tx) => tx.selectFrom('qbo_customers').select('is_deleted').where('qbo_id', '=', 'c1').executeTakeFirstOrThrow());
    expect(c.is_deleted).toBe(true);
  });

  it('stores payment applications per invoice', async () => {
    await withTenant(db, t, (tx) =>
      upsertPayment(tx, t, {
        Id: 'p1', SyncToken: '0', MetaData: meta('2026-09-03T00:00:00Z'), CustomerRef: { value: 'c1' },
        TxnDate: '2026-09-03', TotalAmt: 150, Line: [{ Amount: 150, LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }] }],
      }),
    );
    const apps = await withTenant(db, t, (tx) => tx.selectFrom('qbo_payment_applications').select(['invoice_qbo_id', 'amount']).execute());
    expect(apps).toEqual([{ invoice_qbo_id: '100', amount: '150.00' }]);
  });
});
