// Usage:
//   pnpm dlq list               -> dead-lettered jobs not yet replayed
//   pnpm dlq replay <id>        -> put one back on the queue with a fresh attempt budget
import { asSystem, createDb, replayDeadLetter } from '@co/db';
import { env } from '@co/shared';

const e = env();
const db = createDb(e.DATABASE_URL, { max: 1 });
const [cmd, id] = process.argv.slice(2);

try {
  if (cmd === 'replay' && id) {
    const r = await replayDeadLetter(db, id);
    console.log(r ? `Requeued job ${r.jobId}` : `No dead letter ${id}`);
  } else {
    const rows = await asSystem(db, 'dlq list (operator CLI)', (tx) =>
      tx.selectFrom('dead_letters').select(['id', 'tenant_id', 'queue', 'attempts', 'failed_at', 'error'])
        .where('replayed_at', 'is', null).orderBy('failed_at', 'desc').limit(50).execute(),
    );
    if (!rows.length) console.log('Dead-letter queue is empty.');
    for (const r of rows) {
      const err = r.error as { code?: string; message?: string; reason?: string };
      console.log(`#${r.id}  ${r.failed_at.toISOString()}  ${r.queue}  tenant=${r.tenant_id ?? '-'}  attempts=${r.attempts}  ${err.reason ?? ''}  ${err.code ?? ''}: ${err.message ?? ''}`);
    }
  }
} finally {
  await db.destroy();
}
