import { sql } from 'kysely';
import { asSystem, type Db, type Tx } from './client';
import type { Jobs } from './db-types';
import type { Selectable } from 'kysely';

/**
 * Postgres job queue.
 *
 * - enqueue: optionally inside the caller's transaction, so "persist the event"
 *   and "schedule its processing" commit or roll back together.
 * - claim:   UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED): any
 *   number of workers can poll concurrently and never take the same job.
 * - fail:    retryable errors back off exponentially with jitter; after
 *   max_attempts (or a non-retryable error) the job is marked dead and copied
 *   into dead_letters, where it can be inspected and replayed.
 * - reap:    jobs stuck in 'running' (worker crashed mid-job) go back to the
 *   queue; the attempt still counts, so a poison job can't loop forever.
 */
export type Job = Selectable<Jobs>;

export interface EnqueueOptions {
  tenantId?: string | null;
  singletonKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** Returns the job id, or null when a job with the same singleton key already exists. */
export async function enqueue(tx: Tx, queue: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<string | null> {
  const row = await tx
    .insertInto('jobs')
    .values({
      queue,
      payload: JSON.stringify(payload),
      tenant_id: opts.tenantId ?? null,
      singleton_key: opts.singletonKey ?? null,
      run_at: opts.runAt ?? new Date(),
      max_attempts: opts.maxAttempts ?? 6,
    })
    .onConflict((oc) => oc.columns(['queue', 'singleton_key']).where('singleton_key', 'is not', null).doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function claim(db: Db, workerId: string, queues: string[], limit = 1): Promise<Job[]> {
  return asSystem(db, 'job queue: claim', async (tx) => {
    // MATERIALIZED matters: with a plain `WHERE id IN (SELECT ... LIMIT n)`
    // Postgres may re-run the subquery and lock more than n rows, leaving
    // jobs marked 'running' that no caller received. (Caught by the
    // out-of-order webhook test.)
    const res = await sql<Job>`
      WITH next AS MATERIALIZED (
        SELECT id FROM jobs
        WHERE status IN ('queued', 'failed') AND run_at <= now() AND queue = ANY(${queues})
        ORDER BY run_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = jobs.attempts + 1
      FROM next WHERE jobs.id = next.id
      RETURNING jobs.*`.execute(tx);
    return res.rows;
  });
}

export async function complete(db: Db, job: Job): Promise<void> {
  await asSystem(db, 'job queue: complete', (tx) =>
    tx.updateTable('jobs').set({ status: 'completed', completed_at: new Date(), locked_at: null, locked_by: null, last_error: null })
      .where('id', '=', job.id).where('status', '=', 'running').execute(),
  );
}

export interface FailInfo {
  error: Record<string, unknown>;
  retryable: boolean;
}

/** Backoff for job-level retries: 10s, 20s, 40s ... capped at 30 min, with full jitter. */
export function jobBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30 * 60_000, 10_000 * 2 ** (attempt - 1));
  return Math.max(1_000, Math.floor(random() * ceiling));
}

export async function fail(db: Db, job: Job, info: FailInfo, random: () => number = Math.random): Promise<'retry' | 'dead'> {
  const exhausted = job.attempts >= job.max_attempts;
  const dead = !info.retryable || exhausted;
  await asSystem(db, 'job queue: fail', async (tx) => {
    if (dead) {
      await tx.updateTable('jobs').set({ status: 'dead', locked_at: null, locked_by: null, last_error: JSON.stringify(info.error) })
        .where('id', '=', job.id).execute();
      await tx
        .insertInto('dead_letters')
        .values({
          tenant_id: job.tenant_id,
          queue: job.queue,
          job_id: String(job.id),
          source_job_id: job.id,
          payload: JSON.stringify(job.payload),
          error: JSON.stringify({ ...info.error, reason: exhausted ? 'max_attempts' : 'non_retryable' }),
          attempts: job.attempts,
        })
        .onConflict((oc) => oc.columns(['queue', 'job_id']).doUpdateSet({
          error: (eb) => eb.ref('excluded.error'), attempts: (eb) => eb.ref('excluded.attempts'), failed_at: new Date(), replayed_at: null,
        }))
        .execute();
    } else {
      await tx.updateTable('jobs')
        .set({ status: 'failed', locked_at: null, locked_by: null, last_error: JSON.stringify(info.error), run_at: new Date(Date.now() + jobBackoffMs(job.attempts, random)) })
        .where('id', '=', job.id).execute();
    }
  });
  return dead ? 'dead' : 'retry';
}

/** Return jobs abandoned by a crashed worker to the queue. */
export async function reapStale(db: Db, staleAfterMs = 10 * 60_000): Promise<number> {
  return asSystem(db, 'job queue: reap', async (tx) => {
    const res = await tx.updateTable('jobs')
      .set({ status: 'failed', locked_at: null, locked_by: null, last_error: JSON.stringify({ code: 'WORKER_LOST', message: 'job lock expired' }), run_at: new Date() })
      .where('status', '=', 'running')
      .where('locked_at', '<', new Date(Date.now() - staleAfterMs))
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  });
}

/** Put a dead-lettered job back on the queue with a fresh attempt budget. */
export async function replayDeadLetter(db: Db, deadLetterId: string): Promise<{ jobId: string } | null> {
  return asSystem(db, 'job queue: replay', async (tx) => {
    const dl = await tx.selectFrom('dead_letters').selectAll().where('id', '=', deadLetterId).forUpdate().executeTakeFirst();
    if (!dl?.source_job_id) return null;
    await tx.updateTable('jobs').set({ status: 'queued', attempts: 0, run_at: new Date(), last_error: null })
      .where('id', '=', dl.source_job_id).execute();
    await tx.updateTable('dead_letters').set({ replayed_at: new Date() }).where('id', '=', dl.id).execute();
    return { jobId: dl.source_job_id };
  });
}
