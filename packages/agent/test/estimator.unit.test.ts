import { describe, expect, it } from 'vitest';
import { validateSubmission } from '../src/estimator';

const jobs = new Map([['J1', { customer_name: 'Nora Schmidt', title: 'Primary bathroom remodel', total: '11618.00' }]]);
const prices = new Map([
  ['tile', { name: 'Tile Install - Standard (sq ft)', prices: new Set([12]) }],
  ['vanity', { name: 'Vanity Install (each)', prices: new Set([650]) }],
]);
const base = {
  title: 'Bathroom remodel',
  assumptions: ['Assumed standard tile, 150 sq ft'],
  comparable_job_ids: ['J1'],
  confidence: 'medium',
};

describe('estimate validation (grounding enforced in code)', () => {
  it('accepts grounded lines and does the arithmetic itself', () => {
    const v = validateSubmission({ ...base, lines: [{ item_id: 'tile', quantity: 150.5, unit_price: 12, basis: 'median of comparables' }, { item_id: 'vanity', quantity: 1, unit_price: 650, basis: 'one vanity' }] }, jobs, prices, 'c1');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.estimate.lines.map((l) => l.amount)).toEqual(['1806.00', '650.00']);
    expect(v.estimate.subtotal).toBe('2456.00');
    expect(v.estimate.lines[0]!.item_name).toBe('Tile Install - Standard (sq ft)');
    expect(v.estimate.comparable_jobs[0]!.customer_name).toBe('Nora Schmidt');
  });

  it('rejects an item the estimator never saw (hallucinated id)', () => {
    const v = validateSubmission({ ...base, lines: [{ item_id: 'marble', quantity: 1, unit_price: 99, basis: 'made up price' }] }, jobs, prices, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]).toMatch(/does not appear in any comparable job/);
  });

  it('rejects a price not found in the comparables (invented price)', () => {
    const v = validateSubmission({ ...base, lines: [{ item_id: 'tile', quantity: 100, unit_price: 9.99, basis: 'made up price' }] }, jobs, prices, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors[0]).toMatch(/not a price from the comparable jobs \(seen: 12\)/);
  });

  it('rejects citing a comparable job it never retrieved', () => {
    const v = validateSubmission({ ...base, comparable_job_ids: ['J999'], lines: [{ item_id: 'tile', quantity: 1, unit_price: 12, basis: 'made up price' }] }, jobs, prices, null);
    expect(v.ok).toBe(false);
  });

  it('rejects malformed submissions with field-level messages', () => {
    const v = validateSubmission({ title: 'x', lines: [] }, jobs, prices, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join(' ')).toMatch(/lines/);
  });
});
