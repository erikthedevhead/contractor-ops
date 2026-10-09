/**
 * pnpm eval:trace <case-id> [iteration]
 * Prints the full agent trace of a case from the most recent eval run: every
 * turn's route, model, steps (tool calls, guards, A2A delegation, errors) and
 * reply, including the delegated Estimator runs.
 */
import { asSystem, createDb } from '@co/db';

const [caseId, iter] = process.argv.slice(2);
if (!caseId || !process.env.DATABASE_URL) {
  console.error('usage: pnpm eval:trace <case-id> [iteration]');
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL, { max: 1 });
const short = (v: unknown, n = 160) => (v === null || v === undefined ? '' : JSON.stringify(v).slice(0, n));

try {
  await asSystem(db, 'eval trace (operator CLI)', async (tx) => {
    const runs = await tx.selectFrom('agent_runs').selectAll()
      .where('eval_case_id', 'like', iter ? `${caseId}#${iter}` : `${caseId}#%`)
      .where('agent', '=', 'office_manager').orderBy('eval_case_id').orderBy('started_at').execute();
    if (!runs.length) return console.log('No traces (only the most recent eval run is kept).');
    for (const r of runs) {
      console.log(`\n=== ${r.eval_case_id} | intent=${r.intent} model=${r.model} status=${r.status} cost=$${Number(r.total_cost_usd).toFixed(4)}`);
      console.log(`user> ${r.user_input}`);
      const steps = await tx.selectFrom('agent_steps').selectAll().where('run_id', '=', r.id).orderBy('step_no').execute();
      for (const s of steps) {
        if (s.kind === 'llm') { console.log(`  ${s.step_no}. llm ${s.name} ${short((s.output as any)?.tool_uses ?? (s.output as any)?.stop_reason, 120)}`); continue; }
        console.log(`  ${s.step_no}. ${s.kind} ${s.name} in=${short(s.input, 120)}${s.error ? ` ERROR=${short(s.error)}` : ''}`);
      }
      const kids = await tx.selectFrom('agent_runs').select(['id', 'status', 'total_cost_usd']).where('parent_run_id', '=', r.id).execute();
      for (const k of kids) console.log(`  -> estimator run ${k.id} ${k.status} $${Number(k.total_cost_usd).toFixed(4)}`);
      console.log(`agent> ${(r.final_output ?? '').slice(0, 600)}`);
    }
  });
} finally {
  await db.destroy();
}
