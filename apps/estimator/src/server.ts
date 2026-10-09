import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { AgentEvent, DefaultRequestHandler, type AgentExecutor, type ExecutionEventBus, type RequestContext, type User } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { DatabaseTaskStore } from '@a2a-js/sdk/server/database';
import { Role, TaskState, type AgentCard, type Message, type Part } from '@a2a-js/sdk';
import { runEstimator, type EstimatorDeps, type Toolbox } from '@co/agent';
import { resolveApiKey } from '@co/mcp';
import { logger as baseLogger, type Logger } from '@co/shared';

/**
 * The Estimator as an A2A server (spec v1.0, official SDK).
 *
 * - Agent Card at /.well-known/agent-card.json advertises one skill and
 *   Bearer auth.
 * - JSON-RPC endpoint at /a2a/jsonrpc. Auth middleware resolves the caller's
 *   API key to a tenant; the UserBuilder turns that into the A2A User, whose
 *   userName (the tenant id) is the owner the Postgres task store scopes by.
 * - Input: a text part (job description) and an optional data part
 *   {customer_id, parent_run_id}. Output: one artifact "estimate" with a data
 *   part (ProposedEstimate), or a failed/rejected task with a text reason.
 */

export class TenantUser implements User {
  constructor(readonly tenantId: string, readonly apiKey: string) {}
  get isAuthenticated() { return true; }
  get userName() { return this.tenantId; }
}

export interface EstimatorServerDeps extends EstimatorDeps {
  toolbox: (apiKey: string) => Promise<Toolbox>;
  publicUrl: string; // base URL advertised in the Agent Card
  log?: Logger;
}

export function agentCard(publicUrl: string): AgentCard {
  return {
    name: 'Contractor Ops Estimator',
    description: 'Sizes and prices remodeling jobs from the contractor\'s own past jobs in QuickBooks. Returns line items with quantities, prices, the comparable jobs used, and stated assumptions. Read-only: never writes to QuickBooks.',
    version: '0.5.0',
    supportedInterfaces: [{ url: `${publicUrl}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    provider: { organization: 'HoughWorks', url: 'https://houghworks.com' },
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {
      bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'Per-tenant Contractor Ops API key', scheme: 'bearer', bearerFormat: 'cok_<prefix>_<secret>' } } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{
      id: 'estimate-remodel-job',
      name: 'Estimate a remodeling job',
      description: 'Given a job description (and optionally a customer id), find comparable past jobs and propose a sized, priced estimate with assumptions.',
      tags: ['estimate', 'quote', 'remodel', 'quickbooks'],
      examples: ['Bathroom remodel for Mark Johnson, walk-in shower', 'Kitchen remodel with island, quartz counters'],
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['application/json'],
      securityRequirements: [],
    }],
    signatures: [],
  } as AgentCard;
}

const textPart = (value: string): Part => ({ content: { $case: 'text', value }, metadata: {}, filename: '', mediaType: 'text/plain' }) as Part;
const dataPart = (value: unknown): Part => ({ content: { $case: 'data', value }, metadata: {}, filename: '', mediaType: 'application/json' }) as Part;

function agentMessage(ctx: RequestContext, text: string): Message {
  return { messageId: randomUUID(), contextId: ctx.contextId, taskId: ctx.taskId, role: Role.ROLE_AGENT, parts: [textPart(text)], metadata: {}, extensions: [], referenceTaskIds: [] } as Message;
}

class EstimatorExecutor implements AgentExecutor {
  constructor(private readonly deps: EstimatorServerDeps) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const log = this.deps.log ?? baseLogger;
    const user = ctx.context.user as TenantUser;
    const status = (state: TaskState, text?: string) =>
      bus.publish(AgentEvent.statusUpdate({ taskId: ctx.taskId, contextId: ctx.contextId, status: { state, message: text ? agentMessage(ctx, text) : undefined, timestamp: new Date().toISOString() }, metadata: {} }));

    bus.publish(AgentEvent.task({
      id: ctx.taskId, contextId: ctx.contextId, artifacts: [], history: [ctx.userMessage], metadata: {},
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
    }));

    let description = '';
    let input: { customer_id?: string; parent_run_id?: string; eval_case_id?: string } = {};
    for (const p of ctx.userMessage.parts) {
      if (p.content?.$case === 'text') description += p.content.value;
      if (p.content?.$case === 'data' && p.content.value && typeof p.content.value === 'object') input = { ...input, ...p.content.value };
    }
    if (!description.trim()) {
      status(TaskState.TASK_STATE_REJECTED, 'A job description (text part) is required.');
      bus.finished();
      return;
    }

    status(TaskState.TASK_STATE_WORKING);
    let toolbox: Toolbox | undefined;
    try {
      toolbox = await this.deps.toolbox(user.apiKey);
      const r = await runEstimator(this.deps, toolbox, user.tenantId, { description: description.trim(), customer_id: input.customer_id }, {
        parentRunId: input.parent_run_id ?? null, a2aTaskId: ctx.taskId, evalCaseId: input.eval_case_id ?? null,
      });
      bus.publish(AgentEvent.artifactUpdate({
        taskId: ctx.taskId, contextId: ctx.contextId, append: false, lastChunk: true, metadata: {},
        artifact: {
          artifactId: randomUUID(), name: 'estimate', description: 'Proposed estimate (not yet created in QuickBooks)',
          parts: [dataPart(r.estimate)], metadata: { estimator_run_id: r.runId, cost_usd: r.costUsd.toFixed(6) }, extensions: [],
        },
      }));
      status(TaskState.TASK_STATE_COMPLETED);
    } catch (err) {
      const capped = err instanceof Error && err.name === 'SpendCapExceeded';
      log.warn({ tenantId: user.tenantId, taskId: ctx.taskId, err: String(err) }, 'estimate task failed');
      status(capped ? TaskState.TASK_STATE_REJECTED : TaskState.TASK_STATE_FAILED, capped ? 'Monthly AI budget reached.' : `Could not produce an estimate: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await toolbox?.close().catch(() => {});
      bus.finished();
    }
  }

  async cancelTask(): Promise<void> {
    // Estimates finish in seconds; cancellation is not offered (capabilities say so implicitly).
  }
}

export function createEstimatorApp(deps: EstimatorServerDeps) {
  const log = deps.log ?? baseLogger;
  const handler = new DefaultRequestHandler(agentCard(deps.publicUrl), new DatabaseTaskStore(deps.db, { tableName: 'a2a_tasks' }), new EstimatorExecutor(deps));
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));

  const auth = async (req: Request & { tenantUser?: TenantUser }, res: Response, next: NextFunction) => {
    const h = req.get('authorization') ?? '';
    const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const p = key ? await resolveApiKey(deps.db, key) : null;
    if (!p) return void res.status(401).set('WWW-Authenticate', 'Bearer realm="contractor-ops-estimator"').json({ error: 'invalid_token' });
    req.tenantUser = new TenantUser(p.tenantId, key);
    next();
  };
  app.use('/a2a/jsonrpc', auth, jsonRpcHandler({
    requestHandler: handler,
    userBuilder: async (req) => (req as Request & { tenantUser?: TenantUser }).tenantUser!,
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err: String(err) }, 'estimator request failed');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
