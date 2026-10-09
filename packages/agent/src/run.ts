import { withTenant, type Db } from '@co/db';
import type { PriceBook, TokenUsage } from './pricing';
import { reserveSpend, settleSpend } from './spend';

/**
 * One agent run's bookkeeping, shared by every agent: the agent_runs row,
 * numbered agent_steps, and model calls that are reserved against the spend
 * cap, priced, logged to llm_calls, and settled. Agents differ in their loops,
 * not in how they are metered.
 */
export type AgentKind = 'office_manager' | 'estimator';
export type StepKind = 'llm' | 'tool' | 'guard' | 'error' | 'a2a';

export interface StepSummary {
  kind: StepKind;
  name: string;
  ok: boolean;
  ms: number;
  costUsd?: number;
}

export interface RunOptions {
  conversationId?: string | null;
  parentRunId?: string | null;
  a2aTaskId?: string | null;
  evalCaseId?: string | null;
}

export class RunRecorder {
  private stepNo = 0;
  totalCost = 0;
  readonly steps: StepSummary[] = [];

  private constructor(
    private readonly db: Db,
    private readonly prices: PriceBook,
    readonly tenantId: string,
    readonly agent: AgentKind,
    readonly runId: string,
  ) {}

  static async start(db: Db, prices: PriceBook, tenantId: string, agent: AgentKind, userInput: string, opts: RunOptions = {}): Promise<RunRecorder> {
    const row = await withTenant(db, tenantId, (tx) =>
      tx.insertInto('agent_runs').values({
        tenant_id: tenantId, agent, user_input: userInput,
        conversation_id: opts.conversationId ?? null, parent_run_id: opts.parentRunId ?? null,
        a2a_task_id: opts.a2aTaskId ?? null, eval_case_id: opts.evalCaseId ?? null,
      }).returning('id').executeTakeFirstOrThrow(),
    );
    return new RunRecorder(db, prices, tenantId, agent, row.id);
  }

  async step(kind: StepKind, name: string, data: { input?: unknown; output?: unknown; error?: unknown; ms: number }, ok = data.error === undefined): Promise<number> {
    const n = ++this.stepNo;
    await withTenant(this.db, this.tenantId, (tx) =>
      tx.insertInto('agent_steps').values({
        tenant_id: this.tenantId, run_id: this.runId, step_no: n, kind, name,
        input: data.input === undefined ? null : JSON.stringify(data.input),
        output: data.output === undefined ? null : JSON.stringify(data.output),
        error: data.error === undefined ? null : JSON.stringify(data.error),
        latency_ms: data.ms,
      }).execute(),
    );
    if (kind !== 'llm') this.steps.push({ kind, name, ok, ms: data.ms });
    return n;
  }

  /** Reserve worst case -> call -> price -> record -> settle. The only way any agent talks to a model. */
  async model<T extends { usage: TokenUsage; stop: string | null; output: unknown; latencyMs: number }>(
    purpose: string, model: string, estInputTokens: number, maxTokens: number, fn: () => Promise<T>,
  ): Promise<T> {
    const reservation = await reserveSpend(this.db, this.tenantId, this.prices.worstCase(model, estInputTokens, maxTokens));
    let cost = 0;
    try {
      const r = await fn();
      cost = this.prices.cost(model, r.usage);
      this.totalCost += cost;
      const n = await this.step('llm', `${purpose}:${model}`, { output: r.output, ms: r.latencyMs });
      await withTenant(this.db, this.tenantId, (tx) =>
        tx.insertInto('llm_calls').values({
          tenant_id: this.tenantId, run_id: this.runId, step_no: n, agent: this.agent, model, purpose,
          input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
          cache_read_tokens: r.usage.cache_read_input_tokens ?? 0, cache_write_tokens: r.usage.cache_creation_input_tokens ?? 0,
          cost_usd: cost.toFixed(6), latency_ms: r.latencyMs, stop_reason: r.stop,
        }).execute(),
      );
      this.steps.push({ kind: 'llm', name: `${purpose}:${model}`, ok: true, ms: r.latencyMs, costUsd: cost });
      return r;
    } finally {
      await settleSpend(this.db, reservation, cost);
    }
  }

  async finish(status: string, finalOutput: string, extra: { intent?: string | null; model?: string | null } = {}): Promise<void> {
    await withTenant(this.db, this.tenantId, (tx) =>
      tx.updateTable('agent_runs').set({
        status, final_output: finalOutput, total_cost_usd: this.totalCost.toFixed(6), finished_at: new Date(),
        ...(extra.intent !== undefined ? { intent: extra.intent } : {}),
        ...(extra.model !== undefined ? { model: extra.model } : {}),
      }).where('id', '=', this.runId).execute(),
    );
  }
}
