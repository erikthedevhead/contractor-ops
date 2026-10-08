import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSystem, withTenant } from '../src/client';
import { claim, complete, enqueue, fail, jobBackoffMs, reapStale, replayDeadLetter } from '../src/queue';
import { dropTenant, makeTenant, testDb } from './helpers';

const db = testDb();
let t: string;
const Q = `test-${Date.now()}`;

beforeAll(async () => { t = await makeTenant(db, 'queue'); });
afterAll(async () => { await dropTenant(db, t); await db.destroy(); });

const put = (payload: Record<string, unknown> = {}, opts: Parameters<typeof enqueue>[3] = {}) =>
  withTenant(db, t, (tx) => enqueue(tx, Q, payload, { tenantId: t, ...opts }));

describe('job queue', () => {
  it('dedupes on singleton key', async () => {
    const a = await put({}, { singletonKey: 'evt-A' });
    const b = await put({}, { singletonKey: 'evt-A' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const [job] = await claim(db, 'w', [Q], 10);
    await complete(db, job!);
  });

  it('concurrent workers never claim the same job (SKIP LOCKED)', async () => {
    for (let i = 0; i < 30; i++) await put({ i });
    const seen: string[] = [];
    await Promise.all(
      Array.from({ length: 5 }, async (_, w) => {
        for (;;) {
          const jobs = await claim(db, `w${w}`, [Q], 2);
          if (!jobs.length) return;
          for (const j of jobs) {
            seen.push(j.id);
            await complete(db, j);
          }
        }
      }),
    );
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('claim(limit) locks exactly limit jobs, never more', async () => {
    for (let i = 0; i < 5; i++) await put({ i });
    const got = await claim(db, 'w', [Q], 1);
    const running = await asSystem(db, 'test', (tx) => tx.selectFrom('jobs').select('id').where('queue', '=', Q).where('status', '=', 'running').execute());
    expect(got).toHaveLength(1);
    expect(running).toHaveLength(1);
    for (const j of [...got, ...(await claim(db, 'w', [Q], 10))]) await complete(db, j);
  });

  it('retryable failures back off; exhausting attempts dead-letters the job', async () => {
    await put({ poison: true }, { maxAttempts: 2 });
    let [job] = await claim(db, 'w', [Q]);
    expect(await fail(db, job!, { error: { code: 'QBO_UNAVAILABLE' }, retryable: true }, () => 0.5)).toBe('retry');
    expect(await claim(db, 'w', [Q])).toHaveLength(0); // scheduled in the future

    await asSystem(db, 'test', (tx) => tx.updateTable('jobs').set({ run_at: new Date() }).where('id', '=', job!.id).execute());
    [job] = await claim(db, 'w', [Q]);
    expect(job!.attempts).toBe(2);
    expect(await fail(db, job!, { error: { code: 'QBO_UNAVAILABLE' }, retryable: true })).toBe('dead');

    const dl = await asSystem(db, 'test', (tx) => tx.selectFrom('dead_letters').selectAll().where('source_job_id', '=', job!.id).executeTakeFirstOrThrow());
    expect(dl.attempts).toBe(2);
    expect((dl.error as { reason: string }).reason).toBe('max_attempts');

    // Replay: back on the queue with a fresh budget.
    expect(await replayDeadLetter(db, dl.id)).toEqual({ jobId: job!.id });
    const [again] = await claim(db, 'w', [Q]);
    expect(again!.id).toBe(job!.id);
    expect(again!.attempts).toBe(1);
    await complete(db, again!);
  });

  it('non-retryable errors dead-letter immediately', async () => {
    await put({}, { maxAttempts: 6 });
    const [job] = await claim(db, 'w', [Q]);
    expect(await fail(db, job!, { error: { code: 'QBO_REAUTH_REQUIRED' }, retryable: false })).toBe('dead');
  });

  it('reaps jobs abandoned by a crashed worker', async () => {
    await put();
    const [job] = await claim(db, 'crashed', [Q]);
    await asSystem(db, 'test', (tx) => tx.updateTable('jobs').set({ locked_at: new Date(Date.now() - 3_600_000) }).where('id', '=', job!.id).execute());
    expect(await reapStale(db)).toBeGreaterThanOrEqual(1);
    const [again] = await claim(db, 'w', [Q]);
    expect(again!.id).toBe(job!.id);
    await complete(db, again!);
  });

  it('jobs are tenant-isolated like everything else', async () => {
    const other = await makeTenant(db, 'queue-other');
    try {
      await put({ secret: 1 });
      const visible = await withTenant(db, other, (tx) => tx.selectFrom('jobs').selectAll().where('queue', '=', Q).execute());
      expect(visible).toHaveLength(0);
    } finally {
      await dropTenant(db, other);
    }
  });

  it('backoff grows and stays capped', () => {
    expect(jobBackoffMs(1, () => 0.999)).toBeLessThan(10_000);
    expect(jobBackoffMs(20, () => 0.999)).toBeLessThanOrEqual(30 * 60_000);
    expect(jobBackoffMs(3, () => 0)).toBe(1000);
  });
});
