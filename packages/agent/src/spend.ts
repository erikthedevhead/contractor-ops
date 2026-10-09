import { sql } from 'kysely';
import { withTenant, type Db } from '@co/db';

/**
 * Hard monthly spend cap per tenant, enforced with reserve-then-settle.
 *
 * Before each LLM call we reserve its worst-case cost; the reservation only
 * succeeds if spent + reserved + this call still fits under the cap. After
 * the call we settle: add the actual cost, release the reservation. Checking
 * "spent < cap" alone would let N concurrent requests all pass the check and
 * overshoot together; reservations make the cap hold under concurrency.
 */
export class SpendCapExceeded extends Error {
  constructor(readonly tenantId: string, readonly capUsd: number, readonly committedUsd: number) {
    super(`monthly spend cap of $${capUsd.toFixed(2)} reached`);
    this.name = 'SpendCapExceeded';
  }
}

export interface Reservation {
  tenantId: string;
  month: string;
  amountUsd: number;
}

export async function reserveSpend(db: Db, tenantId: string, amountUsd: number, now = new Date()): Promise<Reservation> {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  return withTenant(db, tenantId, async (tx) => {
    await tx.insertInto('tenant_spend').values({ tenant_id: tenantId, month }).onConflict((oc) => oc.columns(['tenant_id', 'month']).doNothing()).execute();
    const r = await sql<{ ok: boolean }>`
      UPDATE tenant_spend s SET reserved_usd = s.reserved_usd + ${amountUsd}
        FROM tenants t
       WHERE s.tenant_id = ${tenantId} AND s.month = ${month}::date AND t.id = s.tenant_id
         AND s.spent_usd + s.reserved_usd + ${amountUsd} <= t.monthly_spend_cap_usd
      RETURNING true AS ok`.execute(tx);
    if (!r.rows.length) {
      const cur = await sql<{ cap: string; committed: string }>`
        SELECT t.monthly_spend_cap_usd::text AS cap, (s.spent_usd + s.reserved_usd)::text AS committed
          FROM tenant_spend s JOIN tenants t ON t.id = s.tenant_id
         WHERE s.tenant_id = ${tenantId} AND s.month = ${month}::date`.execute(tx);
      throw new SpendCapExceeded(tenantId, Number(cur.rows[0]?.cap ?? 0), Number(cur.rows[0]?.committed ?? 0));
    }
    return { tenantId, month, amountUsd };
  });
}

/** Convert a reservation into actual spend (actual may be 0 if the call failed). */
export async function settleSpend(db: Db, r: Reservation, actualUsd: number): Promise<void> {
  await withTenant(db, r.tenantId, (tx) =>
    sql`UPDATE tenant_spend
           SET reserved_usd = greatest(reserved_usd - ${r.amountUsd}, 0),
               spent_usd = spent_usd + ${actualUsd}
         WHERE tenant_id = ${r.tenantId} AND month = ${r.month}::date`.execute(tx),
  );
}
