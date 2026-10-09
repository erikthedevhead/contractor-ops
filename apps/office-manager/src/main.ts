/** co-office-manager: the user-facing agent. Talks to data only through the MCP server. */
import { a2aEstimateDelegate, anthropicClient, connectToolbox, PriceBook } from '@co/agent';
import { createDb } from '@co/db';
import { env, logger } from '@co/shared';
import { createOfficeManagerApp } from './app';

const e = env();
if (!e.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
const port = Number(process.env.OFFICE_MANAGER_PORT ?? 3200);
const mcpUrl = process.env.MCP_URL ?? `http://127.0.0.1:${e.PORT}/mcp`;
// A2A: estimating is delegated to the Estimator agent. Set ESTIMATOR_URL=off to disable.
const estimatorUrl = process.env.ESTIMATOR_URL ?? 'http://127.0.0.1:3300';

const db = createDb(e.DATABASE_URL, { max: 5 });
const prices = await PriceBook.load(db);
const app = createOfficeManagerApp({
  db,
  llm: anthropicClient(e.ANTHROPIC_API_KEY),
  prices,
  toolbox: (apiKey) => connectToolbox(mcpUrl, apiKey, 'office-manager'),
  ...(estimatorUrl === 'off' ? {} : { delegate: a2aEstimateDelegate(estimatorUrl) }),
});
const server = app.listen(port, '127.0.0.1', () => logger.info({ port, mcpUrl, estimatorUrl }, 'office manager listening'));

// Startup probe for the Estimator's Agent Card (A2A discovery).
if (estimatorUrl !== 'off') {
  fetch(`${estimatorUrl}/.well-known/agent-card.json`)
    .then(async (r) => {
      const card = r.ok ? ((await r.json()) as { name?: string }) : null;
      if (card?.name) logger.info({ estimatorUrl, agent: card.name }, 'estimator agent card found');
      else logger.warn({ estimatorUrl, status: r.status }, 'estimator agent card not found; estimate requests will fail');
    })
    .catch((err) => logger.error({ estimatorUrl, err: String(err) }, 'estimator unreachable at startup'));
}

// Startup probe: an unauthenticated request must reach OUR MCP server and be
// refused with our realm. Catches a wrong or unreachable MCP_URL at boot
// instead of on the first user question.
fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  .then((r) => {
    const ours = r.status === 401 && (r.headers.get('www-authenticate') ?? '').includes('contractor-ops');
    if (ours) logger.info({ mcpUrl }, 'mcp server reachable');
    else logger.warn({ mcpUrl, status: r.status }, 'MCP_URL did not answer like this app\'s MCP server; check MCP_URL (a shell export overrides .env)');
  })
  .catch((err) => logger.error({ mcpUrl, err: String(err) }, 'MCP server unreachable at startup; agent turns will fail until it is up'));

const shutdown = () => {
  server.close(() => void db.destroy().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
