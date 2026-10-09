// Interactive chat with the Office Manager agent.
//   AGENT_URL=https://contractor-ops.houghworks.com/agent MCP_API_KEY=cok_... pnpm chat
// AGENT_URL defaults to http://localhost:3200. Type "exit" to quit.
import { createInterface } from 'node:readline/promises';

const base = (process.env.AGENT_URL ?? 'http://localhost:3200').replace(/\/$/, '');
const key = process.env.MCP_API_KEY;
if (!key) {
  console.error('Set MCP_API_KEY (the same per-tenant key the MCP server uses).');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let conversationId: string | undefined;
let total = 0;
console.log(`Office Manager at ${base}. Ask about customers, invoices, estimates. "exit" to quit.\n`);
for (;;) {
  const message = (await rl.question('you> ')).trim();
  if (!message) continue;
  if (message === 'exit') break;
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ message, conversation_id: conversationId }),
  });
  const body = (await res.json()) as Record<string, any>;
  if (!res.ok && res.status !== 402) {
    console.log(`[HTTP ${res.status}] ${JSON.stringify(body)}\n`);
    continue;
  }
  conversationId = body.conversation_id;
  total += Number(body.cost_usd ?? 0);
  console.log(`\nagent> ${body.reply}\n`);
  console.log(`  [${body.intent} -> ${body.model} | $${Number(body.cost_usd).toFixed(4)} this turn, $${total.toFixed(4)} session | ${body.steps?.join(' > ')}]\n`);
}
rl.close();
