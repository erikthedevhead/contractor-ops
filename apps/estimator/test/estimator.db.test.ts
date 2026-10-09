/**
 * Day 5 end to end: Office Manager -> (A2A, JSON-RPC, official SDK) ->
 * Estimator -> (MCP) -> mirror. Real HTTP between all three services; only
 * the models are scripted.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { withTenant } from '@co/db';
import { a2aEstimateDelegate, connectToolbox, DelegationFailed, runTurn } from '@co/agent';
import { createApiKey } from '../../mcp/src/keys';
import { dropTenant, makeTenant } from '../../../packages/db/test/helpers';
import { FakeLlm, reply, setupWorld, type Handler } from '../../../packages/agent/test/fixture';
import { createEstimatorApp } from '../src/server';

let w: Awaited<ReturnType<typeof setupWorld>>;
let estLlm: FakeLlm;
let server: Server;
let base: string;

beforeAll(async () => {
  w = await setupWorld();
  estLlm = new FakeLlm();
  // Bind first so the Agent Card can advertise the real port.
  server = createServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', createEstimatorApp({ db: w.db, llm: estLlm, prices: w.prices, toolbox: (k) => connectToolbox(w.mcpUrl, k, 'estimator'), publicUrl: base, log: w.silent }));
}, 60_000);
afterAll(async () => {
  server.close();
  await w.teardown();
});

/** Scripted estimator: search comparables, then submit using what it saw. */
const searchThenSubmit = (mutate?: (lines: any[]) => any[]): Handler[] => [
  () => reply.tools([['get_customer_job_history', { query: 'bathroom remodel', limit: 20 }]], 'claude-sonnet-5-5'),
  (_p, { lastToolResults }) => {
    const jobs = lastToolResults[0]!.body.jobs;
    const j = jobs.find((x: any) => /tub\/shower/.test(x.title)) ?? jobs[0];
    let lines = j.lines.map((l: any) => ({ item_id: l.item_id, quantity: Number(l.qty), unit_price: Number(l.unit_price), basis: `as in job ${j.job_id}` }));
    if (mutate) lines = mutate(lines);
    return reply.tools([['submit_estimate', { title: 'Bathroom remodel - tub/shower combo', lines, assumptions: ['Standard tile, sized like the median comparable'], comparable_job_ids: [j.job_id], confidence: 'medium' }]], 'claude-sonnet-5-5');
  },
];

describe('Estimator A2A server', () => {
  it('publishes an Agent Card with its skill, transport and Bearer auth', async () => {
    const card: any = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    expect(card.name).toBe('Contractor Ops Estimator');
    expect(card.skills[0].id).toBe('estimate-remodel-job');
    expect(card.supportedInterfaces[0]).toMatchObject({ protocolBinding: 'JSONRPC', url: `${base}/a2a/jsonrpc` });
    expect(JSON.stringify(card.securitySchemes)).toMatch(/bearer/i);
  });

  it('rejects calls without a valid key', async () => {
    await expect(a2aEstimateDelegate(base)('cok_00000000_' + 'a'.repeat(43), { description: 'bathroom' })).rejects.toThrow();
  });

  it('returns a grounded estimate artifact; arithmetic done in code; never offered a write tool', async () => {
    estLlm.queue(...searchThenSubmit());
    const d = await a2aEstimateDelegate(base)(w.writeKey, { description: 'Bathroom remodel for Mark Johnson', parent_run_id: undefined });
    expect(d.estimate.lines.length).toBeGreaterThan(5);
    const sum = d.estimate.lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
    expect(d.estimate.subtotal).toBe((sum / 100).toFixed(2));
    for (const l of d.estimate.lines) expect(Number(l.amount)).toBeCloseTo(l.quantity * Number(l.unit_price), 2);

    const offered = (estLlm.calls.at(-1)!.tools ?? []).map((t: any) => t.name);
    expect(offered).toEqual(expect.arrayContaining(['get_customer_job_history', 'find_customer', 'submit_estimate']));
    expect(offered).not.toContain('create_estimate_draft');

    const run = await withTenant(w.db, w.tenantId, (tx) => tx.selectFrom('agent_runs').selectAll().where('id', '=', d.estimatorRunId!).executeTakeFirstOrThrow());
    expect(run).toMatchObject({ agent: 'estimator', status: 'completed', a2a_task_id: d.taskId });
  });

  it('a hallucinated item is bounced back to the model, which corrects it', async () => {
    let attempt = 0;
    estLlm.queue(
      ...searchThenSubmit((lines) => (attempt++ === 0 ? [...lines, { item_id: 'heated-floor-999', quantity: 1, unit_price: 1200, basis: 'upsell' }] : lines)),
      (p, { lastToolResults }) => {
        expect(lastToolResults[0]).toMatchObject({ isError: true, body: { error: { code: 'INVALID_ESTIMATE' } } });
        const prev = (p.messages.at(-2)!.content as any[]).find((b) => b.type === 'tool_use').input;
        return reply.tools([['submit_estimate', { ...prev, lines: prev.lines.filter((l: any) => l.item_id !== 'heated-floor-999') }]], 'claude-sonnet-5-5');
      },
    );
    const d = await a2aEstimateDelegate(base)(w.writeKey, { description: 'Bathroom remodel' });
    expect(d.estimate.lines.some((l) => l.item_id === 'heated-floor-999')).toBe(false);
  });

  it('persistent invention fails the task with a reason (no estimate reaches the Office Manager)', async () => {
    const bad = (_p: any) => reply.tools([['submit_estimate', { title: 'x x x', lines: [{ item_id: 'nope', quantity: 1, unit_price: 1, basis: 'made up' }], assumptions: ['none given'], comparable_job_ids: ['none'], confidence: 'low' }]], 'claude-sonnet-5-5');
    estLlm.queue(bad, bad, bad);
    const err = await a2aEstimateDelegate(base)(w.writeKey, { description: 'Bathroom remodel' }).catch((e) => e);
    expect(err).toBeInstanceOf(DelegationFailed);
    expect(err.state).toBe('TASK_STATE_FAILED');
    expect(err.message).toMatch(/rejected 3 times/);
  });

  it('A2A tasks are scoped to the caller\'s tenant', async () => {
    estLlm.queue(...searchThenSubmit());
    const d = await a2aEstimateDelegate(base)(w.writeKey, { description: 'Bathroom remodel' });
    const other = await makeTenant(w.db, 'a2a-other');
    try {
      const otherKey = (await createApiKey(w.owner, other, ['read'])).key;
      const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: (u, i = {}) => fetch(u, { ...i, headers: { ...(i.headers as any), Authorization: `Bearer ${otherKey}` } }) })] });
      const client = await factory.createFromUrl(base);
      await expect(client.getTask({ tenant: '', id: d.taskId } as never)).rejects.toThrow(/not found/i);
    } finally {
      await dropTenant(w.db, other);
    }
  });
});

describe('Office Manager delegates estimating over A2A', () => {
  it('find customer -> A2A estimate -> preview with the returned lines; costs linked across agents', async () => {
    const omLlm = new FakeLlm(() => 'estimate');
    estLlm.queue(...searchThenSubmit());
    let delegated: any;
    omLlm.queue(
      () => reply.tools([['find_customer', { query: 'Mark Johnson' }]], 'claude-sonnet-5-5'),
      (_p, { lastToolResults }) => reply.tools([['delegate_estimate', { job_description: 'Bathroom remodel', customer_id: lastToolResults[0]!.body.matches[0].customer_id }]], 'claude-sonnet-5-5'),
      (_p, { lastToolResults }) => {
        delegated = lastToolResults[0]!.body;
        expect(lastToolResults[0]!.isError).toBe(false);
        return reply.tools([['create_estimate_draft', {
          customer_id: delegated.customer_id, title: delegated.title,
          lines: delegated.lines.map((l: any) => ({ item_id: l.item_id, quantity: l.quantity, unit_price: Number(l.unit_price) })),
        }]], 'claude-sonnet-5-5');
      },
      (_p, { lastToolResults }) => {
        expect(lastToolResults[0]!.body.preview.subtotal).toBe(delegated.subtotal);
        return reply.text(`Draft ready: $${delegated.subtotal}. Create it?`, 'claude-sonnet-5-5');
      },
    );
    const r = await runTurn(
      { db: w.db, llm: omLlm, prices: w.prices, toolbox: (k) => connectToolbox(w.mcpUrl, k), delegate: a2aEstimateDelegate(base), log: w.silent },
      { tenantId: w.tenantId, apiKey: w.writeKey, message: 'Draft an estimate for the Mark Johnson bathroom remodel' },
    );
    expect(r.status).toBe('completed');
    expect(r.steps.map((s) => `${s.kind}:${s.name}`)).toContain('a2a:estimator.estimate-remodel-job');

    // One query gives the full cost of the request across both agents.
    const cost = await withTenant(w.db, w.tenantId, (tx) =>
      sql<{ runs: number; agents: string; total: string }>`
        SELECT count(*)::int AS runs, string_agg(DISTINCT agent::text, ',' ORDER BY agent::text) AS agents, sum(total_cost_usd)::text AS total
          FROM agent_runs WHERE id = ${r.runId} OR parent_run_id = ${r.runId}`.execute(tx),
    );
    expect(cost.rows[0]).toMatchObject({ runs: 2, agents: 'estimator,office_manager' });
    expect(Number(cost.rows[0]!.total)).toBeGreaterThan(r.costUsd);
  });
});
