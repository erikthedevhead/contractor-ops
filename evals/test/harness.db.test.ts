/**
 * The harness itself, exercised with a scripted model so it can be trusted
 * before spending money on real model runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLlm, reply } from '../../packages/agent/test/fixture';
import { CASES } from '../cases';
import { renderMarkdown, summarize } from '../report';
import { runEval, saveRun } from '../runner';
import { setupEvalWorld, type EvalWorld } from '../world';

let world: EvalWorld;
beforeAll(async () => {
  world = await setupEvalWorld({ databaseUrl: process.env.DATABASE_URL!, ownerUrl: process.env.MIGRATION_DATABASE_URL!, label: 'harness-test', deleteOnClose: true });
}, 90_000);
afterAll(async () => world.close());

const pick = (...ids: string[]) => CASES.filter((c) => ids.includes(c.id));

describe('eval harness', () => {
  it('scores passes and failures, aggregates cost, and renders a report', async () => {
    const llm = new FakeLlm((m) => (m.includes('flight') ? 'out_of_scope' : 'lookup'));
    // L03 iteration 1: correct; iteration 2: wrong number.
    llm.queue(
      () => reply.tools([['get_ar_aging', { as_of: '2026-10-08' }]]),
      (_p, { lastToolResults }) => reply.text(`Your total outstanding AR is $${Number(lastToolResults[0]!.body.total_open_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}.`),
      () => reply.tools([['get_ar_aging', { as_of: '2026-10-08' }]]),
      () => reply.text('Your total outstanding AR is $70,000.00.'),
    );
    const results = await runEval({ world, llm, cases: pick('L03-total-ar'), iterations: 2, concurrency: 1 });
    expect(results.map((r) => r.pass)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ failureMode: 'wrong_or_missing_number' });
    expect(results[0]!.costUsd).toBeGreaterThan(0);
    expect(results[0]!.toolsOk).toBe(true);

    const s = summarize(results);
    expect(s).toMatchObject({ accuracy: 0.5, flakyCases: ['L03-total-ar'] });
    const md = renderMarkdown(s, { gitSha: 'test', iterations: 2, models: 'fake', startedAt: 'now', durationS: 1, readWorldWrites: 0 }, CASES);
    expect(md).toContain('| L03-total-ar | lookup |');
    expect(md).toContain('wrong_or_missing_number');
    const runId = await saveRun(world, { gitSha: 'test', config: {} }, results, CASES, s);
    const saved = await world.db.selectFrom('eval_results').select('passed').where('run_id', '=', runId).execute();
    expect(saved).toHaveLength(2);
  });

  it('refusal case: out-of-scope request, no tools', async () => {
    const llm = new FakeLlm(() => 'out_of_scope');
    llm.queue(() => reply.text("Sorry, I can't book flights. I can only help with your QuickBooks data."));
    const [r] = await runEval({ world, llm, cases: pick('R04-out-of-scope'), iterations: 1, concurrency: 1 });
    expect(r!.pass).toBe(true);
  });

  it('fault case without a model: duplicate webhooks are deduped and the mirror is current', async () => {
    const [r] = await runEval({ world, llm: new FakeLlm(), cases: pick('F03-duplicate-webhooks'), iterations: 1, concurrency: 1 });
    expect(r).toMatchObject({ pass: true, detail: expect.stringMatching(/1 accepted/) });
  });

  it('fresh customers are unique per case and isolated from seed data', async () => {
    const names: string[] = [];
    const probe = {
      id: 'X-probe', category: 'write_safety' as const, world: 'write' as const, description: 'probe',
      async run(ctx: any) {
        names.push(await ctx.freshCustomer(), await ctx.freshCustomer({ withPendingEstimate: 'Bathroom remodel' }));
        return { pass: true, detail: names.join(', ') };
      },
    };
    await runEval({ world, llm: new FakeLlm(), cases: [probe], iterations: 1, concurrency: 1 });
    expect(new Set(names).size).toBe(2);
    const { withTenant } = await import('@co/db');
    const rows = await withTenant(world.db, world.write.tenantId, (tx) =>
      tx.selectFrom('qbo_customers').select(['display_name', 'qbo_id']).where('display_name', 'in', names).execute());
    expect(rows).toHaveLength(2);
    const est = await withTenant(world.db, world.write.tenantId, (tx) =>
      tx.selectFrom('qbo_estimates').select('txn_status').where('customer_qbo_id', '=', rows.find((r) => r.display_name === names[1])!.qbo_id).execute());
    expect(est).toEqual([{ txn_status: 'Pending' }]);
  });

  it('nothing was written to the read-only tenant', () => {
    expect(world.read.fake.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
  });
});
