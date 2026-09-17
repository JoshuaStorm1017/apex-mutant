#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readProject, planProjectDetailed } from './project.js';
import { runMutations } from './runner.js';
import { validateWithSalesforce } from './salesforce.js';
import { classifyTargetOrg, assertSandboxOrScratch } from './orgSafety.js';
import { summarize, reportExitCode, assertOutputOutsidePackageDirs, writeFileAtomic } from './report.js';
import { buildFindings } from './findings.js';
import { advisoryNotice } from './policy.js';
import { EXPORT_FILENAMES, assertWorkItems, parseExportFormats } from './exports.js';
import { TOOL_NAME, VERSION } from './version.js';
import type { Validator, OrgClassifier, EnforcementPolicy } from './types.js';

const help = `Apex Mutant — mutation testing for Salesforce Apex

Usage:
  apex-mutant plan [options]
  apex-mutant doctor [options]
  apex-mutant run --target-org <alias> --tests <TestClass> [options]

Commands:
  plan    Parse Apex and list mutations locally. No Salesforce CLI required.
  doctor  Diagnose environment, project, and (optionally) org readiness. Offline
          by default; add --target-org for a read-only org-type check.
  run     Baseline + sequential mutants using Salesforce validation only.

Options:
  --project <dir>           SFDX project (default: current directory)
  --include <path>          Exact project-relative file or directory; repeatable
  --exclude <path>          Exclude mutation targets; repeatable
  --operators <names>       Comma-separated operator IDs from plan output
  --max-mutants <count>     Limit cost with a deterministic subset
  --output <dir>            Report directory (default: .apex-mutant)
  --json                    Print the plan, doctor report, or completed report as JSON
  --target-org <alias>       Explicit Salesforce org alias (run; optional for doctor)
  --tests <names>           Test class names, comma-separated or repeatable
  --wait <minutes>          Salesforce wait per validation (default: 10)
  --timeout <seconds>       Hard process timeout per validation (default: 660)
  --enforce                 Opt in to gating: exit 1 when the score is below
                            --threshold. Off by default (advisory reporting).
  --threshold <percent>     Score to gate on; only meaningful with --enforce
  --export <formats>        Also write csv, sarif, md (comma-separated, or all)
  --work-item <id>          Identifier recorded in every export; repeatable
  --help                    Show this help

Reporting is advisory by default: the mutation score never changes the exit code
unless you pass --enforce with a --threshold you chose deliberately.

Suppressing a mutant no test could ever kill (an equivalent mutant) is done in the
Apex source itself, and always with a stated reason:
  // apex-mutant-disable-next-line conditional-boundary: index is never 0 here
  // apex-mutant-disable-line all: unreachable by construction
Suppressed mutants are never validated, never scored, and always listed in the
report with their reason. A marker with no reason, an unknown operator, or one that
matches nothing is reported as a problem and honors nothing.
Source is never edited; run sends Apex-only snapshots via --dry-run.
Existing non-Apex dependencies must already be installed in the target org.
run only proceeds against an org the Salesforce CLI itself classifies as a
sandbox or scratch org (via \`sf org list auth\`); there is no override flag.
See README for validation limitations, including native-Windows support.
Exit codes: 0 run produced a readable result, 1 below --threshold (only with
--enforce), 2 the run produced no readable result (failed baseline, incomplete
run, environment error, or nothing scored), 130 interrupted.
`;

function numberOption(value: string | undefined, fallback: number, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!value.trim()) throw new Error(`${name} needs a number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

interface SfCliStatus { available: boolean; detail: string }

/** Same shell:false/bounded-output/timeout hardening as validateWithSalesforce and
 * classifyTargetOrg. Native Windows is skipped rather than attempted: Node's spawn
 * without a shell has known problems invoking the .cmd shim an npm-installed CLI
 * uses there (see README's "Known alpha limitations"). */
async function checkSalesforceCli(): Promise<SfCliStatus> {
  if (process.platform === 'win32') {
    return { available: false, detail: 'Skipped on native Windows (Node cannot safely spawn the sf.cmd shim with shell:false). Run doctor from WSL, macOS, or Linux for an automatic check, or run `sf --version` yourself.' };
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    const finish = (result: SfCliStatus) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(result); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ available: false, detail: 'Timed out running `sf --version`.' }); }, 10_000);
    try {
      child = spawn('sf', ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ available: false, detail: 'Not found on PATH. Install: https://developer.salesforce.com/tools/salesforcecli' });
      return;
    }
    child.stdout!.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= MAX_DOCTOR_OUTPUT_BYTES) stdout.push(chunk); });
    child.on('error', () => finish({ available: false, detail: 'Not found on PATH. Install: https://developer.salesforce.com/tools/salesforcecli' }));
    child.on('close', (code) => finish(code === 0
      ? { available: true, detail: Buffer.concat(stdout).toString('utf8').trim().split('\n')[0] ?? 'sf CLI found' }
      : { available: false, detail: `\`sf --version\` exited with code ${code}.` }));
  });
}
const MAX_DOCTOR_OUTPUT_BYTES = 64 * 1024;

interface PlanFilters { include?: string[]; exclude?: string[]; operators?: string[]; maxMutants?: number }

/** Fully offline unless --target-org is given, in which case it adds one read-only
 * `sf org list auth` check (see orgSafety.ts). Never fails hard on a bad project or
 * missing sf CLI — that's the diagnosis doctor exists to report — but sets a non-zero
 * exit code when it found something `plan`/`run` would actually reject. */
async function runDoctor(projectDir: string, filters: PlanFilters, targetOrg: string | undefined, json: boolean, classifyOrg: OrgClassifier): Promise<void> {
  const problems: string[] = [];
  const report: Record<string, unknown> = {
    node: process.version, platform: process.platform, arch: process.arch,
    nodeEngineExpectation: '^22.13.0 || >=24 (see package.json "engines")',
  };

  try {
    const project = await readProject(projectDir);
    const plan = planProjectDetailed(project, filters);
    const mutations = plan.mutations;
    const targetedFiles = new Set(mutations.map((m) => m.file)).size;
    const totalApexFiles = [...project.files.keys()].filter((f) => /\.(cls|trigger)$/i.test(f)).length;
    report.project = {
      root: project.root, packageDirs: project.packageDirs,
      mutationsPlanned: mutations.length, targetedFiles, totalApexFilesInSnapshot: totalApexFiles,
      mutationsSuppressed: plan.suppressed.length,
      note: '--include/--exclude/--operators only narrow which mutations are tested. The snapshot ' +
        `sent to any org during \`run\` always contains all ${totalApexFiles} Apex file(s) found under your ` +
        'package directories, not just the targeted ones — Salesforce needs the whole codebase to compile-check a class.',
    };
    report.estimatedRunCost = mutations.length
      ? `1 baseline + up to ${mutations.length} mutant validation-deploy(s), each subject to --wait/--timeout.`
      : 'No mutations match the current filters; run would refuse to start.';
    if (!mutations.length) problems.push('No mutations match the current --include/--exclude/--operators filters.');
    // A broken suppression marker hides nothing, but it does not do what its author
    // thinks it does — which is exactly the kind of thing doctor exists to surface.
    report.suppressionProblems = plan.problems;
    for (const problem of plan.problems) problems.push(`Suppression marker in ${problem.file}:${problem.line}: ${problem.message}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown project error.';
    report.project = { error: message };
    problems.push(`Project is not valid: ${message}`);
  }

  const sf = await checkSalesforceCli();
  report.salesforceCli = sf;
  if (!sf.available) problems.push(`Salesforce CLI check: ${sf.detail}`);

  if (process.platform === 'win32') problems.push('run is not supported on native Windows (see --help). doctor and plan still work here.');

  if (targetOrg?.trim()) {
    const classification = await classifyOrg(targetOrg);
    report.targetOrg = { alias: targetOrg, ...classification };
    if (classification.classification !== 'sandbox' && classification.classification !== 'scratch') {
      problems.push(`run would refuse '${targetOrg}': ${classification.message}`);
    }
  }

  report.problems = problems;
  report.healthy = problems.length === 0;

  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Node ${report.node} on ${report.platform}/${report.arch} (expects ${report.nodeEngineExpectation})`);
    const p = report.project as Record<string, unknown>;
    if (p.error) console.log(`Project: INVALID — ${p.error as string}`);
    else {
      console.log(`Project: ${p.root} (package dirs: ${(p.packageDirs as string[]).join(', ')})`);
      console.log(`Plan: ${p.mutationsPlanned} mutation(s) across ${p.targetedFiles} targeted file(s); snapshot always includes all ${p.totalApexFilesInSnapshot} Apex file(s).`);
      if (p.mutationsSuppressed) console.log(`Suppressed by in-source markers: ${p.mutationsSuppressed} mutation(s) — excluded from the plan and from any score.`);
      console.log(`Estimated run cost: ${report.estimatedRunCost as string}`);
    }
    console.log(`Salesforce CLI: ${sf.available ? `found (${sf.detail})` : `NOT AVAILABLE — ${sf.detail}`}`);
    if (report.targetOrg) {
      const t = report.targetOrg as { alias: string; classification: string; message: string };
      console.log(`Target org '${t.alias}': ${t.classification} — ${t.message}`);
    }
    console.log(problems.length ? `\n${problems.length} problem(s) found:` : '\nNo problems found.');
    for (const problem of problems) console.log(`  - ${problem}`);
  }
  if (problems.length) process.exitCode = 1;
}

export async function main(argv: string[] = process.argv.slice(2), validate: Validator = validateWithSalesforce, classifyOrg: OrgClassifier = classifyTargetOrg): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
    project: { type: 'string' }, include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    operators: { type: 'string' }, 'max-mutants': { type: 'string' }, output: { type: 'string' },
    'target-org': { type: 'string' }, tests: { type: 'string', multiple: true },
    wait: { type: 'string' }, timeout: { type: 'string' }, threshold: { type: 'string' },
    enforce: { type: 'boolean' }, export: { type: 'string', multiple: true },
    'work-item': { type: 'string', multiple: true },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !['plan', 'doctor', 'run'].includes(command)) throw new Error('Expected plan, doctor, or run. Use --help.');
  const maxMutants = values['max-mutants'] === undefined ? undefined : numberOption(values['max-mutants'], 0, '--max-mutants');
  if (maxMutants !== undefined && !Number.isInteger(maxMutants)) throw new Error('--max-mutants must be an integer.');
  const planFilters = { include: values.include, exclude: values.exclude,
    operators: values.operators?.split(',').map((v) => v.trim()).filter(Boolean), maxMutants };

  if (command === 'doctor') {
    await runDoctor(values.project ?? '.', planFilters, values['target-org'], Boolean(values.json), classifyOrg);
    return;
  }

  const waitMinutes = numberOption(values.wait, 10, '--wait', 1, 1440);
  if (!Number.isInteger(waitMinutes)) throw new Error('--wait must be an integer.');
  const timeoutMs = numberOption(values.timeout, 660, '--timeout', 1, 86400) * 1000;
  // Advisory-first, made explicit: a threshold on its own is a no-op the caller
  // probably did not intend, and enforcement without a chosen threshold is a gate
  // nobody picked. Both are rejected rather than silently resolved.
  if (values.threshold !== undefined && !values.enforce) {
    throw new Error('--threshold only affects the exit code together with --enforce. Reporting is advisory by default: drop --threshold, or add --enforce to gate on the score.');
  }
  if (values.enforce && values.threshold === undefined) throw new Error('--enforce requires an explicit --threshold.');
  const policy: EnforcementPolicy = values.enforce
    ? { mode: 'enforce', threshold: numberOption(values.threshold, 0, '--threshold', 0, 100) }
    : { mode: 'advisory', threshold: 0 };
  const exportFormats = parseExportFormats(values.export ?? []);
  const workItems = (values['work-item'] ?? []).map((value) => value.trim()).filter(Boolean);
  assertWorkItems(workItems);
  if (command === 'run' && process.platform === 'win32') {
    throw new Error("run is not supported on native Windows: Node cannot safely spawn the Salesforce CLI's sf.cmd shim with shell:false. Use WSL, macOS, or Linux instead. `plan` and `doctor` work natively on Windows.");
  }
  const project = await readProject(values.project ?? '.');
  const output = resolve(values.output ?? join(project.root, '.apex-mutant'));
  // Shared with runMutations() so a library caller gets the same guarantee.
  try {
    await assertOutputOutsidePackageDirs(project.root, project.packageDirs, output);
  } catch {
    throw new Error('--output must be outside package directories.');
  }
  const planned = planProjectDetailed(project, planFilters);
  const mutations = planned.mutations;
  const suppressions = { suppressed: planned.suppressed, problems: planned.problems };
  const reportSuppressionProblems = () => {
    for (const problem of planned.problems) {
      console.error(`Apex Mutant: suppression marker in ${problem.file}:${problem.line}: ${problem.message}`);
    }
  };
  if (command === 'plan') {
    const plan = {
      schemaVersion: 2, total: mutations.length, mutations,
      suppressed: planned.suppressed, suppressionProblems: planned.problems,
    };
    await writeFileAtomic(output, 'plan.json', JSON.stringify(plan, null, 2) + '\n');
    if (values.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Apex Mutant · ${mutations.length} mutations planned`);
      for (const m of mutations) console.log(`${m.id}  ${m.file}:${m.line}:${m.column}  ${m.operator}  ${JSON.stringify(m.original)} → ${JSON.stringify(m.replacement)}`);
      if (planned.suppressed.length) {
        console.log(`\n${planned.suppressed.length} mutation(s) suppressed by in-source markers:`);
        for (const m of planned.suppressed) console.log(`  ${m.file}:${m.line}:${m.column}  ${m.operator}  — ${m.reason} (marker on line ${m.markerLine})`);
      }
      console.log(`\nPlan saved to ${join(output, 'plan.json')}`);
      console.log('No Salesforce requests made.');
    }
    reportSuppressionProblems();
    if (!mutations.length) process.exitCode = 2;
    return;
  }
  const tests = (values.tests ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  if (!values['target-org']?.trim() || !tests.length) throw new Error('run requires --target-org and --tests. Use plan for offline generation.');
  // Say why there is nothing to run, rather than blaming the filters for a suppression.
  if (!mutations.length && suppressions.suppressed.length) {
    throw new Error(`Nothing to validate: all ${suppressions.suppressed.length} mutation(s) in scope are suppressed by in-source markers. Run plan to see them and the reasons given.`);
  }
  // The genuine guard: checked before any mutant source is sent, with no override.
  const orgCheck = await classifyOrg(values['target-org']);
  assertSandboxOrScratch(orgCheck, values['target-org']);
  // Only the built-in path is constrained to validation-only by apex-mutant itself;
  // an injected validator is recorded as un-attested rather than assumed safe.
  const builtIn = validate === validateWithSalesforce;
  const abort = new AbortController();
  const cancel = () => { console.error('Stopping; preserving completed results.'); abort.abort(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    reportSuppressionProblems();
    if (suppressions.suppressed.length) console.error(`${suppressions.suppressed.length} mutant(s) suppressed by in-source markers; they are listed in the report and excluded from the score.`);
    console.error(`Validating baseline, then up to ${mutations.length} mutants. Every request uses --dry-run.`);
    const report = await runMutations(project, mutations, {
      targetOrg: values['target-org'], tests, waitMinutes, timeoutMs, output, signal: abort.signal,
      policy, workItems, exports: exportFormats, suppressions,
      safeguards: {
        validator: builtIn
          ? `${TOOL_NAME} ${VERSION} built-in Salesforce validator (sf project deploy start --dry-run --test-level RunSpecifiedTests)`
          : 'Caller-supplied validator: apex-mutant cannot attest what it sends to the org.',
        validationOnly: builtIn,
        orgCheck: { targetOrg: values['target-org'], ...orgCheck },
      },
      onProgress: (done, total, result) => console.error(`[${done}/${total}] ${result.outcome}`),
    }, validate);
    const summary = summarize(report);
    const findings = buildFindings(report);
    if (values.json) console.log(JSON.stringify({ ...report, summary, findings }, null, 2));
    else {
      console.log(`Baseline: ${report.baseline.outcome}${report.baseline.message ? ` — ${report.baseline.message}` : ''}`);
      console.log(`Mutation score: ${summary.score === null ? 'N/A' : summary.score.toFixed(1) + '%'}`);
      console.log(`Killed ${summary.killed} · survived ${summary.survived} · invalid ${summary.invalid} · timeout ${summary.timeout} · error ${summary.error}`);
      console.log(advisoryNotice(report.policy));
      if (findings.length) {
        console.log(`\nTop findings (${findings.length} total, all of them in the report):`);
        for (const finding of findings.slice(0, 3)) {
          console.log(`  [${finding.priority}] ${finding.title}`);
          console.log(`      ${finding.suggestedAction}`);
        }
      }
      console.log(`\nReport: ${join(output, 'report.html')}`);
      for (const format of exportFormats) console.log(`Export (${format}): ${join(output, EXPORT_FILENAMES[format])}`);
    }
    process.exitCode = abort.signal.aborted ? 130 : reportExitCode(report);
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}

// npm's node_modules/.bin entries are symlinks: process.argv[1] is the symlink path while
// import.meta.url is this module's real path, so compare resolved real paths, not raw strings.
async function isDirectlyExecuted(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    const [invoked, self] = await Promise.all([realpath(process.argv[1]), realpath(fileURLToPath(import.meta.url))]);
    return invoked === self;
  } catch { return false; }
}

if (await isDirectlyExecuted()) {
  main().catch((error: unknown) => {
    console.error(`Apex Mutant: ${error instanceof Error ? error.message : 'Unexpected failure.'}`);
    process.exitCode = 2;
  });
}
