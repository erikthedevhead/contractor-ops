// Usage: pnpm webhooks:reingest <deliveryId> [<deliveryId> ...]
// Re-parses stored, signature-verified webhook deliveries and queues any events
// not already recorded. Safe to repeat: events dedupe on their id.
import { createDb } from '@co/db';
import { env } from '@co/shared';
import { ingestStoredDelivery } from '../apps/api/src/webhooks';

const e = env();
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('usage: pnpm webhooks:reingest <deliveryId> [...]');
  process.exit(1);
}
const db = createDb(e.DATABASE_URL, { max: 1 });
try {
  for (const id of ids) {
    const r = await ingestStoredDelivery(db, id, e.QBO_ENV);
    console.log(`delivery ${id}: format=${r.format} accepted=${r.accepted} duplicates=${r.duplicates} ignored=${r.ignored} rejected=${r.rejected}`);
  }
} finally {
  await db.destroy();
}
