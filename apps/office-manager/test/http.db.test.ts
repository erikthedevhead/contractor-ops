import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem } from '@co/db';
import { connectToolbox } from '@co/agent';
import { FakeLlm, reply, setupWorld } from '../../../packages/agent/test/fixture';
import { createOfficeManagerApp } from '../src/app';

let w: Awaited<ReturnType<typeof setupWorld>>;
let llm: FakeLlm;
let server: Server;
let base: string;

beforeAll(async () => {
  w = await setupWorld();
  llm = new FakeLlm(() => 'smalltalk');
  const app = createOfficeManagerApp({ db: w.db, llm, prices: w.prices, toolbox: (k) => connectToolbox(w.mcpUrl, k), log: w.silent, rateLimitPerMinute: 4 });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  server.close();
  await w.teardown();
});

const chat = (body: unknown, key = w.writeKey) =>
  fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

describe('office manager HTTP API', () => {
  it('rejects a missing or invalid key', async () => {
    expect((await chat({ message: 'hi' }, 'nope')).status).toBe(401);
  });

  it('validates the body', async () => {
    expect((await chat({ message: '' })).status).toBe(400);
  });

  it('answers and keeps the conversation going', async () => {
    llm.queue(() => reply.text('Hello! Ask me about invoices, customers or estimates.'), () => reply.text('Sure.'));
    const r1: any = await (await chat({ message: "hi" })).json();
    expect(r1).toMatchObject({ status: 'completed', intent: 'smalltalk', reply: expect.stringMatching(/Hello/) });
    const r2: any = await (await chat({ message: 'thanks', conversation_id: r1.conversation_id })).json();
    expect(r2.conversation_id).toBe(r1.conversation_id);
    // The second call carried the first exchange as history.
    const last = llm.calls.at(-1)!;
    expect(last.messages.length).toBe(3);
  });

  it('reports usage and cost for the tenant', async () => {
    const u: any = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${w.readKey}` } })).json();
    expect(u.llm.length).toBeGreaterThan(0);
    expect(Number(u.spend.spent_usd)).toBeGreaterThan(0);
    expect(u.agent_runs.find((r: any) => r.status === 'completed').runs).toBeGreaterThanOrEqual(2);
  });

  it('rate-limits a runaway client per key', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      llm.queue(() => reply.text('ok'));
      statuses.push((await chat({ message: `msg ${i}` })).status);
    }
    expect(statuses).toContain(429);
  });

  it('returns 402 when the tenant is over its spend cap', async () => {
    await asSystem(w.db, 'test', (tx) => tx.updateTable('tenants').set({ monthly_spend_cap_usd: '0.000001' }).where('id', '=', w.tenantId).execute());
    const r = await chat({ message: 'who owes me?' }, w.readKey);
    expect(r.status).toBe(402);
  });
});
