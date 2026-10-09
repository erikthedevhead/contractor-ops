import type { Category, EvalCase } from './cases';
import type { CaseRunResult } from './runner';

export interface Summary {
  runs: number;
  passed: number;
  accuracy: number;
  cases: number;
  stableCases: number;       // same outcome on every iteration
  flakyCases: string[];      // mixed outcomes across iterations
  toolCorrectness: number | null;
  totalCostUsd: number;
  avgCostPerRunUsd: number;
  byCategory: Array<{ category: Category; cases: number; runs: number; accuracy: number; flaky: number; avgCostUsd: number; avgLatencyMs: number }>;
  failureModes: Array<{ mode: string; count: number; cases: string[]; example: string }>;
  perCase: Array<{ id: string; category: Category; outcomes: boolean[]; avgCostUsd: number; toolsOk: boolean | null; lastDetail: string }>;
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(results: CaseRunResult[]): Summary {
  const byCase = new Map<string, CaseRunResult[]>();
  for (const r of results) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  const flaky = [...byCase].filter(([, rs]) => new Set(rs.map((r) => r.pass)).size > 1).map(([id]) => id);
  const withTools = results.filter((r) => r.toolsOk !== null);

  const cats = [...new Set(results.map((r) => r.category))];
  const byCategory = cats.map((category) => {
    const rs = results.filter((r) => r.category === category);
    const ids = new Set(rs.map((r) => r.caseId));
    return {
      category,
      cases: ids.size,
      runs: rs.length,
      accuracy: round(rs.filter((r) => r.pass).length / rs.length, 3),
      flaky: flaky.filter((id) => ids.has(id)).length,
      avgCostUsd: round(avg(rs.map((r) => r.costUsd))),
      avgLatencyMs: Math.round(avg(rs.map((r) => r.latencyMs))),
    };
  });

  const modes = new Map<string, CaseRunResult[]>();
  for (const r of results) if (!r.pass && r.failureMode) modes.set(r.failureMode, [...(modes.get(r.failureMode) ?? []), r]);

  const total = results.reduce((s, r) => s + r.costUsd, 0);
  return {
    runs: results.length,
    passed: results.filter((r) => r.pass).length,
    accuracy: round(results.filter((r) => r.pass).length / Math.max(1, results.length), 3),
    cases: byCase.size,
    stableCases: byCase.size - flaky.length,
    flakyCases: flaky,
    toolCorrectness: withTools.length ? round(withTools.filter((r) => r.toolsOk).length / withTools.length, 3) : null,
    totalCostUsd: round(total),
    avgCostPerRunUsd: round(total / Math.max(1, results.length)),
    byCategory,
    failureModes: [...modes].sort((a, b) => b[1].length - a[1].length).map(([mode, rs]) => ({
      mode, count: rs.length, cases: [...new Set(rs.map((r) => r.caseId))], example: `${rs[0]!.caseId}: ${rs[0]!.detail}`.slice(0, 220),
    })),
    perCase: [...byCase].map(([id, rs]) => ({
      id, category: rs[0]!.category, outcomes: rs.map((r) => r.pass), avgCostUsd: round(avg(rs.map((r) => r.costUsd))),
      toolsOk: rs.some((r) => r.toolsOk === null) ? null : rs.every((r) => r.toolsOk), lastDetail: rs.at(-1)!.detail.slice(0, 140),
    })),
  };
}

export function renderMarkdown(s: Summary, meta: { gitSha: string; iterations: number; models: string; startedAt: string; durationS: number; readWorldWrites: number }, cases: EvalCase[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const usd = (x: number) => `$${x.toFixed(4)}`;
  const desc = new Map(cases.map((c) => [c.id, c.description]));
  const lines = [
    '# Eval report',
    '',
    `Generated ${meta.startedAt} at commit \`${meta.gitSha}\` · ${s.cases} cases × ${meta.iterations} iterations = ${s.runs} runs · ${meta.durationS}s · models: ${meta.models}`,
    '',
    'Data is a hermetic seeded world (fake QuickBooks, "today" pinned to the seed anchor); the models, MCP server, A2A Estimator and agent loop are real. Ground truth comes from the seed plan and is pinned to hand-verified figures in `evals/test/ground-truth.unit.test.ts`.',
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Accuracy (all runs) | **${pct(s.accuracy)}** (${s.passed}/${s.runs}) |`,
    `| Stable cases (same outcome every iteration) | ${s.stableCases}/${s.cases} |`,
    `| Flaky cases | ${s.flakyCases.length ? s.flakyCases.join(', ') : 'none'} |`,
    `| Tool-call correctness (cases with expected tools) | ${s.toolCorrectness === null ? 'n/a' : pct(s.toolCorrectness)} |`,
    `| Writes to the read-only tenant | ${meta.readWorldWrites} (must be 0) |`,
    `| Total model cost | ${usd(s.totalCostUsd)} |`,
    `| Average cost per run (all agents) | ${usd(s.avgCostPerRunUsd)} |`,
    '',
    '## By category',
    '',
    '| Category | Cases | Runs | Accuracy | Flaky | Avg cost/run | Avg latency |',
    '|---|---|---|---|---|---|---|',
    ...s.byCategory.map((c) => `| ${c.category} | ${c.cases} | ${c.runs} | ${pct(c.accuracy)} | ${c.flaky} | ${usd(c.avgCostUsd)} | ${(c.avgLatencyMs / 1000).toFixed(1)}s |`),
    '',
    '## Failure modes',
    '',
    s.failureModes.length ? '| Mode | Runs | Cases | Example |' : 'No failures.',
    ...(s.failureModes.length ? ['|---|---|---|---|', ...s.failureModes.map((f) => `| ${f.mode} | ${f.count} | ${f.cases.join(', ')} | ${f.example.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)] : []),
    '',
    '## Per case',
    '',
    '| Case | Category | Description | Results | Tools | Avg cost |',
    '|---|---|---|---|---|---|',
    ...s.perCase.map((c) => `| ${c.id} | ${c.category} | ${desc.get(c.id) ?? ''} | ${c.outcomes.map((o) => (o ? '✅' : '❌')).join('')} | ${c.toolsOk === null ? '·' : c.toolsOk ? '✅' : '❌'} | ${usd(c.avgCostUsd)} |`),
    '',
  ];
  return lines.join('\n');
}
