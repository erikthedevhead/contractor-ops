/**
 * Shared integration fixture: a seeded tenant on the fake QuickBooks, the real
 * MCP server over HTTP, API keys, and a scriptable fake LLM. Used by the agent
 * tests now and the eval harness later.
 */
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { initialSync, QboClient, TokenStore } from '@co/qbo';
import { createApp } from '../../../apps/api/src/app';
import { createApiKey } from '../../../apps/mcp/src/keys';
import { mcpRouter } from '../../../apps/mcp/src/server';
import { dropTenant, makeTenant, ownerDb, testDb } from '../../db/test/helpers';
import { FakeQbo } from '../../qbo/test/fake-qbo';
import { runSeed } from '../../../scripts/seed/run';
import type { LlmClient } from '../src/llm';
import { PriceBook } from '../src/pricing';

export const ANCHOR = '2026-10-08';
const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;

export async function setupWorld() {
  const db = testDb();
  const owner = ownerDb();
  const fake = new FakeQbo();
  const app = { environment: 'sandbox' as const, clientId: 'cid-000000', clientSecret: 'sec-000000', redirectUri: 'http://x/cb' };
  const tokens = new TokenStore({ db, ring: { keys: new Map([[1, randomBytes(32)]]), activeVersion: 1 }, app, log: silent });
  const clientFor = (t: string) => new QboClient(t, { tokens, meter: () => {}, fetchFn: fake.fetch, sleep: async () => {}, log: silent });

  const tenantId = await makeTenant(db, 'agent');
  await tokens.saveConnection(tenantId, `9341agent${Date.now()}${Math.random()}`, { accessToken: 'a', refreshToken: 'r', accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: null, responseKeys: [] });
  await runSeed({ db, client: clientFor(tenantId), tenantId, anchor: ANCHOR, writeSpacingMs: 0, manifestPath: null, log: () => {} });
  await initialSync(db, clientFor(tenantId), { log: silent });
  const writeKey = (await createApiKey(owner, tenantId, ['read', 'write:estimate'])).key;
  const readKey = (await createApiKey(owner, tenantId, ['read'])).key;

  const server: Server = createApp({ db, tokens, qbo: app, connectLinkSecret: 'ab'.repeat(32), mcp: mcpRouter({ db, clientFor, log: silent }), log: silent }).listen(0);
  const mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const prices = await PriceBook.load(db);

  return {
    db, owner, fake, tenantId, writeKey, readKey, mcpUrl, prices, silent,
    async teardown() {
      server.close();
      await dropTenant(db, tenantId);
      await db.destroy();
      await owner.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Fake LLM
// ---------------------------------------------------------------------------
export type Handler = (params: MessageCreateParamsNonStreaming, ctx: { lastToolResults: Array<{ isError: boolean; body: any }> }) => Message;

let idSeq = 0;
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) as Message['usage'];

export const reply = {
  text: (text: string, model = 'claude-haiku-5-5'): Message => ({
    id: `msg_${++idSeq}`, type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text, citations: null }], usage: usage(1200, 150),
  }) as unknown as Message,
  tools: (calls: Array<[string, Record<string, unknown>]>, model = 'claude-haiku-5-5'): Message => ({
    id: `msg_${++idSeq}`, type: 'message', role: 'assistant', model, stop_reason: 'tool_use', stop_sequence: null,
    content: calls.map(([name, input]) => ({ type: 'tool_use', id: `toolu_${++idSeq}`, name, input })), usage: usage(1500, 80),
  }) as unknown as Message,
  route: (intent: string): Message => ({
    id: `msg_${++idSeq}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify({ intent }), citations: null }], usage: usage(300, 10),
  }) as unknown as Message,
};

/**
 * routeFor: user message -> intent. script: queue of handlers for answer calls.
 * Records every call so tests can assert what the model was shown.
 */
export class FakeLlm implements LlmClient {
  readonly calls: MessageCreateParamsNonStreaming[] = [];
  private script: Handler[] = [];
  constructor(private routeFor: (userMessage: string) => string = () => 'lookup') {}

  setRouter(fn: (userMessage: string) => string) { this.routeFor = fn; }
  queue(...handlers: Handler[]) { this.script.push(...handlers); }

  async create(params: MessageCreateParamsNonStreaming): Promise<Message> {
    this.calls.push(structuredClone(params));
    if (params.output_config?.format) {
      const content = String(params.messages[0]!.content);
      const msg = /User message: ([\s\S]*)$/.exec(content)?.[1] ?? '';
      return reply.route(this.routeFor(msg));
    }
    const next = this.script.shift();
    if (!next) throw new Error('FakeLlm: no scripted response left');
    const last = params.messages[params.messages.length - 1]!;
    const lastToolResults = Array.isArray(last.content)
      ? last.content.filter((b: any) => b.type === 'tool_result').map((b: any) => {
          const parsed = JSON.parse(String(b.content));
          if (parsed?.result_truncated) throw new Error(`FakeLlm: tool result truncated (${parsed.note}); the test asked for too much`);
          return { isError: Boolean(b.is_error), body: parsed };
        })
      : [];
    return next(params, { lastToolResults });
  }
}
