/**
 * pnpm eval [--iterations 3] [--cases L0,W02] [--concurrency 4]
 *
 * Runs the eval suite against REAL models (ANTHROPIC_API_KEY) in a hermetic
 * world on your LOCAL database. Writes docs/eval-report.md and stores results
 * in eval_runs / eval_results. Expect roughly $2-4 for a full 3x run.
 */
import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { anthropicClient, MODELS } from '@co/agent';
import { CASES } from './cases';
import { renderMarkdown, summarize } from './report';
import { runEval, saveRun } from './runner';
import { setupEvalWorld } from './world';

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const iterations = Number(opt('iterations') ?? 3);
const concurrency = Number(opt('concurrency') ?? 4);
const filter = opt('cases')?.split(',').map((s) => s.trim()).filter(Boolean);
const out = opt('out') ?? 'docs/eval-report.md';

const key = process.env.ANTHROPIC_API_KEY;
const dbUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!key || !dbUrl || !ownerUrl) {
  console.error('Needs ANTHROPIC_API_KEY, DATABASE_URL and MIGRATION_DATABASE_URL in .env');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' || !/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
  console.error('Refusing to run evals against a non-local database.');
  process.exit(1);
}

const cases = filter ? CASES.filter((c) => filter.some((f) => c.id.startsWith(f))) : CASES;
if (!cases.length) {
  console.error(`No cases match ${filter?.join(',')}`);
  process.exit(1);
}
const gitSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; }
})();

console.log(`Eval: ${cases.length} cases x ${iterations} iterations = ${cases.length * iterations} runs (commit ${gitSha})`);
console.log('Setting up the eval world (two seeded tenants, MCP server, Estimator)...');
const startedAt = new Date();
const world = await setupEvalWorld({ databaseUrl: dbUrl, ownerUrl, capUsd: 15, label: gitSha });
try {
  const results = await runEval({
    world,
    llm: anthropicClient(key),
    cases,
    iterations,
    concurrency,
    onResult: (r) => console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.caseId} #${r.iteration}  $${r.costUsd.toFixed(4)}  ${(r.latencyMs / 1000).toFixed(1)}s${r.pass ? '' : `  [${r.failureMode}] ${r.detail.slice(0, 100)}`}`),
  });
  const summary = summarize(results);
  const readWorldWrites = world.read.fake.requests.filter((q) => q.method === 'POST').length;
  const md = renderMarkdown(summary, {
    gitSha, iterations, models: `${MODELS.fast} (routing, lookups), ${MODELS.smart} (analysis, estimates)`,
    startedAt: startedAt.toISOString(), durationS: Math.round((Date.now() - startedAt.getTime()) / 1000), readWorldWrites,
  }, cases);
  await writeFile(out, md);
  const runId = await saveRun(world, { gitSha, config: { iterations, concurrency, cases: cases.map((c) => c.id) } }, results, cases, summary);
  console.log(`\nAccuracy ${(summary.accuracy * 100).toFixed(1)}% (${summary.passed}/${summary.runs}) | flaky: ${summary.flakyCases.length} | tool correctness: ${summary.toolCorrectness === null ? 'n/a' : (summary.toolCorrectness * 100).toFixed(1) + '%'} | cost $${summary.totalCostUsd.toFixed(2)} | read-world writes: ${readWorldWrites}`);
  for (const c of summary.byCategory) console.log(`  ${c.category.padEnd(13)} ${(c.accuracy * 100).toFixed(0).padStart(3)}%  (${c.runs} runs, ${c.flaky} flaky)`);
  console.log(`\nReport: ${out}   eval_run: ${runId}`);
} finally {
  await world.close();
}
