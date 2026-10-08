import { describe, expect, it } from 'vitest';
import { buildPlan, CUSTOMERS, daysBetween, ITEMS } from '../seed/catalog';

const anchor = '2026-10-08';
const plan = buildPlan(anchor);

describe('seed plan', () => {
  it('is deterministic', () => {
    expect(buildPlan(anchor)).toEqual(plan);
    expect(buildPlan(anchor, 1)).not.toEqual(plan);
  });

  it('has 40 jobs across bathroom, kitchen and flooring', () => {
    expect(plan.jobs).toHaveLength(40);
    const types = new Set(plan.jobs.map((j) => j.type));
    expect(types).toEqual(new Set(['bathroom', 'kitchen', 'flooring']));
    expect(plan.jobs.filter((j) => j.type === 'bathroom').length).toBeGreaterThanOrEqual(12);
  });

  it('only references known items and customers, with consistent math', () => {
    const items = new Set(ITEMS.map((i) => i.key));
    const customers = new Set(CUSTOMERS.map((c) => c.key));
    for (const j of plan.jobs) {
      expect(customers.has(j.customerKey)).toBe(true);
      for (const l of j.lines) {
        expect(items.has(l.itemKey)).toBe(true);
        expect(l.amount).toBeCloseTo(l.qty * l.unitPrice, 2);
      }
      expect(j.subtotal).toBeCloseTo(j.lines.reduce((s, l) => s + l.amount, 0), 2);
    }
  });

  it('keeps dates in order: estimate <= invoice < due, payments after invoice, nothing in the future', () => {
    for (const j of plan.jobs) {
      expect(j.estimate.date <= anchor).toBe(true);
      if (!j.invoice) continue;
      expect(j.estimate.date <= j.invoice.date).toBe(true);
      expect(j.invoice.date < j.invoice.dueDate).toBe(true);
      expect(j.invoice.date <= anchor).toBe(true);
      for (const p of j.payments) {
        expect(p.date >= j.invoice.date && p.date <= anchor).toBe(true);
        expect(p.amount).toBeLessThanOrEqual(j.subtotal);
      }
    }
  });

  it('plants the eval edge cases', () => {
    const open = (j: (typeof plan.jobs)[number]) => j.invoice && j.payments.reduce((s, p) => s + p.amount, 0) < j.subtotal;
    const overdue = (j: (typeof plan.jobs)[number]) => daysBetween(j.invoice!.dueDate, anchor);
    expect(plan.jobs.some((j) => open(j) && overdue(j) === 61)).toBe(true);
    expect(plan.jobs.some((j) => open(j) && overdue(j) === 60)).toBe(true);
    expect(plan.jobs.some((j) => j.payments.length === 1 && j.payments[0]!.amount < j.subtotal)).toBe(true);
    expect(plan.jobs.filter((j) => open(j) && overdue(j) > 90).length).toBeGreaterThanOrEqual(2);
    expect(plan.jobs.filter((j) => j.invoice && overdue(j) < 0).length).toBe(3);
    expect(plan.jobs.some((j) => j.estimate.status === 'Rejected')).toBe(true);
    expect(plan.jobs.some((j) => j.estimate.status === 'Pending' && j.estimate.expirationDate < anchor)).toBe(true);
    expect(plan.jobs.some((j) => j.customerKey === 'c_raman')).toBe(false);
    expect(plan.jobs.some((j) => j.customerKey === 'c_mark_johnson' && j.type === 'bathroom')).toBe(false);
  });
});
