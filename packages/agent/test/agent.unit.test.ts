import { describe, expect, it } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { PriceBook } from '../src/pricing';
import { trimHistory } from '../src/office-manager';
import { route } from '../src/router';
import { FakeLlm, reply } from './fixture';

const book = PriceBook.fromEntries({
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
});

describe('PriceBook', () => {
  it('prices input, output, cache reads and writes separately', () => {
    expect(book.cost('claude-sonnet-5-5', { input_tokens: 10_000, output_tokens: 1_000 })).toBe(0.03);
    expect(book.cost('claude-sonnet-5-5', { input_tokens: 1_000, output_tokens: 0, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0 })).toBe(0.0029);
    expect(book.cost('claude-haiku-5-5', { input_tokens: 1_000, output_tokens: 500 })).toBe(0.00035);
  });
  it('worst case is never below the real cost', () => {
    expect(book.worstCase('claude-sonnet-5-5', 10_000, 1_000)).toBeGreaterThanOrEqual(book.cost('claude-sonnet-5-5', { input_tokens: 10_000, output_tokens: 1_000 }));
  });
  it('refuses unknown models instead of pricing them at zero', () => {
    expect(() => book.cost('claude-mystery', { input_tokens: 1, output_tokens: 1 })).toThrow(/no price/);
  });
});

describe('router', () => {
  it('maps intents to models: lookups on Haiku, analysis and estimates on Sonnet', async () => {
    const llm = new FakeLlm((m) => (m.includes('rank') ? 'analysis' : m.includes('quote') ? 'estimate' : 'lookup'));
    expect((await route(llm, 'who owes me', { draftPending: false })).model).toBe('claude-haiku-5-5');
    expect((await route(llm, 'rank my customers', { draftPending: false })).model).toBe('claude-sonnet-5-5');
    expect((await route(llm, 'quote a bathroom', { draftPending: false })).model).toBe('claude-sonnet-5-5');
  });
  it('cannot approve a draft that does not exist', async () => {
    const llm = new FakeLlm(() => 'approve_draft');
    expect((await route(llm, 'yes', { draftPending: false })).intent).toBe('smalltalk');
    expect((await route(llm, 'yes', { draftPending: true })).intent).toBe('approve_draft');
  });
  it('falls back to a cheap lookup on unparseable output', async () => {
    const llm = { create: async () => reply.text('not json') } as never;
    const r = await route(llm, 'hello', { draftPending: false });
    expect(r).toMatchObject({ intent: 'lookup', model: 'claude-haiku-5-5' });
  });
});

describe('renderToolResult', () => {
  it('keeps oversized results valid JSON and marks them partial', async () => {
    const { renderToolResult } = await import('../src/toolbox');
    const out = JSON.parse(renderToolResult({ rows: 'x'.repeat(500) }, 100));
    expect(out).toMatchObject({ result_truncated: true });
    expect(out.partial_json).toHaveLength(100);
  });
});

describe('trimHistory', () => {
  it('never cuts between a tool_use and its tool_result', () => {
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user', content: `q${i}` });
      msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }] });
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '{}' }] });
      msgs.push({ role: 'assistant', content: 'a' });
    }
    const t = trimHistory(msgs, 40);
    expect(t.length).toBeLessThanOrEqual(40);
    expect(typeof t[0]!.content).toBe('string');
    expect(t[0]!.role).toBe('user');
  });
});
