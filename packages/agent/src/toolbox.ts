import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Tool } from '@anthropic-ai/sdk/resources/messages';

/**
 * The agent's only way to touch data: an MCP client connected to our MCP
 * server with the caller's API key. The agent therefore inherits the caller's
 * tenant and scopes; a read-only key yields an agent that cannot write.
 */
export interface ToolCallResult {
  isError: boolean;
  body: unknown;
}

export interface Toolbox {
  tools(): Tool[];
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

const MAX_RESULT_CHARS = 40_000; // ~10K tokens: keeps tool results well inside context and cost budgets

export async function connectToolbox(url: string, apiKey: string, clientName = 'contractor-ops-agent'): Promise<Toolbox> {
  const client = new Client({ name: clientName, version: '0.4.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }));
  const { tools } = await client.listTools();
  const anthropicTools: Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.inputSchema as Tool['input_schema'],
  }));
  return {
    tools: () => anthropicTools,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      return { isError: Boolean(r.isError), body: r.structuredContent ?? r.content };
    },
    close: () => client.close(),
  };
}

/**
 * Oversized results are still returned as valid JSON (a cut-off JSON string
 * is worse than useless to a model), clearly marked as partial.
 */
export function renderToolResult(body: unknown, max = MAX_RESULT_CHARS): string {
  const s = JSON.stringify(body);
  if (s.length <= max) return s;
  return JSON.stringify({ result_truncated: true, note: `Result was ${s.length} characters; showing the first ${max}. Narrow the query or lower limit.`, partial_json: s.slice(0, max) });
}
