import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { ContentBlock, ContentBlockParam, Message, MessageParam, Tool, ToolResultBlockParam, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import { withTenant, type Db } from '@co/db';
import { logger as baseLogger, type Logger } from '@co/shared';
import { DelegationFailed, type EstimateDelegate } from './a2a-client';
import { MODELS, type LlmClient } from './llm';
import type { PriceBook } from './pricing';
import { route, type Intent, type Route } from './router';
import { RunRecorder, type StepSummary } from './run';
import { SpendCapExceeded } from './spend';
import { renderToolResult, type Toolbox } from './toolbox';

/**
 * The Office Manager agent. No framework: one loop, every step written to
 * agent_steps (llm | tool | a2a | guard | error), every model call metered
 * and pre-authorized against the tenant's spend cap (see RunRecorder).
 *
 *   route (fast model) -> [model call -> tool calls | A2A delegation]* -> answer
 *
 * MCP for agent-to-tool (its data tools), A2A for agent-to-agent (estimating
 * is delegated to the Estimator agent, a separate service).
 */

export interface AgentDeps {
  db: Db;
  llm: LlmClient;
  prices: PriceBook;
  toolbox: (apiKey: string) => Promise<Toolbox>;
  /** A2A delegation to the Estimator. When absent, the Office Manager drafts estimates itself. */
  delegate?: EstimateDelegate;
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

export const DELEGATE_TOOL: Tool = {
  name: 'delegate_estimate',
  description: 'Ask the Estimator agent (via A2A) to size and price a job from comparable past jobs. Returns line items with item ids, quantities, prices, the comparable jobs used, and assumptions. Nothing is written.',
  input_schema: {
    type: 'object',
    properties: {
      job_description: { type: 'string', description: 'What the job is, with any size/finish details the user gave' },
      customer_id: { type: 'string', description: 'From find_customer, if known' },
    },
    required: ['job_description'],
  },
};

export function systemPrompt(today: string, opts: { delegation: boolean } = { delegation: false }): string {
  const drafting = opts.delegation
    ? `Drafting estimates:
1. Resolve the customer with find_customer (ask if ambiguous).
2. Call delegate_estimate with the job description and customer_id. The Estimator agent returns sized line items and its assumptions.
3. Call create_estimate_draft WITHOUT a confirmation_token, using exactly the returned item ids, quantities and unit prices (adjust only what the user asked to change). Nothing is written yet.
4. Show the user the preview (line items, subtotal) and the Estimator's assumptions, and ask them to approve.
5. Only in a LATER message, and only if the user explicitly approves, call create_estimate_draft with just the confirmation_token.`
    : `Drafting estimates:
1. Find comparable past jobs with get_customer_job_history (query describing the job). Base line items, quantities and prices on those jobs; say which jobs you used.
2. Call create_estimate_draft WITHOUT a confirmation_token to get a preview. Nothing is written yet.
3. Show the user the preview (customer, line items, subtotal) and ask them to approve it.
4. Only in a LATER message, and only if the user explicitly approves, call create_estimate_draft with just the confirmation_token.`;
  return `You are the office manager assistant for a small remodeling contractor. You answer questions about their QuickBooks data and draft estimates, using only the tools provided.

Today is ${today} (the contractor's local date).

Rules:
- Every number, name and date you state must come from a tool result in this conversation. Never estimate, round up, or invent figures. If the tools don't have the data, say so plainly.
- Resolve people to ids with find_customer before using a customer_id. If the result is ambiguous, ask which customer the user means; do not pick one.
- "Owes more than N days" means invoices more than N days past their due date: use get_ar_aging with overdue_more_than_days=N.
- If a tool result says it is truncated, don't describe it as complete.
- Refer to invoices and estimates by their doc_number (e.g. "estimate #1041"), never by internal ids.
- Money: show dollars with two decimals and thousands separators. Keep answers short: lead with the answer, then the few supporting facts that matter.

${drafting}
Never call create_estimate_draft with a confirmation_token in the same turn you produced the preview. The system blocks it anyway.
If you raised a concern with the preview (for example a possible duplicate) and the user then explicitly approves, that is their decision: create it. Do not ask for approval a second time.

If a tool returns an error, read its code and hint: fix the call (e.g. look up the right id) or explain the problem to the user. Do not retry the same failing call more than once.`;
}

export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<TurnResult> {
  const { db, llm } = deps;
  const log = deps.log ?? baseLogger;
  const { tenantId } = input;
  const message = input.message.trim().slice(0, MAX_MESSAGE_CHARS);
  const maxSteps = input.maxSteps ?? 10;

  const conv = await withTenant(db, tenantId, async (tx) => {
    if (input.conversationId) {
      const c = await tx.selectFrom('conversations').selectAll().where('id', '=', input.conversationId).executeTakeFirst();
      if (c) return c;
    }
    return tx.insertInto('conversations').values({ tenant_id: tenantId, agent: 'office_manager' }).returningAll().executeTakeFirstOrThrow();
  });
  const history = conv.messages as unknown as MessageParam[];
  const issued = (conv.issued_tokens as unknown as IssuedToken[]).filter((t) => Date.now() - Date.parse(t.issued_at) < TOKEN_TTL_MS);

  const rec = await RunRecorder.start(db, deps.prices, tenantId, 'office_manager', message, { conversationId: conv.id, evalCaseId: input.evalCaseId ?? null });
  const runId = rec.runId;
  const toolCalls: TurnResult['toolCalls'] = [];

  const finish = async (status: TurnStatus, reply: string, rt: Route | null, messages: MessageParam[] | null, newIssued: IssuedToken[]): Promise<TurnResult> => {
    if (messages) {
      await withTenant(db, tenantId, (tx) =>
        tx.updateTable('conversations').set({ messages: JSON.stringify(trimHistory(messages)), issued_tokens: JSON.stringify(newIssued), updated_at: new Date() })
          .where('id', '=', conv.id).execute(),
      );
    }
    await rec.finish(status, reply, { intent: rt?.intent ?? null, model: rt?.model ?? null });
    log.info({ tenantId, runId, status, intent: rt?.intent, model: rt?.model, costUsd: rec.totalCost, steps: rec.steps.length }, 'agent turn finished');
    return { conversationId: conv.id, runId, status, reply, intent: rt?.intent ?? null, model: rt?.model ?? null, costUsd: rec.totalCost, steps: rec.steps, toolCalls };
  };

  let toolbox: Toolbox | undefined;
  let rt: Route | null = null;
  try {
    // --- 1. route ------------------------------------------------------------
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    try {
      await rec.model('route', MODELS.fast, Math.ceil(message.length / 3) + 600, 64, async () => {
        rt = await route(llm, message, { draftPending: issued.length > 0, previousAssistant: lastAssistant ? textOf(lastAssistant.content) : undefined });
        return { usage: rt.usage, stop: rt.stopReason, output: { intent: rt.intent, model: rt.model }, latencyMs: rt.latencyMs };
      });
    } catch (err) {
      if (err instanceof SpendCapExceeded) throw err;
      // Routing is an optimization, not a dependency. Fail closed: answer on the
      // fast model as a plain lookup, which can never unlock a write.
      log.warn({ tenantId, runId, err: String(err) }, 'router failed; falling back to lookup');
      await rec.step('guard', 'router_fallback', { error: { message: String(err) }, ms: 0 });
      rt = { intent: 'lookup', model: MODELS.fast, usage: { input_tokens: 0, output_tokens: 0 }, routerModel: MODELS.fast, latencyMs: 0, stopReason: null };
    }
    const r = rt as unknown as Route;
    let liveTokens = r.intent === 'reject_draft' ? [] : [...issued];

    // --- 2. tool loop ----------------------------------------------------------
    toolbox = await deps.toolbox(input.apiKey);
    const today = await localToday(db, tenantId);
    const tools = deps.delegate ? [...toolbox.tools(), DELEGATE_TOOL] : toolbox.tools();
    const messages: MessageParam[] = [...history, { role: 'user', content: message }];
    const tokensBefore = new Set(liveTokens.map((t) => t.token));
    const issuedThisTurn: IssuedToken[] = [];

    for (let i = 0; i < maxSteps; i++) {
      let res!: Message;
      const params = {
        model: r.model,
        max_tokens: MAX_TOKENS[r.model] ?? 4096,
        system: systemPrompt(today, { delegation: Boolean(deps.delegate) }),
        tools,
        messages,
        cache_control: { type: 'ephemeral' as const },
        output_config: { effort: 'medium' as const },
        metadata: { user_id: createHash('sha256').update(tenantId).digest('hex').slice(0, 32) },
      };
      await rec.model('answer', r.model, Math.ceil(JSON.stringify(params).length / 3), params.max_tokens, async () => {
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
        return await finish('completed', textOf(res.content) || '(no answer)', r, messages, [...liveTokens, ...issuedThisTurn]);
      }

      const results: ToolResultBlockParam[] = [];
      for (const use of uses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        const started = performance.now();

        // --- write guard: step 2 needs a draft shown in an EARLIER turn and an explicit approval now
        const token = use.name === 'create_estimate_draft' && typeof args.confirmation_token === 'string' ? args.confirmation_token : null;
        if (token && !(r.intent === 'approve_draft' && tokensBefore.has(token))) {
          const reason = r.intent !== 'approve_draft' ? 'The user has not approved a draft in this message.' : 'That token was not shown to the user in an earlier message.';
          const body = { error: { code: 'CONFIRMATION_REQUIRED', message: `${reason} Show the preview and wait for explicit approval.`, retryable: false } };
          await rec.step('guard', 'write_guard', { input: { tool: use.name, token, intent: r.intent }, output: body, ms: 0 }, false);
          toolCalls.push({ name: use.name, input: args, isError: true, blocked: true });
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify(body) });
          continue;
        }

        // --- A2A delegation to the Estimator
        if (use.name === 'delegate_estimate' && deps.delegate) {
          let out: { isError: boolean; body: unknown };
          try {
            const d = await deps.delegate(input.apiKey, {
              description: String(args.job_description ?? ''),
              ...(typeof args.customer_id === 'string' ? { customer_id: args.customer_id } : {}),
              parent_run_id: runId,
              ...(input.evalCaseId ? { eval_case_id: input.evalCaseId } : {}),
            });
            out = { isError: false, body: { ...d.estimate, a2a_task_id: d.taskId } };
            await rec.step('a2a', 'estimator.estimate-remodel-job', { input: args, output: { task_id: d.taskId, estimator_run_id: d.estimatorRunId, subtotal: d.estimate.subtotal, lines: d.estimate.lines.length }, ms: Math.round(performance.now() - started) });
          } catch (err) {
            const reason = err instanceof DelegationFailed ? err.message : 'The Estimator agent did not respond.';
            out = { isError: true, body: { error: { code: 'ESTIMATOR_FAILED', message: reason, retryable: !(err instanceof DelegationFailed) } } };
            await rec.step('a2a', 'estimator.estimate-remodel-job', { input: args, error: { message: String(err), task_id: err instanceof DelegationFailed ? err.taskId : null }, ms: Math.round(performance.now() - started) });
          }
          toolCalls.push({ name: use.name, input: args, isError: out.isError });
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: out.isError, content: renderToolResult(out.body) });
          continue;
        }

        // --- MCP tools
        let out: { isError: boolean; body: unknown };
        try {
          out = await toolbox.call(use.name, args);
        } catch (err) {
          out = { isError: true, body: { error: { code: 'TOOL_UNAVAILABLE', message: 'The data service did not respond.', retryable: true } } };
          log.warn({ tenantId, runId, tool: use.name, err: String(err) }, 'tool call failed at transport level');
        }
        await rec.step('tool', use.name, { input: args, output: out.isError ? undefined : out.body, error: out.isError ? out.body : undefined, ms: Math.round(performance.now() - started) });
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
    await rec.step('error', 'turn_failed', { error: { message: err instanceof Error ? err.message : String(err) }, ms: 0 }).catch(() => {});
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
    sql<{ d: string }>`SELECT coalesce(frozen_today, (now() AT TIME ZONE timezone)::date)::text AS d FROM tenants WHERE id = ${tenantId}`.execute(tx),
  );
  return r.rows[0]?.d ?? new Date().toISOString().slice(0, 10);
}
