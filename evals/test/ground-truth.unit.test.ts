/**
 * Pins the eval ground truth to figures verified by hand against the live
 * sandbox on 2026-10-08 (see the Day 1-3 checkpoints). If the seed plan
 * changes, these fail before any eval silently moves its goalposts.
 */
import { describe, expect, it } from 'vitest';
import { buildPlan } from '../../scripts/seed/catalog';
import { groundTruth } from '../cases';
import { ANCHOR } from '../world';

const g = groundTruth({ plan: buildPlan(ANCHOR) });

describe('eval ground truth', () => {
  it('matches the hand-verified receivables figures', () => {
    expect(g.totalOpen).toBe(78327.0);
    expect(g.over60Total).toBe(25898.5);
    expect(g.over60.map((j) => j.key).sort()).toEqual(['J17', 'J24', 'J29']); // J28 at exactly 60 days is excluded
    expect(g.balanceOf('c_westside')).toBe(24996.0);
  });
  it('matches the derived buckets and rankings', () => {
    expect(g.current).toBe(34486.5);
    expect(g.bucket31to60).toBe(17942.0);
    expect(g.topDebtor).toEqual(['c_caldwell', 28776]);
    expect([g.oldest.key, g.dpd(g.oldest)]).toEqual(['J17', 161]);
    expect(g.q3Invoiced).toBe(62841.5);
    expect(g.pending.map((j) => j.key)).toEqual(['J37', 'J38', 'J39', 'J40']);
    expect(((g.over60Total / g.totalOpen) * 100).toFixed(2)).toBe('33.06');
  });
});
