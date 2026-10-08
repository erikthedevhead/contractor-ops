/**
 * Seeder core, separated from the CLI so it can run against a fake QuickBooks
 * in tests. See scripts/seed-sandbox.ts for the idempotency design.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTenant, type Db } from '@co/db';
import type { QboClient } from '@co/qbo';
import { AppError, QBO_REQUEST_NS, uuidv5 } from '@co/shared';
import { buildPlan, CUSTOMERS, ITEMS, type SeedJob, type SeedPlan } from './catalog';

export interface SeedDeps {
  db: Db;
  client: QboClient;
  tenantId: string;
  anchor?: string;
  dryRun?: boolean;
  writeSpacingMs?: number;
  manifestPath?: string | null; // null = don't write
  log?: (msg: string) => void;
}

export interface SeedResult {
  anchor: string;
  created: number;
  reused: number;
  manifest: Record<string, unknown> | null;
}

type Created = { id: string; totalAmt?: number; reused: boolean };

/** QuickBooks query string literal: backslash-escape backslashes and single quotes (O'Connor). */
export const qstr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const { db, client, tenantId } = deps;
  const log = deps.log ?? console.log;
  const spacing = deps.writeSpacingMs ?? 150; // ~6-7 writes/s, under the sandbox's 10 req/s per realm
  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const requestId = (seedKey: string) => uuidv5(`${tenantId}:${seedKey}`, QBO_REQUEST_NS);
  let createdCount = 0;
  let reusedCount = 0;

  const anchor = await resolveAnchor(db, tenantId, deps.anchor, deps.dryRun ?? false);
  const plan = buildPlan(anchor);
  log(`Plan anchored at ${anchor}: ${plan.items.length} items, ${plan.customers.length} customers, ${plan.jobs.length} jobs`);

  if (deps.dryRun) {
    for (const j of plan.jobs) {
      log(`${j.key} ${j.customerKey.padEnd(16)} ${j.title.padEnd(62)} $${j.subtotal.toFixed(2).padStart(9)} ${j.estimate.status}${j.invoice ? ` inv ${j.invoice.date} due ${j.invoice.dueDate}` : ''}${j.payments.length ? ` paid ${j.payments.map((p) => p.amount).join('+')}` : ''}`);
    }
    return { anchor, created: 0, reused: 0, manifest: null };
  }

  /** Ledger check -> create -> ledger write. */
  async function ensure(seedKey: string, entity: string, doCreate: () => Promise<Created>): Promise<Created> {
    const existing = await withTenant(db, tenantId, (tx) =>
      tx.selectFrom('seed_ledger').select('qbo_id').where('seed_key', '=', seedKey).executeTakeFirst(),
    );
    if (existing) {
      reusedCount++;
      return { id: existing.qbo_id, reused: true };
    }
    const created = await doCreate();
    await withTenant(db, tenantId, (tx) =>
      tx
        .insertInto('seed_ledger')
        .values({ tenant_id: tenantId, seed_key: seedKey, entity_name: entity, qbo_id: created.id, qbo_request_id: requestId(seedKey) })
        .onConflict((oc) => oc.columns(['tenant_id', 'seed_key']).doNothing())
        .execute(),
    );
    createdCount++;
    await sleep(spacing);
    return created;
  }

  async function create(entity: string, seedKey: string, body: unknown): Promise<Created> {
    const res = await client.post<Record<string, { Id: string; TotalAmt?: number }>>(`/${entity.toLowerCase()}`, body, {
      requestId: requestId(seedKey),
      entityName: entity,
    });
    const obj = res[entity];
    if (!obj?.Id) throw new Error(`unexpected ${entity} create response`);
    return { id: obj.Id, totalAmt: obj.TotalAmt, reused: false };
  }

  async function createOrAdopt(entity: 'Item' | 'Customer', field: string, value: string, seedKey: string, body: unknown): Promise<Created> {
    try {
      return await create(entity, seedKey, body);
    } catch (err) {
      const dup = err instanceof AppError && err.code === 'QBO_VALIDATION' && err.opts.details?.qboCode === '6240';
      if (!dup) throw err;
      const found = await client.get<{ QueryResponse: Record<string, Array<{ Id: string }>> }>('/query', {
        query: { query: `select * from ${entity} where ${field} = ${qstr(value)}` },
        entityName: entity,
      });
      const id = found.QueryResponse[entity]?.[0]?.Id;
      if (!id) throw err;
      log(`  adopted existing ${entity} "${value}" (${id})`);
      return { id, reused: true };
    }
  }

  const incomeAccount = await findIncomeAccount(client);
  log(`Using income account ${incomeAccount.name} (${incomeAccount.id})`);

  const itemIds = new Map<string, string>();
  for (const it of ITEMS) {
    const r = await ensure(`item:${it.key}`, 'Item', () =>
      createOrAdopt('Item', 'Name', it.name, `item:${it.key}`, {
        Name: it.name, Type: 'Service', UnitPrice: it.unitPrice, Description: it.description, IncomeAccountRef: { value: incomeAccount.id },
      }));
    itemIds.set(it.key, r.id);
  }
  log(`Items ready (${itemIds.size})`);

  const customerIds = new Map<string, string>();
  for (const c of CUSTOMERS) {
    const r = await ensure(`customer:${c.key}`, 'Customer', () =>
      createOrAdopt('Customer', 'DisplayName', c.displayName, `customer:${c.key}`, {
        DisplayName: c.displayName,
        ...(c.givenName ? { GivenName: c.givenName, FamilyName: c.familyName } : {}),
        ...(c.companyName ? { CompanyName: c.companyName } : {}),
        PrimaryEmailAddr: { Address: c.email },
        PrimaryPhone: { FreeFormNumber: c.phone },
      }));
    customerIds.set(c.key, r.id);
  }
  log(`Customers ready (${customerIds.size})`);

  const manifestJobs = [];
  for (const job of plan.jobs) {
    const customerId = customerIds.get(job.customerKey)!;
    const lines = salesLines(job, itemIds);

    const est = await ensure(`estimate:${job.key}`, 'Estimate', () =>
      create('Estimate', `estimate:${job.key}`, {
        CustomerRef: { value: customerId },
        TxnDate: job.estimate.date,
        ExpirationDate: job.estimate.expirationDate,
        TxnStatus: job.estimate.status,
        PrivateNote: `seed:${job.key} ${job.type}/${job.size}/${job.finish}`,
        CustomerMemo: { value: job.title },
        Line: lines,
      }));

    let inv: Created | undefined;
    if (job.invoice) {
      const invoice = job.invoice;
      inv = await ensure(`invoice:${job.key}`, 'Invoice', () =>
        create('Invoice', `invoice:${job.key}`, {
          CustomerRef: { value: customerId },
          TxnDate: invoice.date,
          DueDate: invoice.dueDate,
          PrivateNote: `seed:${job.key}`,
          CustomerMemo: { value: job.title },
          LinkedTxn: [{ TxnId: est.id, TxnType: 'Estimate' }],
          Line: lines,
        }));
      if (inv.totalAmt !== undefined && Math.abs(inv.totalAmt - job.subtotal) > 0.005) {
        log(`  ! ${job.key}: QuickBooks total ${inv.totalAmt} != plan ${job.subtotal} (sales tax applied?)`);
      }
    }

    const payments = [];
    for (const p of job.payments) {
      const invoiceId = inv!.id;
      const pay = await ensure(`payment:${p.key}`, 'Payment', () =>
        create('Payment', `payment:${p.key}`, {
          CustomerRef: { value: customerId },
          TxnDate: p.date,
          TotalAmt: p.amount,
          Line: [{ Amount: p.amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }],
        }));
      payments.push({ ...p, qboId: pay.id });
    }

    manifestJobs.push({
      ...job,
      customerQboId: customerId,
      estimateQboId: est.id,
      invoiceQboId: inv?.id ?? null,
      invoiceTotalQbo: inv?.totalAmt ?? null,
      payments,
    });
  }

  const manifest = buildManifest(tenantId, plan, customerIds, itemIds, manifestJobs);
  if (deps.manifestPath !== null) {
    const out = deps.manifestPath ?? 'evals/fixtures/seed-manifest.json';
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(manifest, null, 2) + '\n');
    log(`Wrote ${out}`);
  }
  log(`Created ${createdCount} QuickBooks objects, ${reusedCount} already existed`);
  return { anchor, created: createdCount, reused: reusedCount, manifest };
}

function salesLines(job: SeedJob, itemIds: Map<string, string>) {
  return job.lines.map((l) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: l.amount,
    Description: l.description,
    SalesItemLineDetail: { ItemRef: { value: itemIds.get(l.itemKey)! }, Qty: l.qty, UnitPrice: l.unitPrice, TaxCodeRef: { value: 'NON' } },
  }));
}

async function findIncomeAccount(client: QboClient): Promise<{ id: string; name: string }> {
  const res = await client.get<{ QueryResponse: { Account?: Array<{ Id: string; Name: string; Active?: boolean }> } }>('/query', {
    query: { query: "select * from Account where AccountType = 'Income'" },
    entityName: 'Account',
  });
  const accounts = (res.QueryResponse.Account ?? []).filter((a) => a.Active !== false);
  const pick = accounts.find((a) => /^services?$/i.test(a.Name)) ?? accounts.find((a) => /service/i.test(a.Name)) ?? accounts[0];
  if (!pick) throw new Error('No active Income account found in the sandbox company');
  return { id: pick.Id, name: pick.Name };
}

async function resolveAnchor(db: Db, tenantId: string, requested: string | undefined, dryRun: boolean): Promise<string> {
  const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
  return withTenant(db, tenantId, async (tx) => {
    const row = await tx.selectFrom('seed_ledger').select('qbo_id').where('seed_key', '=', 'meta:anchor').executeTakeFirst();
    if (row) {
      if (requested && requested !== row.qbo_id) throw new Error(`This tenant was seeded with anchor ${row.qbo_id}; refusing to mix in ${requested}.`);
      return row.qbo_id;
    }
    const anchor = requested ?? today;
    if (!dryRun) {
      await tx
        .insertInto('seed_ledger')
        .values({ tenant_id: tenantId, seed_key: 'meta:anchor', entity_name: 'meta', qbo_id: anchor, qbo_request_id: uuidv5(`${tenantId}:meta:anchor`, QBO_REQUEST_NS) })
        .execute();
    }
    return anchor;
  });
}

function buildManifest(tenantId: string, plan: SeedPlan, customerIds: Map<string, string>, itemIds: Map<string, string>, jobs: unknown[]) {
  return {
    generatedAt: new Date().toISOString(),
    tenantId,
    anchor: plan.anchor,
    note: 'Ground truth source for evals. Regenerated by pnpm seed:sandbox; do not edit by hand.',
    items: plan.items.map((i) => ({ ...i, qboId: itemIds.get(i.key) })),
    customers: plan.customers.map((c) => ({ ...c, qboId: customerIds.get(c.key) })),
    jobs,
  };
}
