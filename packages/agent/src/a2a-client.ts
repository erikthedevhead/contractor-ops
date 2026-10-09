import { randomUUID } from 'node:crypto';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { Role, TaskState, type Task } from '@a2a-js/sdk';
import type { ProposedEstimate } from './estimator';

/**
 * Office Manager -> Estimator delegation over A2A. Discovers the Estimator via
 * its Agent Card, sends one message, and returns the estimate artifact. The
 * caller's API key travels as the Bearer token, so the Estimator acts for the
 * same tenant with the same scopes.
 */
export interface EstimateDelegation {
  estimate: ProposedEstimate;
  taskId: string;
  estimatorRunId: string | null;
  costUsd: number;
}

export class DelegationFailed extends Error {
  constructor(message: string, readonly taskId: string | null, readonly state: string) {
    super(message);
    this.name = 'DelegationFailed';
  }
}

export type EstimateDelegate = (apiKey: string, req: { description: string; customer_id?: string; parent_run_id?: string; eval_case_id?: string }) => Promise<EstimateDelegation>;

export function a2aEstimateDelegate(estimatorBaseUrl: string, opts: { timeoutMs?: number } = {}): EstimateDelegate {
  return async (apiKey, req) => {
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${apiKey}` } }) })],
    });
    const client = await factory.createFromUrl(estimatorBaseUrl);
    const { description, ...data } = req;
    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, metadata: {}, extensions: [], referenceTaskIds: [],
        parts: [
          { content: { $case: 'text', value: description }, metadata: {}, filename: '', mediaType: 'text/plain' },
          { content: { $case: 'data', value: data }, metadata: {}, filename: '', mediaType: 'application/json' },
        ],
      },
      configuration: undefined,
      metadata: {},
    } as never, { signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });

    const task = result as unknown as Task;
    const state = task.status?.state;
    if (state !== TaskState.TASK_STATE_COMPLETED) {
      const reason = task.status?.message?.parts?.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join(' ') || 'no reason given';
      throw new DelegationFailed(reason, task.id ?? null, TaskState[state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? String(state));
    }
    const artifact = task.artifacts?.find((a) => a.name === 'estimate');
    const part = artifact?.parts.find((p) => p.content?.$case === 'data');
    if (!part || part.content?.$case !== 'data') throw new DelegationFailed('estimator returned no estimate artifact', task.id, 'COMPLETED');
    const meta = (artifact?.metadata ?? {}) as { estimator_run_id?: string; cost_usd?: string };
    return { estimate: part.content.value as ProposedEstimate, taskId: task.id, estimatorRunId: meta.estimator_run_id ?? null, costUsd: Number(meta.cost_usd ?? 0) };
  };
}
