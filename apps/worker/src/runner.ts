import { hostname } from 'node:os';
import { asSystem, claim, complete, enqueue, fail, reapStale, type Db } from '@co/db';
import { isAppError, logger as baseLogger, type Logger } from '@co/shared';
import { handlers as defaultHandlers, type Handler, type HandlerDeps } from './handlers';
import { Q } from './queues';

export interface WorkerOptions extends HandlerDeps {
  handlers?: Record<string, Handler>;
  pollMs?: number;
  /** UTC hour at which the nightly CDC reconcile is scheduled (default 08:00 UTC = 3am Central). */
  reconcileHourUtc?: number;
  log?: Logger;
}

/**
 * Single-process worker loop: claim -> run -> complete/fail, plus two
 * housekeeping duties on a slower tick: reap jobs from crashed workers and
 * schedule the nightly CDC reconcile (one per tenant per day, via singleton key).
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}`;
  private running = false;
  private loop?: Promise<void>;
  private lastHousekeeping = 0;
  private readonly log: Logger;
  private readonly handlers: Record<string, Handler>;

  constructor(private readonly opts: WorkerOptions) {
    this.log = opts.log ?? baseLogger;
    this.handlers = opts.handlers ?? defaultHandlers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.log.info({ worker: this.id, queues: Object.keys(this.handlers) }, 'worker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.log.info({ worker: this.id }, 'worker stopped');
  }

  /** Processes ready jobs until none are left. Used by tests and the CLI. */
  async drain(maxJobs = 1000): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.tick())) n++;
    return n;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastHousekeeping > 60_000) await this.housekeeping();
        const worked = await this.tick();
        if (!worked) await sleep(this.opts.pollMs ?? 1000);
      } catch (err) {
        this.log.error({ err: String(err) }, 'worker loop error');
        await sleep(5000);
      }
    }
  }

  /** Claim and run one job. Returns false if nothing was ready. */
  async tick(): Promise<boolean> {
    const [job] = await claim(this.opts.db, this.id, Object.keys(this.handlers), 1);
    if (!job) return false;
    const handler = this.handlers[job.queue]!;
    const started = performance.now();
    try {
      const result = await handler(job, this.opts);
      await complete(this.opts.db, job);
      this.log.info({ jobId: job.id, queue: job.queue, tenantId: job.tenant_id, ms: Math.round(performance.now() - started), result }, 'job completed');
    } catch (err) {
      const retryable = isAppError(err) ? err.retryable : true; // unknown errors: assume transient
      const error = isAppError(err) ? err.toJSON() : { code: 'UNEXPECTED', message: String(err) };
      const outcome = await fail(this.opts.db, job, { error, retryable });
      const level = outcome === 'dead' ? 'error' : 'warn';
      this.log[level]({ jobId: job.id, queue: job.queue, tenantId: job.tenant_id, attempt: job.attempts, outcome, error }, 'job failed');
    }
    return true;
  }

  async housekeeping(now = new Date()): Promise<void> {
    this.lastHousekeeping = Date.now();
    const reaped = await reapStale(this.opts.db);
    if (reaped) this.log.warn({ reaped }, 'requeued jobs from a lost worker');
    if (now.getUTCHours() >= (this.opts.reconcileHourUtc ?? 8)) await scheduleDailyReconcile(this.opts.db, now);
  }
}

/** One reconcile job per active connection per UTC day. Safe to call repeatedly. */
export async function scheduleDailyReconcile(db: Db, now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  return asSystem(db, 'schedule nightly reconcile', async (tx) => {
    const conns = await tx.selectFrom('qbo_connections').select('tenant_id').where('status', '=', 'active').execute();
    let n = 0;
    for (const c of conns) {
      if (await enqueue(tx, Q.reconcile, {}, { tenantId: c.tenant_id, singletonKey: `${c.tenant_id}:${day}` })) n++;
    }
    return n;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
