import express, { type NextFunction, type Request, type Response } from 'express';
import * as z from 'zod';
import { runTurn, type AgentDeps } from '@co/agent';
import { resolveApiKey } from '@co/mcp';
import { logger as baseLogger, type Logger } from '@co/shared';
import { usageReport } from './usage';

export interface OfficeManagerAppDeps extends AgentDeps {
  log?: Logger;
  /** Per-key request budget for /chat (protects the spend cap from a runaway client). */
  rateLimitPerMinute?: number;
}

const ChatBody = z.object({
  message: z.string().min(1).max(4000),
  conversation_id: z.uuid().optional(),
});

type Authed = Request & { principal?: { tenantId: string; apiKeyId: string; key: string } };

export function createOfficeManagerApp(deps: OfficeManagerAppDeps) {
  const log = deps.log ?? baseLogger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_req, res) => void res.json({ ok: true }));

  const auth = async (req: Authed, res: Response, next: NextFunction) => {
    const h = req.get('authorization') ?? '';
    const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const p = key ? await resolveApiKey(deps.db, key) : null;
    if (!p) return void res.status(401).json({ error: 'invalid_token' });
    req.principal = { tenantId: p.tenantId, apiKeyId: p.apiKeyId, key };
    next();
  };

  // Fixed-window limiter per key. In-process is enough for one instance; a
  // second instance would move this to Postgres or Redis.
  const windows = new Map<string, { start: number; n: number }>();
  const limit = deps.rateLimitPerMinute ?? 20;
  const rateLimit = (req: Authed, res: Response, next: NextFunction) => {
    const id = req.principal!.apiKeyId;
    const now = Date.now();
    const w = windows.get(id);
    if (!w || now - w.start > 60_000) windows.set(id, { start: now, n: 1 });
    else if (++w.n > limit) return void res.status(429).set('Retry-After', String(Math.ceil((w.start + 60_000 - now) / 1000))).json({ error: 'rate_limited' });
    next();
  };

  app.post('/chat', auth, rateLimit, async (req: Authed, res: Response) => {
    const body = ChatBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'invalid_request', details: body.error.issues.map((i) => i.message) });
    const p = req.principal!;
    const r = await runTurn(deps, { tenantId: p.tenantId, apiKey: p.key, message: body.data.message, conversationId: body.data.conversation_id });
    res.status(r.status === 'rejected_spend_cap' ? 402 : 200).json({
      conversation_id: r.conversationId,
      run_id: r.runId,
      status: r.status,
      reply: r.reply,
      intent: r.intent,
      model: r.model,
      cost_usd: r.costUsd.toFixed(6),
      steps: r.steps.map((s) => `${s.kind}:${s.name}${s.ok ? '' : ' (error)'}`),
    });
  });

  app.get('/usage', auth, async (req: Authed, res: Response) => {
    res.json(await usageReport(deps.db, req.principal!.tenantId));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err) }, 'office manager request failed');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
