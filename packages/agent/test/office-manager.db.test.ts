/**
 * The Office Manager loop against the real MCP server and seeded data, with a
 * scripted model. Asserts the things that must hold regardless of model
 * quality: metering, routing, the spend cap, and the write guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, withTenant } from '@co/db';
import { connectToolbox } from '../src/toolbox';
import { runTurn, type AgentDeps } from '../src/office-manager';
import { reserveSpend, settleSpend, SpendCapExceeded } from '../src/spend';
import { FakeLlm, reply, setupWorld } from './fixture';

let w: Awaited<ReturnType<typeof setupWorld>>;
let llm: FakeLlm;
let deps: AgentDeps;

beforeAll(async () => {
  w = await setupWorld();
  llm = new FakeLlm();
  deps = { db: w.db, llm, prices: w.prices, toolbox: (k) => connectToolbox(w.mcpUrl, k), log: w.silent };
}, 60_000);
afterAll(async () => w.teardown());

const turn = (message: string, conversationId?: string, apiKey = w.writeKey) => runTurn(deps, { tenantId: w.tenantId, apiKey, message, conversationId });
const estimatePosts = () => w.fake.requests.filter((r) => r.method === 'POST' && r.path === '/estimate').length;

describe('a lookup turn', () => {
  it('routes to Haiku, calls tools via MCP, answers, and meters every call', async () => {
    llm.setRouter(() => 'lookup');
    llm.queue(
      () => reply.tools([['find_customer', { query: 'Westside' }]]),
      (_p, { lastToolResults }) => reply.tools([['get_ar_aging', { customer_id: lastToolResults[0]!.body.matches[0].customer_id, as_of: '2026-10-08' }]]),
      (_p, { lastToolResults }) => reply.text(`Westside Rentals owes $${lastToolResults[0]!.body.total_open_balance}.`),
    );
    const r = await turn('How much does Westside owe me?');
    expect(r.status).toBe('completed');
    // J28 5,980.50 + J29 7,054.00 + J30 4,279.50 (after the seeded partial payment) + J32 7,682.00
    expect(r.reply).toBe('Westside Rentals owes $24996.00.');
    expect(r.model).toBe('claude-haiku-5-5');
    expect(r.toolCalls.map((t) => t.name)).toEqual(['find_customer', 'get_ar_aging']);

    const calls = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('llm_calls').selectAll().where('run_id', '=', r.runId).orderBy('step_no').execute());
    expect(calls.map((c) => c.purpose)).toEqual(['route', 'answer', 'answer', 'answer']);
    const sum = calls.reduce((s, c) => s + Number(c.cost_usd), 0);
    const run = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('agent_runs').selectAll().where('id', '=', r.runId).executeTakeFirstOrThrow());
    expect(Number(run.total_cost_usd)).toBeCloseTo(sum, 6);
    expect(run).toMatchObject({ status: 'completed', intent: 'lookup', model: 'claude-haiku-5-5' });

    const steps = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('agent_steps').select(['step_no', 'kind', 'name']).where('run_id', '=', r.runId).orderBy('step_no').execute());
    expect(steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'llm:route:claude-haiku-5-5', 'llm:answer:claude-haiku-5-5', 'tool:find_customer', 'llm:answer:claude-haiku-5-5', 'tool:get_ar_aging', 'llm:answer:claude-haiku-5-5',
    ]);

    const spend = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('tenant_spend').selectAll().executeTakeFirstOrThrow());
    expect(Number(spend.reserved_usd)).toBe(0); // every reservation settled
    expect(Number(spend.spent_usd)).toBeGreaterThanOrEqual(sum);
  });

  it('the model sees the system prompt with the contractor\'s date and all six tools', async () => {
    const answerCall = llm.calls.find((c) => !c.output_config?.format)!;
    expect(String(answerCall.system)).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
    expect(answerCall.tools!.map((t) => (t as { name: string }).name)).toHaveLength(6);
    expect(answerCall.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('tool errors are returned to the model so it can recover', async () => {
    llm.setRouter(() => 'lookup');
    llm.queue(
      () => reply.tools([['get_ar_aging', { customer_id: 'Westside Rentals' }]]),
      (_p, { lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ isError: true, body: { error: { code: 'NOT_FOUND' } } });
        return reply.tools([['find_customer', { query: 'Westside Rentals' }]]);
      },
      () => reply.text('Found them.'),
    );
    const r = await turn('What does Westside Rentals owe?');
    expect(r.toolCalls.map((t) => [t.name, t.isError])).toEqual([['get_ar_aging', true], ['find_customer', false]]);
  });

  it('analysis questions route to Sonnet', async () => {
    llm.setRouter(() => 'analysis');
    llm.queue(() => reply.text('Ranked.', 'claude-sonnet-5-5'));
    const r = await turn('Rank my customers by how late they pay');
    expect(r.model).toBe('claude-sonnet-5-5');
  });
});

describe('the write guard (agent must never write without confirmation)', () => {
  let conversationId: string;
  let token: string;

  it('turn 1: preview is allowed; confirming in the same turn is blocked', async () => {
    llm.setRouter(() => 'estimate');
    const before = estimatePosts();
    llm.queue(
      () => reply.tools([['find_customer', { query: 'Mark Johnson' }]], 'claude-sonnet-5-5'),
      () => reply.tools([['get_customer_job_history', { query: 'bathroom remodel', limit: 3 }]], 'claude-sonnet-5-5'),
      (p) => {
        const jobs = (JSON.parse(String((p.messages.at(-1)!.content as any)[0].content)) as any).jobs;
        const lines = jobs[0].lines.slice(0, 3).map((l: any) => ({ item_id: l.item_id, quantity: Number(l.qty), unit_price: Number(l.unit_price) }));
        const customer = (JSON.parse(String((p.messages.at(-3)!.content as any)[0].content)) as any).matches[0].customer_id;
        return reply.tools([['create_estimate_draft', { customer_id: customer, title: 'Bathroom remodel', lines }]], 'claude-sonnet-5-5');
      },
      (_p, { lastToolResults }) => {
        token = lastToolResults[0]!.body.confirmation_token;
        // A model that "helpfully" confirms its own draft:
        return reply.tools([['create_estimate_draft', { confirmation_token: token }]], 'claude-sonnet-5-5');
      },
      (_p, { lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ isError: true, body: { error: { code: 'CONFIRMATION_REQUIRED' } } });
        return reply.text('Here is the draft. Shall I create it?', 'claude-sonnet-5-5');
      },
    );
    const r = await turn('Draft an estimate for the Johnson bathroom remodel');
    conversationId = r.conversationId;
    expect(r.status).toBe('completed');
    expect(r.toolCalls.find((t) => t.blocked)).toBeTruthy();
    expect(estimatePosts()).toBe(before);
    const guard = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('agent_steps').select('name').where('run_id', '=', r.runId).where('kind', '=', 'guard').execute());
    expect(guard).toHaveLength(1);
  });

  it('turn 2: an unrelated message is not approval, so confirming is still blocked', async () => {
    llm.setRouter(() => 'lookup');
    const before = estimatePosts();
    llm.queue(
      () => reply.tools([['create_estimate_draft', { confirmation_token: token }]]),
      () => reply.text('ok'),
    );
    const r = await turn('Actually, what do I have in open estimates?', conversationId);
    expect(r.toolCalls[0]!.blocked).toBe(true);
    expect(estimatePosts()).toBe(before);
  });

  it('turn 3: explicit approval unlocks exactly one write', async () => {
    llm.setRouter(() => 'approve_draft');
    const before = estimatePosts();
    llm.queue(
      () => reply.tools([['create_estimate_draft', { confirmation_token: token }]]),
      (_p, { lastToolResults }) => {
        expect(lastToolResults[0]!.body.status).toBe('created');
        return reply.text(`Created estimate ${lastToolResults[0]!.body.estimate_id}.`);
      },
    );
    const r = await turn('Yes, create it.', conversationId);
    expect(r.toolCalls[0]!.blocked).toBeUndefined();
    expect(estimatePosts()).toBe(before + 1);
  });

  it('turn 4: the consumed token cannot be reused, even with another "yes"', async () => {
    llm.setRouter(() => 'approve_draft');
    const before = estimatePosts();
    llm.queue(
      () => reply.tools([['create_estimate_draft', { confirmation_token: token }]]),
      () => reply.text('Already done.'),
    );
    const r = await turn('yes', conversationId);
    // No pending draft left: the router's approval is coerced away and the guard blocks.
    expect(r.intent).not.toBe('approve_draft');
    expect(r.toolCalls[0]!.blocked).toBe(true);
    expect(estimatePosts()).toBe(before);
  });

  it('a read-only key gives an agent that cannot even preview', async () => {
    llm.setRouter(() => 'estimate');
    llm.queue(
      () => reply.tools([['create_estimate_draft', { customer_id: '1', lines: [{ item_id: '1', quantity: 1 }] }]], 'claude-sonnet-5-5'),
      (_p, { lastToolResults }) => {
        expect(lastToolResults[0]!.body.error.code).toBe('FORBIDDEN');
        return reply.text('I can only read data with this key.', 'claude-sonnet-5-5');
      },
    );
    await turn('Quote a small job', undefined, w.readKey);
  });
});

describe('router failure', () => {
  it('falls back to a fast lookup and never unlocks a write', async () => {
    const broken = { calls: 0, async create(p: any) { this.calls++; if (p.output_config?.format) throw new Error('400 bad request'); return reply.text('Answered anyway.'); } };
    const r = await runTurn({ ...deps, llm: broken as never }, { tenantId: w.tenantId, apiKey: w.writeKey, message: 'yes, create it' });
    expect(r).toMatchObject({ status: 'completed', intent: 'lookup', model: 'claude-haiku-5-5', reply: 'Answered anyway.' });
  });
});

describe('spend cap', () => {
  it('reservations hold under concurrency: never more than the cap', async () => {
    await asSystem(w.db, 'test', (tx) => tx.updateTable('tenants').set({ monthly_spend_cap_usd: '0.05' }).where('id', '=', w.tenantId).execute());
    await asSystem(w.db, 'test', (tx) => tx.updateTable('tenant_spend').set({ spent_usd: '0', reserved_usd: '0' }).where('tenant_id', '=', w.tenantId).execute());
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveSpend(w.db, w.tenantId, 0.01)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof SpendCapExceeded)).toBe(true);
    for (const r of ok) await settleSpend(w.db, (r as PromiseFulfilledResult<any>).value, 0);
  });

  it('a tenant over its cap gets a clear refusal and no model call is made', async () => {
    await asSystem(w.db, 'test', (tx) => tx.updateTable('tenants').set({ monthly_spend_cap_usd: '0.000001' }).where('id', '=', w.tenantId).execute());
    const before = llm.calls.length;
    const r = await turn('Who owes me money?');
    expect(r.status).toBe('rejected_spend_cap');
    expect(r.reply).toMatch(/monthly AI budget/);
    expect(llm.calls.length).toBe(before);
    await asSystem(w.db, 'test', (tx) => tx.updateTable('tenants').set({ monthly_spend_cap_usd: '25' }).where('id', '=', w.tenantId).execute());
  });

  it('a failed model call releases its reservation and charges nothing', async () => {
    llm.setRouter(() => 'lookup');
    // No scripted answer -> the fake throws on the answer call.
    const r = await turn('This will fail');
    expect(r.status).toBe('failed');
    const err = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('agent_steps').select(['kind', 'error']).where('run_id', '=', r.runId).where('kind', '=', 'error').executeTakeFirstOrThrow());
    expect(JSON.stringify(err.error)).toMatch(/no scripted response/);
    const spend = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('tenant_spend').select('reserved_usd').executeTakeFirstOrThrow());
    expect(Number(spend.reserved_usd)).toBe(0);
  });
});
