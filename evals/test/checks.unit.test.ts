import { describe, expect, it } from 'vitest';
import { amountsIn, hasAmount, NO_DATA } from '../checks';
import { toolsMatch } from '../runner';

describe('eval checks', () => {
  it('extracts dollar amounts in common formats', () => {
    expect(amountsIn('Westside owes **$24,996.00**; 3 invoices, $7,054 and 5980.5')).toEqual([24996, 3, 7054, 5980.5]);
    expect(hasAmount('Total: $25,898.50.', 25898.5)).toBe(true);
    expect(hasAmount('Total: $25,898.', 25898.5)).toBe(false);
  });
  it('recognizes "no data" phrasing', () => {
    for (const s of ["I couldn't find any payments from Priya Raman.", 'There are no invoices in 2023.', "I don't see a customer named Bob."]) expect(NO_DATA.test(s)).toBe(true);
    expect(NO_DATA.test('Priya paid $4,200.00 last year.')).toBe(false);
  });
  it('scores tool-call correctness on name and expected args', () => {
    const turns = [{ toolCalls: [{ name: 'get_ar_aging', input: { overdue_more_than_days: 60, as_of: '2026-10-08' }, isError: false }] }] as never;
    expect(toolsMatch([{ name: 'get_ar_aging', args: { overdue_more_than_days: 60 } }], turns)).toBe(true);
    expect(toolsMatch([{ name: 'get_ar_aging', args: { overdue_more_than_days: 30 } }], turns)).toBe(false);
  });
});

describe('number extraction ignores dates and ids (first eval run regressions)', async () => {
  const { amountsIn, dollarAmounts } = await import('../checks');
  it('dates are not amounts', () => {
    expect(amountsIn('open balance of $0.00, last activity on 2026-04-15')).toEqual([0]);
    expect(amountsIn('$0.00 invoiced in 2023 (January 1 to December 31)')).toEqual([0, 2023]);
    expect(dollarAmounts('$0.00 invoiced in 2023 (January 1 to December 31)')).toEqual([0]);
  });
  it('ids are not money', () => {
    expect(dollarAmounts("She's in QuickBooks as customer 1031 since April 15, 2025.")).toEqual([]);
  });
});
