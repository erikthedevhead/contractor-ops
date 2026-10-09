import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NextFunction, Request, Response } from 'express';
import * as z from 'zod';
import { withTenant, type Db } from '@co/db';
import type { QboClient } from '@co/qbo';
import { logger as baseLogger, type Logger } from '@co/shared';
import { toToolErrorBody, ToolError } from './errors';
import { resolveApiKey } from './keys';
import { confirmEstimate, previewEstimate } from './tools/estimate';
import { findCustomer, getArAging, getCustomerJobHistory, getRevenueByItem, listOpenEstimates } from './tools/read';

export interface McpDeps {
  db: Db;
  clientFor: (tenantId: string) => QboClient;
  log?: Logger;
}

interface Principal {
  tenantId: string;
  apiKeyId: string;
  scopes: string[];
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const id = z.string().min(1).max(64);

/**
 * One McpServer per request (the 2026-07-28 protocol is stateless), built for
 * exactly one authenticated tenant. The tenant comes from the API key, never
 * from tool arguments: no tool accepts a tenant id, so there is no parameter
 * an agent (or a prompt injection) could change to reach another tenant.
 */
export function buildMcpServer(deps: McpDeps, who: Principal): McpServer {
  const log = deps.log ?? baseLogger;
  const server = new McpServer({ name: 'contractor-ops', version: '0.3.0' });

  const run = async <T>(tool: string, fn: () => Promise<T>) => {
    const started = performance.now();
    try {
      const out = await fn();
      log.info({ tool, tenantId: who.tenantId, apiKeyId: who.apiKeyId, ms: Math.round(performance.now() - started), ok: true }, 'mcp tool call');
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out as Record<string, unknown> };
    } catch (err) {
      const body = toToolErrorBody(err, { tool, tenantId: who.tenantId });
      log.info({ tool, tenantId: who.tenantId, apiKeyId: who.apiKeyId, ms: Math.round(performance.now() - started), ok: false, code: body.error.code }, 'mcp tool call');
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body as unknown as Record<string, unknown> };
    }
  };
  const read = <T>(tool: string, fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    run(tool, () => withTenant(deps.db, who.tenantId, fn));

  server.registerTool('find_customer', {
    description: 'Find customers by (partial or misspelled) name or company. Returns ids, contact info, open balance and last activity. If `ambiguous` is true, ask the user which one they mean before acting.',
    inputSchema: z.object({ query: z.string().min(2).max(100).describe('Name or company, e.g. "Johnson"'), limit: z.number().int().min(1).max(20).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => read('find_customer', (tx) => findCustomer(tx, who.tenantId, args)));

  server.registerTool('get_ar_aging', {
    description: 'Accounts receivable aging: unpaid invoices grouped by customer with days past due and bucket totals (current, 1_30, 31_60, 61_90, over_90). For "owes more than N days", pass overdue_more_than_days=N (strictly greater than).',
    inputSchema: z.object({
      as_of: date.optional().describe('Defaults to today in the contractor\'s timezone'),
      overdue_more_than_days: z.number().int().min(0).max(3650).optional(),
      customer_id: id.optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => read('get_ar_aging', (tx) => getArAging(tx, who.tenantId, args)));

  server.registerTool('list_open_estimates', {
    description: 'Estimates still pending (not accepted, rejected or invoiced), newest first, flagged if past their expiration date.',
    inputSchema: z.object({ customer_id: id.optional(), include_expired: z.boolean().optional(), as_of: date.optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => read('list_open_estimates', (tx) => listOpenEstimates(tx, who.tenantId, args)));

  server.registerTool('get_revenue_by_item', {
    description: 'Invoiced revenue per service item (each item is a service type) between two dates, inclusive, by invoice date. Before tax; excludes voided invoices.',
    inputSchema: z.object({ start_date: date, end_date: date }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => read('get_revenue_by_item', (tx) => getRevenueByItem(tx, who.tenantId, args)));

  server.registerTool('get_customer_job_history', {
    description: 'Past jobs (estimates and invoices) with line items. Filter by customer_id, or pass query to find similar jobs across all customers (e.g. "bathroom remodel walk-in shower"). Use the returned item ids and prices when drafting an estimate.',
    inputSchema: z.object({
      customer_id: id.optional(),
      query: z.string().min(2).max(200).optional(),
      limit: z.number().int().min(1).max(25).optional(),
      include_lines: z.boolean().optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, (args) => read('get_customer_job_history', (tx) => getCustomerJobHistory(tx, who.tenantId, args)));

  server.registerTool('create_estimate_draft', {
    description: [
      'Creates an estimate in QuickBooks in two steps.',
      'Step 1: call with customer_id and lines (no confirmation_token). Nothing is written; you get a preview and a confirmation_token.',
      'Show the preview to the user. Step 2: ONLY after the user explicitly approves, call again with ONLY confirmation_token.',
      'Never perform step 2 without the user\'s explicit approval in this conversation.',
    ].join(' '),
    inputSchema: z.object({
      confirmation_token: z.uuid().optional().describe('Step 2 only. When present, no other fields are allowed.'),
      customer_id: id.optional(),
      title: z.string().max(1000).optional().describe('Job title shown to the customer, e.g. "Full bathroom remodel - walk-in shower"'),
      valid_for_days: z.number().int().min(1).max(90).optional(),
      lines: z.array(z.object({
        item_id: id,
        quantity: z.number().positive().max(100000),
        unit_price: z.number().min(0).max(1_000_000).optional().describe('Defaults to the item\'s price in QuickBooks'),
        description: z.string().max(4000).optional(),
      })).min(1).max(40).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => run('create_estimate_draft', async () => {
    if (!who.scopes.includes('write:estimate')) {
      throw new ToolError('FORBIDDEN', 'This API key is read-only.', { hint: 'Estimates can only be created with a key that has the write:estimate scope.' });
    }
    if (args.confirmation_token) {
      if (args.customer_id || args.lines || args.title || args.valid_for_days) {
        throw new ToolError('INVALID_ARGUMENT', 'Step 2 takes only confirmation_token. To change the draft, create a new preview.');
      }
      return confirmEstimate(deps.db, deps.clientFor(who.tenantId), who.tenantId, args.confirmation_token);
    }
    if (!args.customer_id || !args.lines) {
      throw new ToolError('INVALID_ARGUMENT', 'Step 1 needs customer_id and lines.');
    }
    return previewEstimate(deps.db, who.tenantId, { customer_id: args.customer_id, lines: args.lines, title: args.title, valid_for_days: args.valid_for_days }, { apiKeyId: who.apiKeyId });
  }));

  return server;
}

/** Express wiring: bearer API key -> principal -> per-request MCP server. */
export function mcpRouter(deps: McpDeps) {
  const handler = createMcpHandler((ctx) => {
    const p = ctx.authInfo?.extra as Principal | undefined;
    if (!p) throw new Error('unauthenticated request reached the MCP handler');
    return buildMcpServer(deps, p);
  });
  const node = toNodeHandler(handler);

  const auth = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const resolved = key ? await resolveApiKey(deps.db, key) : null;
    if (!resolved) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="contractor-ops"').json({ error: 'invalid_token' });
      return;
    }
    (req as Request & { auth?: unknown }).auth = {
      token: key.slice(0, 12), // never the full key
      clientId: resolved.apiKeyId,
      scopes: resolved.scopes,
      extra: { tenantId: resolved.tenantId, apiKeyId: resolved.apiKeyId, scopes: resolved.scopes } satisfies Principal,
    };
    next();
  };

  return { auth, handle: (req: Request, res: Response) => node(req as never, res as never) };
}
