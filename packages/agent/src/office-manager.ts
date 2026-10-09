import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { ContentBlock, ContentBlockParam, Message, MessageParam, ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { withTenant, type Db } from '@co/db';
import { logger as baseLogger, type Logger } from '@co/shared';
import { MODELS, type LlmClient } from './llm';
import type { PriceBook, TokenUsage } from './pricing';
import { route, type Intent, type Route } from './router';
import { reserveSpend, settleSpend, SpendCapExceeded } from './spend';
import { renderToolResult, type Toolbox } from './toolbox';

/**
 * The Office Manager agent. No framework: one loop, every step written to
 * agent_steps (llm | tool | guard), every model call to llm_calls with its
 * cost, every call pre-authorized against the tenant's monthly spend cap.
 *
 *   route (fast model) -> [model call -> tool calls]* -> answer
 */

export interface AgentDeps {
  db: Db;
  llm: LlmClient;
  prices: PriceBook;
  toolbox: (apiKey: string) => Promise<Toolbox>;
  log?: Logger;
}

export interface TurnInput {
  tenantId: string;
  apiKey: string;           // the caller's MCP key: the agent acts with the caller's scopes
  message: string;
  conversationId?: string;
  evalCaseId?: string;
  maxSteps?: number;
}

export interface StepSummary {
  kind: 'llm' | 'tool' | 'guard' | 'error';
  name: string;
  ok: boolean;
  ms: number;
  costUsd?: number;
}

export type TurnStatus = 'completed' | 'rejected_spend_cap' | 'failed' | 'max_steps';

export interface TurnResult {
  conversationId: string;
  runId: string;
  status: TurnStatus;
  reply: string;
  intent: Intent | null;
  model: string | null;
  costUsd: number;
  steps: StepSummary[];
  toolCalls: Array<{ name: string; input: Record<string, unknown>; isError: boolean; blocked?: boolean }>;
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_HISTORY_MESSAGES = 40;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS: Record<string, number> = { [MODELS.fast]: 4096, [MODELS.smart]: 8192 };

interface IssuedToken { token: string; run_id: string; issued_at: string }

export function systemPrompt(today: string): string {
  return `You are the office manager assistant for a small remodeling contractor. You answer questions about their QuickBooks data and draft estimates, using only the tools provided.

Today is ${today} (the contractor's local date).

Rules:
- Every number, name and date you state must come from a tool result in this conversation. Never estimate, round up, or invent figures. If the tools don't have the data, say so plainly.
- Resolve people to ids with find_customer before using a customer_id. If the result is ambiguous, ask which customer the user means; do not pick one.
- "Owes more than N days" means invoices more than N days past their due date: use get_ar_aging with overdue_more_than_days=N.
- Money: show dollars with two decimals and thousands separators. Keep answers short: lead with the answer, then the few supporting facts that matter.

Drafting estimates:
1. Find comparable past jobs with get_customer_job_history (query describing the job). Base line items, quantities and prices on those jobs; say which jobs you used.
2. Call create_estimate_draft WITHOUT a confirmation_token to get a preview. Nothing is written yet.
3. Show the user the preview (customer, line items, subtotal) and ask them to approve it.
4. Only in a LATER message, and only if the user explicitly approves, call create_estimate_draft with just the confirmation_token.
Never call create_estimate_draft with a confirmation_token in the same turn you produced the preview. The system blocks it anyway.

If a tool returns an error, read its code and hint: fix the call (e.g. look up the right id) or explain the problem to the user. Do not retry the same failing call more than once.`;
}

export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<TurnResult> {
  const { db, llm, prices } = deps;
  const log = deps.log ?? baseLogger;
  const { tenantId } = input;
  const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS);
  const maxSteps = input.maxSteps ?? 10;

  // --- conversation + run bookkeeping ---------------------------------------
  const conv = await withTenant(db, tenantId, async (tx) => {
    if (input.conversationId) {
      const c = await tx.selectFrom('conversations').selectAll().where('id', '=', input.conversationId).executeTakeFirst();
      if (c) return c;
    }
    return tx.insertInto('conversations').values({ tenant_id: tenantId, agent: 'office_manager' }).returningAll().executeTakeFirstOrThrow();
  });
  const history = conv.messages as unknown as MessageParam[];
  const issued = (conv.issued_tokens as unknown as IssuedToken[]).filter((t) => Date.now() - Date.parse(t.issued_at) < TOKEN_TTL_MS);

  const run = await withTenant(db, tenantId, (tx) =>
    tx.insertInto('agent_runs').values({
      tenant_id: tenantId, agent: 'office_manager', user_input: message, conversation_id: conv.id, eval_case_id: input.evalCaseId ?? null,
    }).returning('id').executeTakeFirstOrThrow(),
  );
  const runId = run.id;

  let stepNo = 0;
  let totalCost = 0;
  const steps: StepSummary[] = [];
  const toolCalls: TurnResult['toolCalls'] = [];

  const recordStep = async (kind: StepSummary['kind'], name: string, data: { input?: unknown; output?: unknown; error?: unknown; ms: number }) => {
    const n = ++stepNo;
    await withTenant(db, tenantId, (tx) =>
      tx.insertInto('agent_steps').values({
        tenant_id: tenantId, run_id: runId, step_no: n, kind, name,
        input: data.input === undefined ? null : JSON.stringify(data.input),
        output: data.output === undefined ? null : JSON.stringify(data.output),
        error: data.error === undefined ? null : JSON.stringify(data.error),
        latency_ms: data.ms,
      }).execute(),
    );
    return n;
  };

  /** Reserve -> call -> settle -> record. The only way this agent talks to a model. */
  const callModel = async (purpose: 'route' | 'answer', model: string, estInput: number, maxTokens: number, fn: () => Promise<{ usage: TokenUsage; stop: string | null; output: unknown; latencyMs: number }>) => {
    const reservation = await reserveSpend(db, tenantId, prices.worstCase(model, estInput, maxTokens));
    let cost = 0;
    try {
      const r = await fn();
      cost = prices.cost(model, r.usage);
      totalCost += cost;
      const n = await recordStep('llm', `${purpose}:${model}`, { output: r.output, ms: r.latencyMs });
      await withTenant(db, tenantId, (tx) =>
        tx.insertInto('llm_calls').values({
          tenant_id: tenantId, run_id: runId, step_no: n, agent: 'office_manager', model, purpose,
          input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
          cache_read_tokens: r.usage.cache_read_input_tokens ?? 0, cache_write_tokens: r.usage.cache_creation_input_tokens ?? 0,
          cost_usd: cost.toFixed(6), latency_ms: r.latencyMs, stop_reason: r.stop,
        }).execute(),
      );
      steps.push({ kind: 'llm', name: `${purpose}:${model}`, ok: true, ms: r.latencyMs, costUsd: cost });
    } finally {
      await settleSpend(db, reservation, cost);
    }
  };

  const finish = async (status: TurnStatus, reply: string, rt: Route | null, messages: MessageParam[] | null, newIssued: IssuedToken[]) => {
    await withTenant(db, tenantId, async (tx) => {
      if (messages) {
        await tx.updateTable('conversations').set({
          messages: JSON.stringify(trimHistory(messages)),
          issued_tokens: JSON.stringify(newIssued),
          updated_at: new Date(),
        }).where('id', '=', conv.id).execute();
      }
      await tx.updateTable('agent_runs').set({
        status, final_output: reply, total_cost_usd: totalCost.toFixed(6), finished_at: new Date(),
        intent: rt?.intent ?? null, model: rt?.model ?? null,
      }).where('id', '=', runId).execute();
    });
    log.info({ tenantId, runId, status, intent: rt?.intent, model: rt?.model, costUsd: totalCost, steps: steps.length }, 'agent turn finished');
    return { conversationId: conv.id, runId, status, reply, intent: rt?.intent ?? null, model: rt?.model ?? null, costUsd: totalCost, steps, toolCalls };
  };

  let toolbox: Toolbox | undefined;
  let rt: Route | null = null;
  try {
    // --- 1. route ----------------------------------------------------------
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    try {
      await callModel('route', MODELS.fast, Math.ceil(message.length / 3) + 600, 64, async () => {
        rt = await route(llm, message, { draftPending: issued.length > 0, previousAssistant: lastAssistant ? textOf(lastAssistant.content) : undefined });
        return { usage: rt.usage, stop: rt.stopReason, output: { intent: rt.intent, model: rt.model }, latencyMs: rt.latencyMs };
      });
    } catch (err) {
      if (err instanceof SpendCapExceeded) throw err;
      // Routing is an optimization, not a dependency. Fail closed: answer on the
      // fast model as a plain lookup, which can never unlock a write.
      log.warn({ tenantId, runId, err: String(err) }, 'router failed; falling back to lookup');
      await recordStep('guard', 'router_fallback', { error: { message: String(err) }, ms: 0 });
      rt = { intent: 'lookup', model: MODELS.fast, usage: { input_tokens: 0, output_tokens: 0 }, routerModel: MODELS.fast, latencyMs: 0, stopReason: null };
    }
    const r = rt as unknown as Route;
    let liveTokens = r.intent === 'reject_draft' ? [] : [...issued];

    // --- 2. tool loop --------------------------------------------------------
    toolbox = await deps.toolbox(input.apiKey);
    const today = await localToday(db, tenantId);
    const messages: MessageParam[] = [...history, { role: 'user', content: message }];
    const tokensBefore = new Set(liveTokens.map((t) => t.token));
    const issuedThisTurn: IssuedToken[] = [];

    for (let i = 0; i < maxSteps; i++) {
      let res!: Message;
      const params = {
        model: r.model,
        max_tokens: MAX_TOKENS[r.model] ?? 4096,
        system: systemPrompt(today),
        tools: toolbox.tools(),
        messages,
        cache_control: { type: 'ephemeral' as const },
        output_config: { effort: 'medium' as const },
        metadata: { user_id: createHash('sha256').update(tenantId).digest('hex').slice(0, 32) },
      };
      await callModel('answer', r.model, Math.ceil(JSON.stringify(params).length / 3), params.max_tokens, async () => {
        const started = performance.now();
        res = await llm.create(params);
        return {
          usage: res.usage, stop: res.stop_reason, latencyMs: Math.round(performance.now() - started),
          output: { stop_reason: res.stop_reason, text: textOf(res.content).slice(0, 2000), tool_uses: res.content.filter(isToolUse).map((b) => ({ name: b.name, input: b.input })) },
        };
      });
      messages.push({ role: 'assistant', content: res.content as ContentBlockParam[] });

      const uses = res.content.filter(isToolUse);
      if (res.stop_reason !== 'tool_use' || uses.length === 0) {
        const reply = textOf(res.content) || '(no answer)';
        return await finish('completed', reply, r, messages, [...liveTokens, ...issuedThisTurn]);
      }

      const results: ToolResultBlockParam[] = [];
      for (const use of uses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        const started = performance.now();

        // --- write guard: step 2 needs a draft shown in an EARLIER turn and an explicit approval now
        const token = use.name === 'create_estimate_draft' && typeof args.confirmation_token === 'string' ? args.confirmation_token : null;
        if (token && !(r.intent === 'approve_draft' && tokensBefore.has(token))) {
          const reason = r.intent !== 'approve_draft'
            ? 'The user has not approved a draft in this message.'
            : 'That token was not shown to the user in an earlier message.';
          const body = { error: { code: 'CONFIRMATION_REQUIRED', message: `${reason} Show the preview and wait for explicit approval.`, retryable: false } };
          await recordStep('guard', 'write_guard', { input: { tool: use.name, token, intent: r.intent }, output: body, ms: 0 });
          steps.push({ kind: 'guard', name: 'write_guard', ok: false, ms: 0 });
          toolCalls.push({ name: use.name, input: args, isError: true, blocked: true });
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify(body) });
          continue;
        }

        let out: { isError: boolean; body: unknown };
        try {
          out = await toolbox.call(use.name, args);
        } catch (err) {
          out = { isError: true, body: { error: { code: 'TOOL_UNAVAILABLE', message: 'The data service did not respond.', retryable: true } } };
          log.warn({ tenantId, runId, tool: use.name, err: String(err) }, 'tool call failed at transport level');
        }
        const ms = Math.round(performance.now() - started);
        await recordStep('tool', use.name, { input: args, output: out.isError ? undefined : out.body, error: out.isError ? out.body : undefined, ms });
        steps.push({ kind: 'tool', name: use.name, ok: !out.isError, ms });
        toolCalls.push({ name: use.name, input: args, isError: out.isError });

        if (use.name === 'create_estimate_draft' && !out.isError) {
          const b = out.body as { status?: string; confirmation_token?: string };
          if (b.status === 'preview' && b.confirmation_token) issuedThisTurn.push({ token: b.confirmation_token, run_id: runId, issued_at: new Date().toISOString() });
          if (b.status === 'created' && token) liveTokens = liveTokens.filter((t) => t.token !== token);
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: out.isError, content: renderToolResult(out.body) });
      }
      messages.push({ role: 'user', content: results });
    }
    return await finish('max_steps', 'I could not finish this within my step limit. Try asking a narrower question.', r, messages, [...liveTokens, ...issuedThisTurn]);
  } catch (err) {
    if (err instanceof SpendCapExceeded) {
      return await finish('rejected_spend_cap', `This account has reached its monthly AI budget ($${err.capUsd.toFixed(2)}). Questions will work again next month, or after the budget is raised.`, rt, null, issued);
    }
    log.error({ tenantId, runId, err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) }, 'agent turn failed');
    await recordStep('error', 'turn_failed', { error: { message: err instanceof Error ? err.message : String(err) }, ms: 0 }).catch(() => {});
    steps.push({ kind: 'error', name: 'turn_failed', ok: false, ms: 0 });
    return await finish('failed', 'Something went wrong while answering. The problem has been logged; please try again.', rt, null, issued);
  } finally {
    await toolbox?.close().catch(() => {});
  }
}

// --- helpers ------------------------------------------------------------------

const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use';

function textOf(content: MessageParam['content'] | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return (content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
}

/**
 * Keep the last N messages, cutting only at a plain user message so a
 * tool_use is never separated from its tool_result.
 */
export function trimHistory(messages: MessageParam[], max = MAX_HISTORY_MESSAGES): MessageParam[] {
  if (messages.length <= max) return messages;
  for (let i = messages.length - max; i < messages.length; i++) {
    const m = messages[i]!;
    const isPlainUser = m.role === 'user' && (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'));
    if (isPlainUser) return messages.slice(i);
  }
  return messages.slice(-2);
}

async function localToday(db: Db, tenantId: string): Promise<string> {
  const r = await withTenant(db, tenantId, (tx) =>
    sql<{ d: string }>`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM tenants WHERE id = ${tenantId}`.execute(tx),
  );
  return r.rows[0]?.d ?? new Date().toISOString().slice(0, 10);
}
