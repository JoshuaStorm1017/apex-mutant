#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { readProject, planProject } from './project.js';
import { runMutations } from './runner.js';
import { validateWithSalesforce } from './salesforce.js';
import { summarize, reportExitCode } from './report.js';

const help = `Apex Mutant — mutation testing for Salesforce Apex

Usage:
  apex-mutant plan [options]
  apex-mutant run --target-org <alias> --tests <TestClass> [options]

Commands:
  plan    Parse Apex and list mutations locally. No Salesforce CLI required.
  run     Baseline + sequential mutants using Salesforce validation only.

Options:
  --project <dir>           SFDX project (default: current directory)
  --include <path>          Exact project-relative file or directory; repeatable
  --exclude <path>          Exclude mutation targets; repeatable
  --operators <names>       Comma-separated operator IDs from plan output
  --max-mutants <count>     Limit cost with a deterministic subset
  --output <dir>            Report directory (default: .apex-mutant)
  --json                    Print the plan or completed report as JSON
  --target-org <alias>       Explicit Salesforce org alias (run only)
  --tests <names>           Test class names, comma-separated or repeatable
  --wait <minutes>          Salesforce wait per validation (default: 10)
  --timeout <seconds>       Hard process timeout per validation (default: 660)
  --threshold <percent>     Fail below mutation score (default: 0)
  --help                    Show this help

Source is never edited; run sends Apex-only snapshots via --dry-run.
Existing non-Apex dependencies must already be installed in the target org.
Use a disposable sandbox/scratch org. See README for validation limitations.
Exit codes: 0 success, 1 below threshold, 2 incomplete/error/no score.
`;

function numberOption(value: string | undefined, fallback: number, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!value.trim()) throw new Error(`${name} needs a number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
    project: { type: 'string' }, include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    operators: { type: 'string' }, 'max-mutants': { type: 'string' }, output: { type: 'string' },
    'target-org': { type: 'string' }, tests: { type: 'string', multiple: true },
    wait: { type: 'string' }, timeout: { type: 'string' }, threshold: { type: 'string' },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['plan', 'run'].includes(command)) throw new Error('Expected plan or run. Use --help.');
  const maxMutants = values['max-mutants'] === undefined ? undefined : numberOption(values['max-mutants'], 0, '--max-mutants');
  if (maxMutants !== undefined && !Number.isInteger(maxMutants)) throw new Error('--max-mutants must be an integer.');
  const waitMinutes = numberOption(values.wait, 10, '--wait', 1, 1440);
  if (!Number.isInteger(waitMinutes)) throw new Error('--wait must be an integer.');
  const timeoutMs = numberOption(values.timeout, 660, '--timeout', 1, 86400) * 1000;
  const threshold = numberOption(values.threshold, 0, '--threshold', 0, 100);
  const project = await readProject(values.project ?? '.');
  const output = resolve(values.output ?? join(project.root, '.apex-mutant'));
  // Never place report files among metadata being validated.
  for (const directory of project.packageDirs) {
    const path = relative(resolve(project.root, directory), output);
    if (!path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) throw new Error('--output must be outside package directories.');
  }
  const mutations = planProject(project, { include: values.include, exclude: values.exclude,
    operators: values.operators?.split(',').map((v) => v.trim()).filter(Boolean), maxMutants });
  if (command === 'plan') {
    const plan = { schemaVersion: 1, total: mutations.length, mutations };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    if (values.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Apex Mutant · ${mutations.length} mutations planned`);
      for (const m of mutations) console.log(`${m.id}  ${m.file}:${m.line}:${m.column}  ${m.operator}  ${JSON.stringify(m.original)} → ${JSON.stringify(m.replacement)}`);
      console.log(`\nPlan saved to ${join(output, 'plan.json')}`);
      console.log('No Salesforce requests made.');
    }
    if (!mutations.length) process.exitCode = 2;
    return;
  }
  const tests = (values.tests ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  if (!values['target-org']?.trim() || !tests.length) throw new Error('run requires --target-org and --tests. Use plan for offline generation.');
  const abort = new AbortController();
  const cancel = () => { console.error('Stopping; preserving completed results.'); abort.abort(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    console.error(`Validating baseline, then up to ${mutations.length} mutants. Every request uses --dry-run.`);
    const report = await runMutations(project, mutations, {
      targetOrg: values['target-org'], tests, waitMinutes, timeoutMs, output, signal: abort.signal,
      onProgress: (done, total, result) => console.error(`[${done}/${total}] ${result.outcome}`),
    }, validateWithSalesforce);
    const summary = summarize(report);
    if (values.json) console.log(JSON.stringify({ ...report, summary }, null, 2));
    else {
      console.log(`Baseline: ${report.baseline.outcome}${report.baseline.message ? ` — ${report.baseline.message}` : ''}`);
      console.log(`Mutation score: ${summary.score === null ? 'N/A' : summary.score.toFixed(1) + '%'}`);
      console.log(`Killed ${summary.killed} · survived ${summary.survived} · invalid ${summary.invalid} · timeout ${summary.timeout} · error ${summary.error}`);
      console.log(`Report: ${join(output, 'report.html')}`);
    }
    process.exitCode = abort.signal.aborted ? 130 : reportExitCode(report, threshold);
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

main().catch((error: unknown) => {
  console.error(`Apex Mutant: ${error instanceof Error ? error.message : 'Unexpected failure.'}`);
  process.exitCode = 2;
});
