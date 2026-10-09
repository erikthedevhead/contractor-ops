import * as z from 'zod';
import type { ContentBlock, ContentBlockParam, Message, MessageParam, Tool, ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { Db } from '@co/db';
import { logger as baseLogger, type Logger } from '@co/shared';
import { MODELS, type LlmClient } from './llm';
import type { PriceBook } from './pricing';
import { RunRecorder } from './run';
import { renderToolResult, type Toolbox } from './toolbox';

/**
 * The Estimator agent. Given a job description, it finds comparable past jobs
 * and proposes a sized estimate: line items, quantities, prices, and the
 * assumptions behind them.
 *
 * Grounding rules enforced in code, not just in the prompt:
 * - it can only READ (no write tool is ever exposed to it)
 * - every item id and unit price must come from a comparable job it actually
 *   retrieved in this run; invented items or prices are rejected back to it
 * - line amounts and the subtotal are computed here, never taken from the model
 */

export const ESTIMATOR_READ_TOOLS = ['find_customer', 'get_customer_job_history'] as const;

export interface EstimateRequest {
  description: string;
  customer_id?: string;
}

export interface EstimateLine {
  item_id: string;
  item_name: string;
  quantity: number;
  unit_price: string;
  amount: string;
  basis: string;
}

export interface ProposedEstimate {
  customer_id: string | null;
  title: string;
  lines: EstimateLine[];
  subtotal: string;
  assumptions: string[];
  comparable_jobs: Array<{ job_id: string; customer_name: string; title: string | null; total: string | null }>;
  confidence: 'high' | 'medium' | 'low';
}

export interface EstimatorDeps {
  db: Db;
  llm: LlmClient;
  prices: PriceBook;
  log?: Logger;
}

const SubmitInput = z.object({
  title: z.string().min(3).max(200),
  lines: z.array(z.object({
    item_id: z.string().min(1),
    quantity: z.number().positive(),
    unit_price: z.number().min(0),
    basis: z.string().min(3).max(300),
  })).min(1).max(30),
  assumptions: z.array(z.string().min(3).max(300)).min(1).max(10),
  comparable_job_ids: z.array(z.string()).min(1).max(10),
  confidence: z.enum(['high', 'medium', 'low']),
});

const SUBMIT_TOOL: Tool = {
  name: 'submit_estimate',
  description: 'Submit the proposed estimate. Item ids and unit prices must come from comparable jobs you retrieved. Amounts are calculated for you.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Job title for the customer, e.g. "Full bathroom remodel - tub/shower combo, standard tile"' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_id: { type: 'string' },
            quantity: { type: 'number' },
            unit_price: { type: 'number' },
            basis: { type: 'string', description: 'Why this quantity/price, citing the comparable jobs' },
          },
          required: ['item_id', 'quantity', 'unit_price', 'basis'],
        },
      },
      assumptions: { type: 'array', items: { type: 'string' }, description: 'Assumptions the contractor should confirm (size, finish level, scope)' },
      comparable_job_ids: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['title', 'lines', 'assumptions', 'comparable_job_ids', 'confidence'],
  },
};

export const ESTIMATOR_SYSTEM = `You are an estimator for a small remodeling contractor. You size and price new jobs from the contractor's own past jobs.

Process:
1. Call get_customer_job_history with a query describing the job (e.g. "bathroom remodel walk-in shower") and limit 15-25 to see enough comparables. If the result says truncated, narrow or raise the limit.
2. Pick the 2-5 jobs most similar in type, size and finish level. Prefer completed (invoiced) jobs.
3. Propose a sized default: when the request doesn't state size or finish level, choose the most typical comparable (the median, not the largest) and say so in assumptions. Do not ask questions; state assumptions instead.
4. Use only item ids and unit prices that appear in those comparable jobs. Quantities may be scaled to the described job; explain the basis.
5. Call submit_estimate exactly once with the result.`;

const MAX_STEPS = 8;
const MAX_SUBMIT_ATTEMPTS = 3;

export class EstimatorFailed extends Error {}

export async function runEstimator(
  deps: EstimatorDeps,
  toolbox: Toolbox,
  tenantId: string,
  req: EstimateRequest,
  opts: { parentRunId?: string | null; a2aTaskId?: string | null; evalCaseId?: string | null } = {},
): Promise<{ runId: string; estimate: ProposedEstimate; costUsd: number }> {
  const log = deps.log ?? baseLogger;
  const rec = await RunRecorder.start(deps.db, deps.prices, tenantId, 'estimator', req.description, opts);
  const model = MODELS.smart;

  // Everything the estimator has actually seen: the grounding set for validation.
  const seenJobs = new Map<string, { customer_name: string; title: string | null; total: string | null }>();
  const seenPrices = new Map<string, { name: string; prices: Set<number> }>();
  const absorb = (body: unknown) => {
    for (const j of (body as { jobs?: any[] })?.jobs ?? []) {
      seenJobs.set(String(j.job_id), { customer_name: j.customer_name, title: j.title ?? null, total: j.invoiced_total ?? j.estimate_total ?? null });
      for (const l of j.lines ?? []) {
        if (!l.item_id || l.unit_price === null) continue;
        const e = seenPrices.get(l.item_id) ?? { name: l.item_name ?? l.item_id, prices: new Set<number>() };
        e.prices.add(Number(l.unit_price));
        seenPrices.set(l.item_id, e);
      }
    }
  };

  const tools: Tool[] = [...toolbox.tools().filter((t) => (ESTIMATOR_READ_TOOLS as readonly string[]).includes(t.name)), SUBMIT_TOOL];
  const messages: MessageParam[] = [{
    role: 'user',
    content: `Job to estimate: ${req.description}${req.customer_id ? `\nCustomer id: ${req.customer_id}` : ''}`,
  }];

  let submitAttempts = 0;
  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      const params = { model, max_tokens: 8192, system: ESTIMATOR_SYSTEM, tools, messages, cache_control: { type: 'ephemeral' as const }, output_config: { effort: 'medium' as const } };
      let res!: Message;
      await rec.model('estimate', model, Math.ceil(JSON.stringify(params).length / 3), params.max_tokens, async () => {
        const started = performance.now();
        res = await deps.llm.create(params);
        return { usage: res.usage, stop: res.stop_reason, latencyMs: Math.round(performance.now() - started), output: { stop_reason: res.stop_reason, tool_uses: res.content.filter(isToolUse).map((b) => ({ name: b.name })) } };
      });
      messages.push({ role: 'assistant', content: res.content as ContentBlockParam[] });
      const uses = res.content.filter(isToolUse);
      if (uses.length === 0) throw new EstimatorFailed('the estimator stopped without submitting an estimate');

      const results: ToolResultBlockParam[] = [];
      for (const use of uses) {
        const started = performance.now();
        if (use.name === 'submit_estimate') {
          submitAttempts++;
          const v = validateSubmission(use.input, seenJobs, seenPrices, req.customer_id ?? null);
          await rec.step('tool', 'submit_estimate', { input: use.input, output: v.ok ? v.estimate : undefined, error: v.ok ? undefined : v.errors, ms: Math.round(performance.now() - started) });
          if (v.ok) {
            await rec.finish('completed', JSON.stringify(v.estimate), { model });
            log.info({ tenantId, runId: rec.runId, parentRunId: opts.parentRunId, lines: v.estimate.lines.length, subtotal: v.estimate.subtotal, costUsd: rec.totalCost }, 'estimate proposed');
            return { runId: rec.runId, estimate: v.estimate, costUsd: rec.totalCost };
          }
          if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) throw new EstimatorFailed(`submission rejected ${submitAttempts} times: ${v.errors.join('; ')}`);
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: { code: 'INVALID_ESTIMATE', problems: v.errors } }) });
          continue;
        }
        if (!(ESTIMATOR_READ_TOOLS as readonly string[]).includes(use.name)) {
          // Defense in depth: a tool it was never offered.
          await rec.step('guard', 'tool_not_allowed', { input: { tool: use.name }, error: { code: 'NOT_ALLOWED' }, ms: 0 });
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: { code: 'NOT_ALLOWED', message: 'The estimator can only read.' } }) });
          continue;
        }
        const out = await toolbox.call(use.name, (use.input ?? {}) as Record<string, unknown>);
        if (!out.isError && use.name === 'get_customer_job_history') absorb(out.body);
        await rec.step('tool', use.name, { input: use.input, output: out.isError ? undefined : { count: (out.body as any)?.count }, error: out.isError ? out.body : undefined, ms: Math.round(performance.now() - started) });
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: out.isError, content: renderToolResult(out.body) });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new EstimatorFailed('step limit reached without a valid estimate');
  } catch (err) {
    await rec.step('error', 'estimator_failed', { error: { message: err instanceof Error ? err.message : String(err) }, ms: 0 }).catch(() => {});
    await rec.finish(err instanceof Error && err.name === 'SpendCapExceeded' ? 'rejected_spend_cap' : 'failed', err instanceof Error ? err.message : String(err), { model });
    throw err;
  }
}

type Validation = { ok: true; estimate: ProposedEstimate } | { ok: false; errors: string[] };

export function validateSubmission(
  input: unknown,
  seenJobs: Map<string, { customer_name: string; title: string | null; total: string | null }>,
  seenPrices: Map<string, { name: string; prices: Set<number> }>,
  customerId: string | null,
): Validation {
  const parsed = SubmitInput.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const s = parsed.data;
  const errors: string[] = [];
  for (const [idx, l] of s.lines.entries()) {
    const seen = seenPrices.get(l.item_id);
    if (!seen) errors.push(`line ${idx + 1}: item ${l.item_id} does not appear in any comparable job you retrieved`);
    else if (![...seen.prices].some((p) => Math.abs(p - l.unit_price) < 0.005)) {
      errors.push(`line ${idx + 1}: unit_price ${l.unit_price} for "${seen.name}" is not a price from the comparable jobs (seen: ${[...seen.prices].join(', ')})`);
    }
  }
  for (const id of s.comparable_job_ids) if (!seenJobs.has(id)) errors.push(`comparable job ${id} was not in your results`);
  if (errors.length) return { ok: false, errors };

  // Arithmetic is code's job.
  const lines: EstimateLine[] = s.lines.map((l) => {
    const cents = Math.round(l.quantity * l.unit_price * 100);
    return { item_id: l.item_id, item_name: seenPrices.get(l.item_id)!.name, quantity: l.quantity, unit_price: l.unit_price.toFixed(2), amount: (cents / 100).toFixed(2), basis: l.basis };
  });
  const subtotal = lines.reduce((sum, l) => sum + Math.round(Number(l.amount) * 100), 0);
  return {
    ok: true,
    estimate: {
      customer_id: customerId,
      title: s.title,
      lines,
      subtotal: (subtotal / 100).toFixed(2),
      assumptions: s.assumptions,
      comparable_jobs: s.comparable_job_ids.map((id) => ({ job_id: id, ...seenJobs.get(id)! })),
      confidence: s.confidence,
    },
  };
}

const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use';
