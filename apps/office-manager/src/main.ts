/** co-office-manager: the user-facing agent. Talks to data only through the MCP server. */
import { anthropicClient, connectToolbox, PriceBook } from '@co/agent';
import { createDb } from '@co/db';
import { env, logger } from '@co/shared';
import { createOfficeManagerApp } from './app';

const e = env();
if (!e.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
const port = Number(process.env.OFFICE_MANAGER_PORT ?? 3200);
const mcpUrl = process.env.MCP_URL ?? `http://127.0.0.1:${e.PORT}/mcp`;

const db = createDb(e.DATABASE_URL, { max: 5 });
const prices = await PriceBook.load(db);
const app = createOfficeManagerApp({
  db,
  llm: anthropicClient(e.ANTHROPIC_API_KEY),
  prices,
  toolbox: (apiKey) => connectToolbox(mcpUrl, apiKey, 'office-manager'),
});
const server = app.listen(port, '127.0.0.1', () => logger.info({ port, mcpUrl }, 'office manager listening'));

const shutdown = () => {
  server.close(() => void db.destroy().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
