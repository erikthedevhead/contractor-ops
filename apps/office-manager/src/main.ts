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

// Startup probe for the Estimator's Agent Card (A2A discovery). PM2 starts all
// apps at once, so retry for ~15s before warning.
if (estimatorUrl !== 'off') {
  void (async () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const r = await fetch(`${estimatorUrl}/.well-known/agent-card.json`);
        const card = r.ok ? ((await r.json()) as { name?: string }) : null;
        if (card?.name) return logger.info({ estimatorUrl, agent: card.name, attempt }, 'estimator agent card found');
      } catch {
        /* not up yet */
      }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    logger.warn({ estimatorUrl }, 'estimator agent card not found after 15s; estimate requests will fail until it is up');
  })();
}
