import { sql } from 'kysely';
import { runTurn, type LlmClient, type TurnResult } from '@co/agent';
import { withTenant } from '@co/db';
import type { FailureMode } from './checks';
import type { CaseContext, Category, EvalCase } from './cases';
import type { EvalWorld } from './world';

export interface CaseRunResult {
  caseId: string;
  category: Category;
  iteration: number;
  pass: boolean;
  failureMode: FailureMode | null;
  detail: string;
  toolsOk: boolean | null;     // null when the case declares no expected tools
  costUsd: number;             // all agents, including delegated Estimator runs
  latencyMs: number;
  runIds: string[];
  toolCalls: string[];
}

export interface RunOptions {
  world: EvalWorld;
  llm: LlmClient;
  cases: EvalCase[];
  iterations: number;
  concurrency: number;         // for read-world cases; write-world cases always run one at a time
  onResult?: (r: CaseRunResult) => void;
}

export async function runEval(opts: RunOptions): Promise<CaseRunResult[]> {
  const jobs = opts.cases.flatMap((c) => Array.from({ length: opts.iterations }, (_, i) => ({ c, i: i + 1 })));
  const readJobs = jobs.filter((j) => j.c.world === 'read');
  const writeJobs = jobs.filter((j) => j.c.world === 'write');
  const results: CaseRunResult[] = [];
  const record = (r: CaseRunResult) => {
    results.push(r);
    opts.onResult?.(r);
  };

  // Read cases in parallel; write/fault cases serially (they inject faults into shared fakes).
  const pool = async (items: typeof jobs, n: number) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) {
        const { c, i } = items[next++]!;
        record(await runOne(opts, c, i));
      }
    }));
  };
  await Promise.all([pool(readJobs, opts.concurrency), pool(writeJobs, 1)]);
  return results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.iteration - b.iteration);
}

async function runOne(opts: RunOptions, c: EvalCase, iteration: number): Promise<CaseRunResult> {
  const { world } = opts;
  const tenant = world[c.world];
  const turns: TurnResult[] = [];
  let conversationId: string | undefined;
  const deps = world.agentDeps(opts.llm);

  const ctx: CaseContext = {
    world,
    tenant,
    turns,
    async say(message) {
      const t = await runTurn(deps, { tenantId: tenant.tenantId, apiKey: tenant.apiKey, message, conversationId, evalCaseId: `${c.id}#${iteration}` });
      conversationId = t.conversationId;
      turns.push(t);
      return t;
    },
    estimatesCreated: () => tenant.fake.all('Estimate').length,
    async toolOutput(runId, tool) {
      const r = await withTenant(world.db, tenant.tenantId, (tx) =>
        tx.selectFrom('agent_steps').select('output').where('run_id', '=', runId).where('kind', '=', 'tool').where('name', '=', tool)
          .orderBy('step_no', 'desc').limit(1).executeTakeFirst());
      return r?.output ?? null;
    },
  };

  const started = performance.now();
  let pass = false;
  let failureMode: FailureMode | null = null;
  let detail = '';
  try {
    const r = await c.run(ctx);
    pass = r.pass;
    failureMode = r.pass ? null : (r.failureMode ?? 'agent_error');
    detail = r.detail;
  } catch (err) {
    failureMode = 'agent_error';
    detail = `case threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }
  const latencyMs = Math.round(performance.now() - started);
  const runIds = turns.map((t) => t.runId);
  const toolCalls = turns.flatMap((t) => t.toolCalls.map((tc) => (tc.blocked ? `${tc.name}(blocked)` : tc.name)));

  return {
    caseId: c.id,
    category: c.category,
    iteration,
    pass,
    failureMode,
    detail,
    toolsOk: c.expectTools ? toolsMatch(c.expectTools, turns) : null,
    costUsd: await costOf(world, tenant.tenantId, runIds),
    latencyMs,
    runIds,
    toolCalls,
  };
}

/** Every expected tool was called at least once with (at least) the expected args. */
export function toolsMatch(expected: NonNullable<EvalCase['expectTools']>, turns: TurnResult[]): boolean {
  const calls = turns.flatMap((t) => t.toolCalls);
  return expected.every((e) =>
    calls.some((c) => c.name === e.name && Object.entries(e.args ?? {}).every(([k, v]) => JSON.stringify(c.input[k]) === JSON.stringify(v))),
  );
}

async function costOf(world: EvalWorld, tenantId: string, runIds: string[]): Promise<number> {
  if (!runIds.length) return 0;
  const r = await withTenant(world.db, tenantId, (tx) =>
    sql<{ total: string | null }>`SELECT sum(total_cost_usd)::text AS total FROM agent_runs
      WHERE id = ANY(${runIds}::uuid[]) OR parent_run_id = ANY(${runIds}::uuid[])`.execute(tx));
  return Number(r.rows[0]?.total ?? 0);
}

/** Persist a run in eval_runs / eval_results (dev tooling tables, no RLS). */
export async function saveRun(world: EvalWorld, meta: { gitSha: string; config: Record<string, unknown> }, results: CaseRunResult[], cases: EvalCase[], summary: unknown): Promise<string> {
  const run = await world.db.insertInto('eval_runs').values({ git_sha: meta.gitSha, config: JSON.stringify(meta.config), summary: JSON.stringify(summary), finished_at: new Date() }).returning('id').executeTakeFirstOrThrow();
  const byId = new Map(cases.map((c) => [c.id, c]));
  if (results.length) {
    await world.db.insertInto('eval_results').values(results.map((r) => ({
      run_id: run.id,
      case_id: r.caseId,
      iteration: r.iteration,
      category: r.category,
      passed: r.pass,
      score: r.pass ? '1' : '0',
      failure_mode: r.failureMode,
      expected: JSON.stringify({ description: byId.get(r.caseId)?.description, tools: byId.get(r.caseId)?.expectTools ?? null }),
      actual: JSON.stringify({ detail: r.detail, tools_ok: r.toolsOk, tool_calls: r.toolCalls }),
      tool_calls: JSON.stringify(r.toolCalls),
      cost_usd: r.costUsd.toFixed(6),
      latency_ms: r.latencyMs,
      agent_run_id: r.runIds[0] ?? null,
    }))).execute();
  }
  return run.id;
}
