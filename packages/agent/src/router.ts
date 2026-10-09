import type { LlmClient } from './llm';
import { MODELS } from './llm';
import type { TokenUsage } from './pricing';

/**
 * First step of every turn: a cheap classification call that decides which
 * model answers, and whether the user is approving a pending draft (which is
 * what unlocks step 2 of the estimate write; see the write guard).
 */
export const INTENTS = ['lookup', 'analysis', 'estimate', 'approve_draft', 'reject_draft', 'smalltalk', 'out_of_scope'] as const;
export type Intent = (typeof INTENTS)[number];

export interface Route {
  intent: Intent;
  model: string;
  usage: TokenUsage;
  routerModel: string;
  latencyMs: number;
  stopReason: string | null;
}

const SYSTEM = `You classify one message sent to a contractor's office-manager assistant. Reply with JSON only.
Intents:
- lookup: a direct question answerable from one or two data lookups (who owes money, a customer's balance, open estimates, revenue for a period)
- analysis: needs comparing, ranking, multi-step reasoning or calculation across data
- estimate: wants a new estimate/quote/bid drafted, or changes to a draft
- approve_draft: explicitly approves creating the draft estimate that was just shown ("yes", "looks good, create it", "go ahead")
- reject_draft: declines or cancels the pending draft
- smalltalk: greetings, thanks, questions about the assistant itself
- out_of_scope: anything unrelated to the contractor's business data
Only use approve_draft when a draft is pending AND the message clearly approves it. Hesitant, conditional or unrelated replies are not approval.`;

const SCHEMA = {
  type: 'object',
  properties: { intent: { type: 'string', enum: [...INTENTS] } },
  required: ['intent'],
  additionalProperties: false,
};

const MODEL_FOR: Record<Intent, string> = {
  lookup: MODELS.fast,
  smalltalk: MODELS.fast,
  out_of_scope: MODELS.fast,
  approve_draft: MODELS.fast,
  reject_draft: MODELS.fast,
  analysis: MODELS.smart,
  estimate: MODELS.smart,
};

export async function route(llm: LlmClient, message: string, ctx: { draftPending: boolean; previousAssistant?: string }): Promise<Route> {
  const started = performance.now();
  const res = await llm.create({
    model: MODELS.fast,
    max_tokens: 64,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        `Draft estimate pending approval: ${ctx.draftPending ? 'yes' : 'no'}`,
        ctx.previousAssistant ? `Assistant's previous message (truncated): ${ctx.previousAssistant.slice(0, 600)}` : '',
        `User message: ${message}`,
      ].filter(Boolean).join('\n'),
    }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
  let intent: Intent = 'lookup';
  try {
    const parsed = JSON.parse(text) as { intent?: string };
    if (INTENTS.includes(parsed.intent as Intent)) intent = parsed.intent as Intent;
  } catch {
    /* fall back to lookup on the fast model: cheap and safe */
  }
  // Defense in depth: approval only means something when a draft is pending.
  if (intent === 'approve_draft' && !ctx.draftPending) intent = 'smalltalk';
  return { intent, model: MODEL_FOR[intent], usage: res.usage, routerModel: MODELS.fast, latencyMs: Math.round(performance.now() - started), stopReason: res.stop_reason };
}
