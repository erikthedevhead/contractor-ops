/**
 * Deterministic seed data for a small remodeling contractor.
 *
 * Pure function of (anchor date, PRNG seed): the same inputs always produce
 * the same customers, jobs, line items and payment pattern. Eval ground truth
 * is derived from the same plan, so the two can never disagree.
 *
 * Deliberately planted edge cases (see EDGE_CASES at the bottom):
 *   - two customers with similar names ("Mark Johnson" / "Johnson Property Management")
 *   - a customer with no job history (refusal case)
 *   - an invoice exactly 61 days past due, a partially paid invoice, 90+ day balances
 *   - an expired-but-still-pending estimate and a rejected estimate
 */

export interface CatalogItem {
  key: string;
  name: string;
  unitPrice: number;
  description: string;
}

export const ITEMS: CatalogItem[] = [
  { key: 'demo', name: 'Demo & Haul-Away', unitPrice: 1450, description: 'Demolition, debris removal and haul-away (per room)' },
  { key: 'plumb_rough', name: 'Plumbing Rough-In', unitPrice: 1850, description: 'Supply/drain relocation and rough-in (per room)' },
  { key: 'tile_std', name: 'Tile Install - Standard (sq ft)', unitPrice: 12, description: 'Ceramic/porcelain tile installed, standard layout' },
  { key: 'tile_prem', name: 'Tile Install - Premium (sq ft)', unitPrice: 22, description: 'Large-format or natural stone tile, complex layout' },
  { key: 'vanity', name: 'Vanity Install (each)', unitPrice: 650, description: 'Set, level and connect vanity and top' },
  { key: 'toilet', name: 'Toilet Install (each)', unitPrice: 325, description: 'Remove and install toilet, new flange and supply' },
  { key: 'shower_valve', name: 'Shower Valve & Trim', unitPrice: 780, description: 'Pressure-balance valve, trim and head install' },
  { key: 'shower_glass', name: 'Frameless Shower Glass (each)', unitPrice: 1950, description: 'Measured, fabricated and installed frameless enclosure' },
  { key: 'drywall_paint', name: 'Drywall & Paint (sq ft)', unitPrice: 4.5, description: 'Patch, tape, prime and two coats' },
  { key: 'cabinets', name: 'Cabinet Install (linear ft)', unitPrice: 185, description: 'Install base and wall cabinets, hardware, adjust' },
  { key: 'quartz', name: 'Countertop - Quartz (sq ft)', unitPrice: 85, description: 'Template, fabricate and install quartz countertop' },
  { key: 'backsplash', name: 'Backsplash Tile (sq ft)', unitPrice: 28, description: 'Backsplash tile with grout and caulk' },
  { key: 'appliance', name: 'Appliance Install (each)', unitPrice: 175, description: 'Set and connect appliance' },
  { key: 'circuit', name: 'Electrical Circuit (each)', unitPrice: 325, description: 'New dedicated circuit, permit-ready' },
  { key: 'lvp', name: 'LVP Flooring Install (sq ft)', unitPrice: 5.5, description: 'Luxury vinyl plank, floating install' },
  { key: 'hardwood_refinish', name: 'Hardwood Refinish (sq ft)', unitPrice: 4.25, description: 'Sand, stain and three coats finish' },
  { key: 'baseboard', name: 'Baseboard (linear ft)', unitPrice: 6, description: 'Remove/replace baseboard, caulk and paint' },
  { key: 'floor_prep', name: 'Floor Prep & Leveling (sq ft)', unitPrice: 2, description: 'Subfloor repair and self-leveler' },
  { key: 'permit', name: 'Permit & Inspection', unitPrice: 425, description: 'Permit filing and inspection scheduling' },
  { key: 'dumpster', name: 'Dumpster Rental', unitPrice: 495, description: '20-yard dumpster, one swap' },
  { key: 'pm_hours', name: 'Project Management (hr)', unitPrice: 95, description: 'Scheduling, coordination and site supervision' },
];

export interface SeedCustomer {
  key: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  companyName?: string;
  email: string;
  phone: string;
}

const person = (key: string, given: string, family: string, phone: string): SeedCustomer => ({
  key, displayName: `${given} ${family}`, givenName: given, familyName: family,
  email: `${given}.${family}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com', phone,
});
const company = (key: string, name: string, phone: string): SeedCustomer => ({
  key, displayName: name, companyName: name, email: name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/\.$/, '') + '@example.com', phone,
});

export const CUSTOMERS: SeedCustomer[] = [
  person('c_mark_johnson', 'Mark', 'Johnson', '(314) 555-0101'),
  company('c_johnson_pm', 'Johnson Property Management', '(314) 555-0102'),
  person('c_okafor', 'Sarah', 'Okafor', '(314) 555-0103'),
  person('c_kim', 'David', 'Kim', '(314) 555-0104'),
  person('c_alvarez', 'Linda', 'Alvarez', '(314) 555-0105'),
  person('c_brennan', 'Rachel', 'Brennan', '(314) 555-0106'),
  person('c_whitfield', 'Grace', 'Whitfield', '(314) 555-0107'),
  person('c_reed', 'Marcus', 'Reed', '(314) 555-0108'),
  person('c_lindqvist', 'Hannah', 'Lindqvist', '(314) 555-0109'),
  person('c_mendoza', 'Carlos', 'Mendoza', '(314) 555-0110'),
  person('c_raman', 'Priya', 'Raman', '(314) 555-0111'), // no jobs: refusal case
  person('c_park', 'Ellen', 'Park', '(314) 555-0112'),
  person('c_oconnor', 'James', "O'Connor", '(314) 555-0113'),
  person('c_schmidt', 'Nora', 'Schmidt', '(314) 555-0114'),
  company('c_westside', 'Westside Rentals LLC', '(314) 555-0115'),
  person('c_caldwell', 'Beth', 'Caldwell', '(314) 555-0116'),
];

export type JobType = 'bathroom' | 'kitchen' | 'flooring';
export type JobSize = 'small' | 'medium' | 'large';
export type Finish = 'standard' | 'premium';

export interface SeedLine { itemKey: string; qty: number; unitPrice: number; amount: number; description: string }

export interface SeedJob {
  key: string;            // J01..J40, stable
  customerKey: string;
  type: JobType;
  size: JobSize;
  finish: Finish;
  title: string;          // "Primary bathroom remodel - walk-in shower, double vanity"
  lines: SeedLine[];
  subtotal: number;
  estimate: { date: string; expirationDate: string; status: 'Pending' | 'Accepted' | 'Rejected' };
  invoice?: { date: string; dueDate: string };
  payments: Array<{ key: string; date: string; amount: number }>;
}

export interface SeedPlan {
  anchor: string;
  items: CatalogItem[];
  customers: SeedCustomer[];
  jobs: SeedJob[];
}

// ---------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ITEM = new Map(ITEMS.map((i) => [i.key, i]));

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function line(itemKey: string, qty: number): SeedLine {
  const item = ITEM.get(itemKey);
  if (!item) throw new Error(`unknown item ${itemKey}`);
  return { itemKey, qty, unitPrice: item.unitPrice, amount: round2(qty * item.unitPrice), description: item.description };
}

const SIZE_FACTOR: Record<JobSize, number> = { small: 0.6, medium: 1, large: 1.6 };

function bathroomLines(size: JobSize, finish: Finish, r: ReturnType<typeof prng>): { title: string; lines: SeedLine[] } {
  const f = SIZE_FACTOR[size];
  const tileSqft = Math.round((110 + r.int(-15, 25)) * f);
  const lines = [
    line('demo', 1),
    line('plumb_rough', 1),
    line(finish === 'premium' ? 'tile_prem' : 'tile_std', tileSqft),
    line('vanity', size === 'large' ? 2 : 1),
    line('toilet', 1),
    line('drywall_paint', Math.round(220 * f)),
    line('permit', 1),
  ];
  if (size !== 'small') lines.push(line('shower_valve', 1));
  if (finish === 'premium' && size !== 'small') lines.push(line('shower_glass', 1));
  if (size === 'large') lines.push(line('dumpster', 1), line('pm_hours', r.int(8, 14)));
  const room = { small: 'Half bath refresh', medium: 'Full bathroom remodel', large: 'Primary bathroom remodel' }[size];
  const detail = finish === 'premium' ? (size === 'small' ? 'stone tile, new vanity' : 'walk-in shower, frameless glass, premium tile') : 'tub/shower combo, standard tile';
  return { title: `${room} - ${detail}`, lines };
}

function kitchenLines(size: JobSize, finish: Finish, r: ReturnType<typeof prng>): { title: string; lines: SeedLine[] } {
  const f = SIZE_FACTOR[size];
  const cabinetFt = Math.round((22 + r.int(-3, 4)) * f);
  const lines = [
    line('demo', 1),
    line('cabinets', cabinetFt),
    line('quartz', Math.round(cabinetFt * 2.1)),
    line('backsplash', Math.round(cabinetFt * 1.6)),
    line('appliance', size === 'small' ? 2 : 4),
    line('permit', 1),
    line('dumpster', 1),
  ];
  if (size !== 'small') lines.push(line('plumb_rough', 1), line('circuit', size === 'large' ? 3 : 2));
  if (finish === 'premium') lines.push(line('pm_hours', r.int(10, 20)));
  const label = { small: 'Galley kitchen update', medium: 'Kitchen remodel', large: 'Full kitchen remodel with island' }[size];
  return { title: `${label} - ${finish === 'premium' ? 'custom cabinets, quartz' : 'stock cabinets, quartz'}`, lines };
}

function flooringLines(size: JobSize, finish: Finish, r: ReturnType<typeof prng>): { title: string; lines: SeedLine[] } {
  const sqft = Math.round((650 + r.int(-80, 120)) * SIZE_FACTOR[size]);
  const refinish = finish === 'premium' && r.next() < 0.5;
  const lines = refinish
    ? [line('hardwood_refinish', sqft), line('baseboard', Math.round(sqft * 0.35))]
    : [line('floor_prep', sqft), line('lvp', sqft), line('baseboard', Math.round(sqft * 0.35))];
  if (size === 'large') lines.push(line('dumpster', 1));
  return { title: refinish ? `Hardwood refinish - ${sqft} sq ft` : `LVP flooring install - ${sqft} sq ft`, lines };
}

// Job mix by customer. Mark Johnson deliberately has flooring history but no
// bathroom, so "draft an estimate for the Johnson bathroom remodel" has to
// lean on other customers' bathroom jobs.
const JOB_ASSIGNMENTS: Array<[string, JobType]> = [
  ['c_mark_johnson', 'flooring'],
  ['c_johnson_pm', 'flooring'], ['c_johnson_pm', 'bathroom'], ['c_johnson_pm', 'flooring'], ['c_johnson_pm', 'bathroom'],
  ['c_okafor', 'bathroom'], ['c_okafor', 'kitchen'],
  ['c_kim', 'bathroom'], ['c_kim', 'flooring'],
  ['c_alvarez', 'kitchen'], ['c_alvarez', 'bathroom'],
  ['c_brennan', 'bathroom'], ['c_brennan', 'flooring'],
  ['c_whitfield', 'kitchen'], ['c_whitfield', 'bathroom'],
  ['c_reed', 'bathroom'], ['c_reed', 'flooring'],
  ['c_lindqvist', 'kitchen'], ['c_lindqvist', 'flooring'],
  ['c_mendoza', 'bathroom'], ['c_mendoza', 'kitchen'],
  ['c_park', 'bathroom'], ['c_park', 'flooring'],
  ['c_oconnor', 'kitchen'], ['c_oconnor', 'bathroom'],
  ['c_schmidt', 'flooring'], ['c_schmidt', 'bathroom'],
  ['c_westside', 'flooring'], ['c_westside', 'bathroom'], ['c_westside', 'flooring'], ['c_westside', 'kitchen'], ['c_westside', 'bathroom'],
  ['c_caldwell', 'bathroom'], ['c_caldwell', 'kitchen'],
  ['c_okafor', 'flooring'], ['c_kim', 'bathroom'], ['c_reed', 'kitchen'], ['c_park', 'kitchen'], ['c_mendoza', 'flooring'], ['c_brennan', 'kitchen'],
];

export function buildPlan(anchor: string, seed = 20261007): SeedPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('anchor must be YYYY-MM-DD');
  const r = prng(seed);
  const n = JOB_ASSIGNMENTS.length;

  const jobs: SeedJob[] = JOB_ASSIGNMENTS.map(([customerKey, type], i) => {
    const key = `J${String(i + 1).padStart(2, '0')}`;
    const size = r.pick(['small', 'medium', 'medium', 'large'] as const);
    const finish = r.pick(['standard', 'standard', 'premium'] as const);
    const { title, lines } = type === 'bathroom' ? bathroomLines(size, finish, r) : type === 'kitchen' ? kitchenLines(size, finish, r) : flooringLines(size, finish, r);
    // Spread estimate dates from ~360 days ago up to ~6 days ago, oldest first.
    const daysAgo = Math.round(360 - (i * 354) / (n - 1)) + r.int(-3, 3);
    const estDate = addDays(anchor, -Math.max(daysAgo, 2));
    return {
      key, customerKey, type, size, finish, title, lines,
      subtotal: round2(lines.reduce((s, l) => s + l.amount, 0)),
      estimate: { date: estDate, expirationDate: addDays(estDate, 30), status: 'Accepted' as const },
      payments: [],
    };
  });

  // Lifecycle by age. Most recent five stay as open estimates.
  for (const [i, job] of jobs.entries()) {
    if (i >= n - 5) {
      job.estimate.status = 'Pending';
      continue;
    }
    // The three newest invoices are recent enough to be not yet due (the "current" aging bucket).
    const invDate = i >= n - 8
      ? addDays(anchor, -r.int(3, 12))
      : minDate(addDays(job.estimate.date, 10 + r.int(0, 14)), addDays(anchor, -1));
    if (job.estimate.date > invDate) job.estimate.date = addDays(invDate, -10);
    job.invoice = { date: invDate, dueDate: addDays(invDate, 30) };
    const overdue = daysBetween(job.invoice.dueDate, anchor);
    const total = job.subtotal;
    if (overdue > 75) {
      // Older work is mostly paid; payment lands 5..40 days after due.
      job.payments.push({ key: `${job.key}-P1`, date: minDate(addDays(job.invoice.dueDate, r.int(-10, 25)), anchor), amount: total });
    } else if (overdue > 30 && r.next() < 0.5) {
      job.payments.push({ key: `${job.key}-P1`, date: minDate(addDays(job.invoice.dueDate, r.int(-5, 10)), anchor), amount: total });
    }
  }

  applyEdgeCases(jobs, anchor);
  return { anchor, items: ITEMS, customers: CUSTOMERS, jobs };
}

/** Plant the cases the eval suite depends on, independent of PRNG luck. */
function applyEdgeCases(jobs: SeedJob[], anchor: string) {
  const invoiced = jobs.filter((j) => j.invoice);
  const byOverdue = (target: number) =>
    invoiced.reduce((best, j) =>
      Math.abs(daysBetween(j.invoice!.dueDate, anchor) - target) < Math.abs(daysBetween(best.invoice!.dueDate, anchor) - target) ? j : best);

  // Exactly 61 days past due, unpaid: boundary case for "more than 60 days".
  const j61 = byOverdue(61);
  j61.invoice!.dueDate = addDays(anchor, -61);
  j61.invoice!.date = minDate(j61.invoice!.date, addDays(j61.invoice!.dueDate, -30));
  j61.payments = [];
  keepEstimateBeforeInvoice(j61);

  // Exactly 60 days past due, unpaid: must NOT count as "more than 60".
  const j60 = invoiced.filter((j) => j !== j61).reduce((best, j) =>
    Math.abs(daysBetween(j.invoice!.dueDate, anchor) - 60) < Math.abs(daysBetween(best.invoice!.dueDate, anchor) - 60) ? j : best);
  j60.invoice!.dueDate = addDays(anchor, -60);
  j60.invoice!.date = minDate(j60.invoice!.date, addDays(j60.invoice!.dueDate, -30));
  j60.payments = [];
  keepEstimateBeforeInvoice(j60);

  // Partially paid, ~45 days overdue.
  const partial = invoiced.find((j) => j !== j61 && j !== j60 && daysBetween(j.invoice!.dueDate, anchor) > 35 && daysBetween(j.invoice!.dueDate, anchor) < 75)!;
  partial.payments = [{ key: `${partial.key}-P1`, date: addDays(partial.invoice!.dueDate, 5), amount: round2(partial.subtotal * 0.4) }];

  // Two old invoices left unpaid: the 90+ bucket.
  for (const target of [100, 160]) {
    const j = byOverdue(target);
    if (j !== j61 && j !== j60 && j !== partial) j.payments = [];
  }

  // A rejected estimate and an expired-but-pending one among the open estimates.
  const open = jobs.filter((j) => !j.invoice);
  if (open[0]) open[0].estimate.status = 'Rejected';
  if (open[1]) {
    open[1].estimate.date = addDays(anchor, -45);
    open[1].estimate.expirationDate = addDays(anchor, -15);
    open[1].estimate.status = 'Pending';
  }
}

function keepEstimateBeforeInvoice(j: SeedJob) {
  if (j.invoice && j.estimate.date > j.invoice.date) {
    j.estimate.date = addDays(j.invoice.date, -12);
    j.estimate.expirationDate = addDays(j.estimate.date, 30);
  }
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86_400_000);
}
const minDate = (a: string, b: string) => (a < b ? a : b);

export const EDGE_CASES = [
  'similar customer names: Mark Johnson / Johnson Property Management',
  'customer with no jobs: Priya Raman',
  'invoice exactly 61 days past due (counts as >60)',
  'invoice exactly 60 days past due (does not count as >60)',
  'partially paid invoice (40%)',
  'two invoices unpaid 90+ days past due; three invoices not yet due',
  'one Rejected estimate; one Pending estimate past its expiration date',
] as const;
