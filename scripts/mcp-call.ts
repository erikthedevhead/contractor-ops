// Call an MCP tool from the command line, like an agent would.
//   MCP_API_KEY=cok_... pnpm mcp:call list
//   MCP_API_KEY=cok_... pnpm mcp:call get_ar_aging '{"overdue_more_than_days":60}'
// MCP_URL defaults to http://localhost:3000/mcp.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const key = process.env.MCP_API_KEY;
const url = new URL(process.env.MCP_URL ?? 'http://localhost:3000/mcp');
const [tool, rawArgs] = process.argv.slice(2);
if (!key || !tool) {
  console.error('usage: MCP_API_KEY=cok_... pnpm mcp:call <tool|list> [json-args]');
  process.exit(1);
}

const client = new Client({ name: 'mcp-call-cli', version: '0.0.1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
try {
  if (tool === 'list') {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\n  ${t.description}\n`);
  } else {
    const r = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
    console.log(JSON.stringify(r.structuredContent ?? r.content, null, 2));
    if (r.isError) process.exitCode = 2;
  }
} finally {
  await client.close();
}
