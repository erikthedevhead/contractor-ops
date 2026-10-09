/** co-estimator: the Estimator agent as an A2A server. Reads data only through co-core's MCP endpoint. */
import { anthropicClient, connectToolbox, PriceBook } from '@co/agent';
import { createDb } from '@co/db';
import { env, logger } from '@co/shared';
import { createEstimatorApp } from './server';

const e = env();
if (!e.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
const port = Number(process.env.ESTIMATOR_PORT ?? 3300);
const mcpUrl = process.env.MCP_URL ?? `http://127.0.0.1:${e.PORT}/mcp`;
const publicUrl = process.env.ESTIMATOR_PUBLIC_URL ?? `http://127.0.0.1:${port}`;

const db = createDb(e.DATABASE_URL, { max: 5 });
const app = createEstimatorApp({
  db,
  llm: anthropicClient(e.ANTHROPIC_API_KEY),
  prices: await PriceBook.load(db),
  toolbox: (apiKey) => connectToolbox(mcpUrl, apiKey, 'estimator'),
  publicUrl,
});
const server = app.listen(port, '127.0.0.1', () => logger.info({ port, mcpUrl, agentCard: `${publicUrl}/.well-known/agent-card.json` }, 'estimator (A2A) listening'));

const shutdown = () => {
  server.close(() => void db.destroy().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
