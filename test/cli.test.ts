import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.js';
import type { ExecutionResult, OrgClassificationResult, OrgClassifier, Validator } from '../src/types.js';

const scratchClassifier: OrgClassifier = async () => ({ classification: 'scratch', message: 'test fixture' });

async function fixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-cli-'));
  await writeFile(join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  const classes = join(root, 'force-app', 'main', 'default', 'classes');
  await mkdir(classes, { recursive: true });
  await writeFile(join(classes, 'Foo.cls'), 'public class Foo { void m() { Boolean b = true; Integer x = 1 * 2; } }');
  await writeFile(join(classes, 'Foo.cls-meta.xml'), '<ApexClass/>');
  return root;
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[]; exitCode: number | string | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const result = await fn();
    return { result, logs, errors, exitCode: process.exitCode };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

test('no arguments or --help prints usage without throwing', async () => {
  const noArgs = await capture(() => main([]));
  assert.ok(noArgs.logs.some((l) => l.includes('Usage:')));
  assert.equal(noArgs.exitCode, undefined);

  const help = await capture(() => main(['--help']));
  assert.ok(help.logs.some((l) => l.includes('Usage:')));
});

test('an unknown or extra positional command is rejected', async () => {
  await assert.rejects(main(['bogus']), /Expected plan, doctor, or run/);
  await assert.rejects(main(['plan', 'run']), /Expected plan, doctor, or run/);
});

test('plan runs fully offline, writes plan.json, and lists every mutation', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  try {
    const { logs, exitCode } = await capture(() => main(['plan', '--project', root, '--output', output]));
    assert.equal(exitCode, undefined);
    assert.ok(logs.some((l) => l.includes('2 mutations planned')));
    const plan = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'));
    assert.equal(plan.total, 2);
    assert.equal(plan.mutations.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan --json prints the exact plan as JSON on stdout', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  try {
    const { logs } = await capture(() => main(['plan', '--project', root, '--output', output, '--json']));
    const printed = JSON.parse(logs.join('\n'));
    const onDisk = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'));
    assert.deepEqual(printed, onDisk);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan with a filter that matches nothing exits non-zero without error', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  try {
    const { exitCode } = await capture(() => main(['plan', '--project', root, '--output', output, '--exclude', 'force-app']));
    assert.equal(exitCode, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--output inside a package directory is rejected before any mutation runs', async () => {
  const root = await fixtureProject();
  try {
    await assert.rejects(main(['plan', '--project', root, '--output', join(root, 'force-app', 'reports')]), /--output must be outside package directories/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--output that is a symlink resolving into a package directory is rejected, not just a lexical mismatch', { skip: process.platform === 'win32' }, async () => {
  const root = await fixtureProject();
  try {
    const insidePackage = join(root, 'force-app', 'reports');
    await mkdir(insidePackage, { recursive: true });
    const outputLink = join(root, 'output-link');
    await symlink(insidePackage, outputLink);
    // The literal string "output-link" does not start with "force-app", so a purely
    // lexical relative() check on the un-resolved paths would wrongly accept this.
    await assert.rejects(main(['plan', '--project', root, '--output', outputLink]), /--output must be outside package directories/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a pre-existing symlink at the plan.json output path never gets written through: the source it points at is untouched', { skip: process.platform === 'win32' }, async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  const source = join(root, 'force-app', 'main', 'default', 'classes', 'Foo.cls');
  const originalSource = await readFile(source, 'utf8');
  try {
    await mkdir(output, { recursive: true });
    const planPath = join(output, 'plan.json');
    await symlink(source, planPath);
    await capture(() => main(['plan', '--project', root, '--output', output]));
    assert.equal(await readFile(source, 'utf8'), originalSource, 'the real Apex source must never be overwritten');
    assert.equal((await lstat(planPath)).isSymbolicLink(), false, 'the symlink must be replaced by a real file, not written through');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    assert.equal(plan.total, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('numeric options are validated before any filesystem or network work', async () => {
  const root = await fixtureProject();
  try {
    await assert.rejects(main(['plan', '--project', root, '--wait', '0']), /--wait must be between/);
    await assert.rejects(main(['plan', '--project', root, '--timeout', 'not-a-number']), /--timeout must be between/);
    await assert.rejects(main(['run', '--project', root, '--target-org', 'x', '--tests', 'T', '--enforce', '--threshold', '150']), /--threshold must be between/);
    await assert.rejects(main(['plan', '--project', root, '--max-mutants', '1.5']), /--max-mutants must be an integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run requires an explicit target org and test names', async () => {
  const root = await fixtureProject();
  try {
    await assert.rejects(main(['run', '--project', root, '--tests', 'T']), /run requires --target-org and --tests/);
    await assert.rejects(main(['run', '--project', root, '--target-org', 'x']), /run requires --target-org and --tests/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run with an injected validator never touches a real Salesforce CLI and reports score/exit code correctly', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  try {
    let call = 0;
    const results: ExecutionResult[] = [{ outcome: 'survived', testsRun: 2 }, { outcome: 'killed', testsRun: 2 }, { outcome: 'survived', testsRun: 2 }];
    const validator: Validator = async () => results[call++];
    const { logs, exitCode } = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', output], validator, scratchClassifier));
    assert.equal(call, 3, 'baseline plus both mutants');
    assert.ok(logs.some((l) => l.includes('Baseline: survived')));
    assert.ok(logs.some((l) => l.includes('Mutation score: 50.0%')));
    assert.equal(exitCode, 0, 'default threshold of 0 is met by any score');
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.complete, true);
    assert.equal(report.results.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the score only gates the exit code under --enforce, and both flags must be explicit', async () => {
  const root = await fixtureProject();
  try {
    const survivedOnly: Validator = async () => ({ outcome: 'survived', testsRun: 1 });
    let call = 0;
    const allKilled: Validator = async () => (call++ === 0 ? { outcome: 'survived', testsRun: 1 } : { outcome: 'killed', testsRun: 1 });

    // Advisory is the default: a 0% score is reported, not enforced.
    const advisory = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out0')], survivedOnly, scratchClassifier));
    assert.equal(advisory.exitCode, 0, 'a 0% score must not fail an advisory run');
    assert.ok(advisory.logs.some((l) => l.includes('Advisory run')), 'the advisory notice is printed');

    const below = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out1'), '--enforce', '--threshold', '10'], survivedOnly, scratchClassifier));
    assert.equal(below.exitCode, 1);
    assert.ok(below.logs.some((l) => l.includes('Enforcing run')));

    call = 0;
    const above = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out2'), '--enforce', '--threshold', '10'], allKilled, scratchClassifier));
    assert.equal(above.exitCode, 0);

    // Neither half of the gate may be implied: a threshold alone would silently do
    // nothing, and --enforce alone would invent a threshold nobody chose.
    await assert.rejects(main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--threshold', '10'], survivedOnly, scratchClassifier), /--threshold only affects the exit code together with --enforce/);
    await assert.rejects(main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--enforce'], survivedOnly, scratchClassifier), /--enforce requires an explicit --threshold/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run fails closed with exit code 2 when the Salesforce CLI is not installed', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  const originalPath = process.env.PATH;
  // Point PATH at a directory that cannot contain "sf" so the real validator's spawn('sf', ...) fails closed.
  const emptyPathDir = await mkdtemp(join(tmpdir(), 'apex-mutant-empty-path-'));
  process.env.PATH = emptyPathDir;
  try {
    const { exitCode } = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', output], undefined, scratchClassifier));
    assert.equal(exitCode, 2);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.baseline.outcome, 'error');
    assert.equal(report.results.length, 0);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(emptyPathDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('run refuses a production or unknown-classified target org before the validator is ever invoked, with no override', async () => {
  const root = await fixtureProject();
  try {
    const badClassifications: OrgClassificationResult[] = [
      { classification: 'production', message: 'is prod' },
      { classification: 'unknown', message: 'no evidence' },
    ];
    for (const bad of badClassifications) {
      let calls = 0;
      const validator: Validator = async () => { calls++; return { outcome: 'survived', testsRun: 1 }; };
      const classifier: OrgClassifier = async () => bad;
      await assert.rejects(
        main(['run', '--project', root, '--target-org', 'x', '--tests', 'FooTest', '--output', join(root, 'out')], validator, classifier),
        /Refusing to run/,
      );
      assert.equal(calls, 0, `validator must not run for classification '${bad.classification}'`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

test('run gives an early, clear error on native Windows; plan and doctor still work there', async () => {
  const root = await fixtureProject();
  try {
    await withPlatform('win32', async () => {
      await assert.rejects(
        main(['run', '--project', root, '--target-org', 'x', '--tests', 'T'], async () => ({ outcome: 'survived', testsRun: 1 }), scratchClassifier),
        /not supported on native Windows/,
      );
      const plan = await capture(() => main(['plan', '--project', root, '--output', join(root, 'out')]));
      assert.equal(plan.exitCode, undefined, 'plan is pure parsing and must still work on native Windows');
      const doctor = await capture(() => main(['doctor', '--project', root, '--json']));
      const report = JSON.parse(doctor.logs.join('\n'));
      assert.equal(report.salesforceCli.available, false);
      assert.match(report.salesforceCli.detail, /native Windows/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor reports valid project diagnostics offline, with the include/exclude-vs-snapshot clarification', async () => {
  // Deliberately does not assert report.healthy/exitCode: on a machine without a real
  // `sf` CLI installed, doctor correctly (and separately) flags that as a problem —
  // this test is only about the project/plan diagnostics, which are fully offline.
  const root = await fixtureProject();
  try {
    const { logs } = await capture(() => main(['doctor', '--project', root, '--json']));
    const report = JSON.parse(logs.join('\n'));
    assert.equal(report.project.error, undefined);
    assert.equal(report.project.mutationsPlanned, 2);
    assert.equal(report.project.totalApexFilesInSnapshot, 1);
    assert.match(report.project.note, /always contains all/);
    assert.equal(typeof report.salesforceCli.available, 'boolean');
    assert.equal(typeof report.salesforceCli.detail, 'string');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor reports an invalid project as a diagnosis, not a thrown error, and exits 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-cli-'));
  try {
    // No sfdx-project.json: readProject() will reject.
    const { logs, exitCode } = await capture(() => main(['doctor', '--project', root, '--json']));
    const report = JSON.parse(logs.join('\n'));
    assert.equal(report.healthy, false);
    assert.ok(report.project.error);
    assert.equal(exitCode, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor reports a filtered plan\'s narrower scope distinctly from the full snapshot', async () => {
  const root = await fixtureProject();
  const classes = join(root, 'force-app', 'main', 'default', 'classes');
  await writeFile(join(classes, 'Bar.cls'), 'public class Bar { void m() { Boolean b = false; } }');
  await writeFile(join(classes, 'Bar.cls-meta.xml'), '<ApexClass/>');
  try {
    const { logs } = await capture(() => main(['doctor', '--project', root, '--include', 'force-app/main/default/classes/Foo.cls', '--json']));
    const report = JSON.parse(logs.join('\n'));
    assert.equal(report.project.targetedFiles, 1);
    assert.equal(report.project.totalApexFilesInSnapshot, 2, 'the snapshot always includes every Apex file, not just the targeted one');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor with --target-org reports the classification and flags a non-sandbox/scratch org as a problem, without throwing', async () => {
  const root = await fixtureProject();
  try {
    const prod: OrgClassifier = async () => ({ classification: 'production', message: 'is prod' });
    const { logs, exitCode } = await capture(() => main(['doctor', '--project', root, '--target-org', 'x', '--json'], undefined, prod));
    const report = JSON.parse(logs.join('\n'));
    assert.equal(report.targetOrg.classification, 'production');
    assert.equal(report.healthy, false);
    assert.equal(exitCode, 1);
    assert.ok(report.problems.some((p: string) => p.includes('run would refuse')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run prints the advisory notice and the highest-priority findings with their suggested actions', async () => {
  const root = await fixtureProject();
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    const { logs } = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out')], validator, scratchClassifier));
    const text = logs.join('\n');
    assert.ok(text.includes('Advisory run'), 'the operating mode is stated in the output, not just in the docs');
    assert.ok(text.includes('does not affect the exit code'));
    assert.ok(/Top findings \(\d+ total/.test(text));
    assert.ok(text.includes('[high] Unkilled boolean-literal mutant'));
    assert.ok(text.includes('Assert the behavior this flag controls'), 'a suggested action, not just a count');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run records the org classification it enforced, and refuses to call an injected validator validation-only', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', output], validator, scratchClassifier));
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.deepEqual(report.safeguards.orgCheck, { targetOrg: 'scratch', classification: 'scratch', message: 'test fixture' });
    assert.equal(report.safeguards.validationOnly, false, 'only the built-in validator path may claim validation-only');
    assert.equal(report.safeguards.snapshotIsolated, true);
    assert.equal(report.safeguards.sourceIntegrity.verified, true);
    assert.equal(report.safeguards.sourceIntegrity.unchanged, true);
    const html = await readFile(join(output, 'report.html'), 'utf8');
    assert.ok(html.includes('Execution safeguards'));
    assert.ok(html.includes('Before enforcing a score in CI'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--export and --work-item produce portable artifacts carrying the work item, and bad values are rejected', async () => {
  const root = await fixtureProject();
  const output = join(root, 'out');
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    const { logs } = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest',
      '--output', output, '--export', 'all', '--work-item', 'ABC-123', '--work-item', 'release/2026.1'], validator, scratchClassifier));
    const csv = await readFile(join(output, 'findings.csv'), 'utf8');
    const sarif = JSON.parse(await readFile(join(output, 'report.sarif'), 'utf8'));
    const markdown = await readFile(join(output, 'summary.md'), 'utf8');
    assert.ok(csv.includes('"ABC-123 release/2026.1"'));
    assert.deepEqual(sarif.runs[0].properties.workItems, ['ABC-123', 'release/2026.1']);
    assert.ok(markdown.includes('ABC-123, release/2026.1'));
    assert.ok(logs.some((l) => l.includes('Export (csv)')));

    await assert.rejects(main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', output, '--export', 'pdf'], validator, scratchClassifier), /Unknown export format 'pdf'/);
    await assert.rejects(main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', output, '--work-item', '=cmd'], validator, scratchClassifier), /Invalid work item/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run --json prints the findings alongside the report so a pipeline never has to re-derive them', async () => {
  const root = await fixtureProject();
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    const { logs } = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out'), '--json'], validator, scratchClassifier));
    const printed = JSON.parse(logs.join('\n'));
    assert.equal(printed.policy.mode, 'advisory');
    assert.equal(printed.schemaVersion, 2);
    assert.ok(printed.findings.length >= 1);
    assert.ok(printed.findings.every((f: { suggestedAction: string }) => f.suggestedAction.length > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function suppressedFixtureProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-cli-suppressed-'));
  await writeFile(join(root, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
  const classes = join(root, 'force-app', 'main', 'default', 'classes');
  await mkdir(classes, { recursive: true });
  await writeFile(join(classes, 'Foo.cls'), [
    'public class Foo {',
    '  // apex-mutant-disable-next-line boolean-literal: this flag is a compile-time constant',
    '  void m() { Boolean b = true; Integer x = 1 * 2; }',
    '  // apex-mutant-disable-next-line all: nothing here any more',
    '}',
    '',
  ].join('\n'));
  await writeFile(join(classes, 'Foo.cls-meta.xml'), '<ApexClass/>');
  return root;
}

test('plan lists suppressed mutants with their reasons, excludes them from the plan, and flags a stale marker', async () => {
  const root = await suppressedFixtureProject();
  const output = join(root, 'out');
  try {
    const { logs, errors } = await capture(() => main(['plan', '--project', root, '--output', output]));
    assert.ok(logs.some((l) => l.includes('1 mutations planned')), 'the suppressed mutant is not planned');
    assert.ok(logs.some((l) => l.includes('1 mutation(s) suppressed by in-source markers')));
    assert.ok(logs.some((l) => l.includes('this flag is a compile-time constant')), 'the reason is shown, not just a count');
    assert.ok(errors.some((l) => l.includes('matches no mutation')), 'the stale marker is reported, not silently accepted');

    const plan = JSON.parse(await readFile(join(output, 'plan.json'), 'utf8'));
    assert.equal(plan.total, 1);
    assert.equal(plan.suppressed.length, 1);
    assert.equal(plan.suppressed[0].operator, 'boolean-literal');
    assert.equal(plan.suppressed[0].reason, 'this flag is a compile-time constant');
    assert.equal(plan.suppressionProblems.length, 1);
    assert.equal(plan.mutations.some((m: { operator: string }) => m.operator === 'boolean-literal'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a suppressed mutant is never validated, never scored, and always visible in the report', async () => {
  const root = await suppressedFixtureProject();
  const output = join(root, 'out');
  try {
    let calls = 0;
    const validator: Validator = async () => ({ outcome: calls++ === 0 ? 'survived' : 'killed', testsRun: 2 });
    const { logs } = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', output, '--export', 'md'], validator, scratchClassifier));
    assert.equal(calls, 2, 'baseline plus the one unsuppressed mutant — the suppressed one costs no org request');
    assert.ok(logs.some((l) => l.includes('Mutation score: 100.0%')));

    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.totalPlanned, 1);
    assert.equal(report.summary.suppressed, 1, 'the excluded mutant is counted where the score is reported');
    assert.equal(report.suppressions.suppressed[0].reason, 'this flag is a compile-time constant');
    assert.equal(report.suppressions.problems.length, 1);
    const suppressedFinding = report.findings.find((f: { category: string }) => f.category === 'suppressed');
    assert.ok(suppressedFinding, 'a suppressed mutant is a finding, not an absence');
    assert.match(suppressedFinding.detail, /excluded from the score's denominator/);
    assert.ok(report.findings.some((f: { title: string }) => f.title.includes('Suppression marker problem')));

    const markdown = await readFile(join(output, 'summary.md'), 'utf8');
    assert.ok(markdown.includes('- Suppressed: 1 mutant(s) excluded by in-source markers'));
    const html = await readFile(join(output, 'report.html'), 'utf8');
    assert.ok(html.includes('were suppressed by in-source markers and never validated'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
