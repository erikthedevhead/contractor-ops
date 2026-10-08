import { describe, expect, it } from 'vitest';
import { paymentApplications, salesLines } from '../src/mirror';

describe('mirror mappers', () => {
  it('keeps only sales item lines', () => {
    const rows = salesLines([
      { Id: '1', LineNum: 1, Amount: 100, DetailType: 'SalesItemLineDetail', Description: 'Tile', SalesItemLineDetail: { ItemRef: { value: '7' }, Qty: 10, UnitPrice: 10 } },
      { Amount: 100, DetailType: 'SubTotalLineDetail' },
      { Id: '2', Amount: -10, DetailType: 'DiscountLineDetail' },
    ]);
    expect(rows).toEqual([{ lineId: '1', lineNum: 1, itemQboId: '7', description: 'Tile', qty: '10', unitPrice: '10', amount: '100' }]);
  });

  it('sums payment lines per invoice and ignores non-invoice links', () => {
    const apps = paymentApplications({
      Id: 'p1', SyncToken: '0', MetaData: { LastUpdatedTime: '2026-01-01T00:00:00Z' },
      CustomerRef: { value: 'c1' }, TxnDate: '2026-01-01', TotalAmt: 350.3,
      Line: [
        { Amount: 100.1, LinkedTxn: [{ TxnId: 'i1', TxnType: 'Invoice' }] },
        { Amount: 200.2, LinkedTxn: [{ TxnId: 'i1', TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: 'cm1', TxnType: 'CreditMemo' }] },
      ],
    });
    expect(apps).toEqual([{ invoiceId: 'i1', amount: 300.3 }]);
  });
});
