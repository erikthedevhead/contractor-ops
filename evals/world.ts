/**
 * The eval world: hermetic, deterministic data with REAL models.
 *
 * Two tenants seeded from the same plan into in-process fake QuickBooks
 * instances, each with "today" frozen at the seed anchor so date-relative
 * answers are stable:
 *   - read:  never written to. Any QuickBooks write here fails the run.
 *   - write: for cases that create estimates and for fault injection.
 * Real HTTP throughout: MCP server, Estimator (A2A), Office Manager loop.
 * Only QuickBooks is simulated, so ground truth is exact.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { a2aEstimateDelegate, connectToolbox, PriceBook, type AgentDeps, type LlmClient } from '@co/agent';
import { asSystem, createDb, type Db } from '@co/db';
import { initialSync, QboClient, TokenStore } from '@co/qbo';
import { Worker } from '@co/worker';
import { createApp } from '../apps/api/src/app';
import { createEstimatorApp } from '../apps/estimator/src/server';
import { createApiKey } from '../apps/mcp/src/keys';
import { mcpRouter } from '../apps/mcp/src/server';
import { FakeQbo } from '../packages/qbo/test/fake-qbo';
import { buildPlan, type SeedPlan } from '../scripts/seed/catalog';
import { runSeed } from '../scripts/seed/run';

export const ANCHOR = '2026-10-08';
const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return silent; } } as never;

export interface EvalTenant {
  name: 'read' | 'write';
  tenantId: string;
  realmId: string;
  apiKey: string;
  fake: FakeQbo;
}

export interface EvalWorld {
  db: Db;
  plan: SeedPlan;
  read: EvalTenant;
  write: EvalTenant;
  tokens: TokenStore;
  clientFor: (tenantId: string) => QboClient;
  agentDeps: (llm: LlmClient) => AgentDeps;
  worker: Worker;
  mcpUrl: string;
  estimatorUrl: string;
  close(): Promise<void>;
}

async function listen(handler: Parameters<typeof createServer>[1] | ((base: string) => Parameters<typeof createServer>[1])): Promise<{ server: Server; base: string }> {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', typeof handler === 'function' && handler.length === 1 ? (handler as (b: string) => never)(base) : (handler as never));
  return { server, base };
}

export async function setupEvalWorld(opts: { databaseUrl: string; ownerUrl: string; capUsd?: number; label?: string; deleteOnClose?: boolean }): Promise<EvalWorld> {
  const db = createDb(opts.databaseUrl, { max: 10 });
  const owner = createDb(opts.ownerUrl, { max: 2 });
  // Keep the previous run's tenants (and so its agent traces) until a new run
  // starts. First eval run: deleting on close cascaded away the traces needed
  // to diagnose its failures.
  if (!opts.deleteOnClose) await db.deleteFrom('tenants').where('name', 'like', 'eval-%').where('name', 'not like', '%harness-test%').execute();
  const plan = buildPlan(ANCHOR);
  const app = { environment: 'sandbox' as const, clientId: 'eval-client-0000', clientSecret: 'eval-secret-0000', redirectUri: 'http://eval/cb' };
  const fakes = new Map<string, FakeQbo>();
  // Token refreshes go to the fake's token endpoint, so token-expiry faults are real code paths.
  const tokens = new TokenStore({ db, ring: { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 }, app, log: silent, fetchFn: (u, i) => fakeFor(u, i) });
  let currentTokenFake: FakeQbo | null = null;
  const fakeFor = (u: string, i?: RequestInit) => (currentTokenFake ?? [...fakes.values()][0]!).fetch(u, i);
  const clientFor = (tenantId: string) => {
    const fake = fakes.get(tenantId);
    if (!fake) throw new Error(`no fake QuickBooks for tenant ${tenantId}`);
    return new QboClient(tenantId, {
      tokens,
      meter: () => {},
      fetchFn: (u, i) => { currentTokenFake = fake; return fake.fetch(u, i); },
      sleep: async () => {},
      log: silent,
    });
  };

  const makeTenant = async (name: 'read' | 'write'): Promise<EvalTenant> => {
    const row = await db.insertInto('tenants').values({ name: `eval-${name}-${opts.label ?? Date.now()}`, monthly_spend_cap_usd: String(opts.capUsd ?? 10) }).returning('id').executeTakeFirstOrThrow();
    await asSystem(db, 'eval world setup', (tx) => tx.updateTable('tenants').set({ frozen_today: ANCHOR }).where('id', '=', row.id).execute());
    const fake = new FakeQbo();
    fakes.set(row.id, fake);
    const realmId = `eval${name}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await tokens.saveConnection(row.id, realmId, { accessToken: 'eval-access-0', refreshToken: 'eval-refresh-0', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: null, responseKeys: [] });
    await runSeed({ db, client: clientFor(row.id), tenantId: row.id, anchor: ANCHOR, writeSpacingMs: 0, manifestPath: null, log: () => {} });
    await initialSync(db, clientFor(row.id), { log: silent });
    const apiKey = (await createApiKey(owner, row.id, ['read', 'write:estimate'], `eval ${name}`)).key;
    fake.requests.length = 0; // start counting writes after setup
    return { name, tenantId: row.id, realmId, apiKey, fake };
  };

  const read = await makeTenant('read');
  const write = await makeTenant('write');

  const core = await listen(createApp({ db, tokens, qbo: app, connectLinkSecret: 'ab'.repeat(32), webhookVerifier: 'eval-verifier', mcp: mcpRouter({ db, clientFor, log: silent }), log: silent }));
  const mcpUrl = `${core.base}/mcp`;
  const prices = await PriceBook.load(db);
  let estimatorLlm: LlmClient | null = null;
  const est = await listen((base: string) => createEstimatorApp({
    db, prices, publicUrl: base, log: silent,
    llm: { create: (p) => { if (!estimatorLlm) throw new Error('estimator llm not set'); return estimatorLlm.create(p); } },
    toolbox: (k) => connectToolbox(mcpUrl, k, 'estimator'),
  }));

  return {
    db, plan, read, write, tokens, clientFor, mcpUrl, estimatorUrl: est.base,
    worker: new Worker({ db, clientFor, log: silent }),
    agentDeps: (llm) => {
      estimatorLlm = llm; // both agents use the same (real) model client
      return { db, llm, prices, toolbox: (k) => connectToolbox(mcpUrl, k, 'office-manager'), delegate: a2aEstimateDelegate(est.base), log: silent };
    },
    async close() {
      core.server.close();
      est.server.close();
      if (opts.deleteOnClose) for (const t of [read, write]) await db.deleteFrom('tenants').where('id', '=', t.tenantId).execute().catch(() => {});
      await db.destroy();
      await owner.destroy();
    },
  };
}
