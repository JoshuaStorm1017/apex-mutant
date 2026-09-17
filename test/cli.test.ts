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
    await assert.rejects(main(['run', '--project', root, '--target-org', 'x', '--tests', 'T', '--threshold', '150']), /--threshold must be between/);
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

test('run below the requested threshold exits 1 and above it exits 0', async () => {
  const root = await fixtureProject();
  try {
    const survivedOnly: Validator = async () => ({ outcome: 'survived', testsRun: 1 });
    const below = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out1'), '--threshold', '10'], survivedOnly, scratchClassifier));
    assert.equal(below.exitCode, 1);

    let call = 0;
    const allKilled: Validator = async () => (call++ === 0 ? { outcome: 'survived', testsRun: 1 } : { outcome: 'killed', testsRun: 1 });
    const above = await capture(() => main(['run', '--project', root, '--target-org', 'scratch', '--tests', 'FooTest', '--output', join(root, 'out2'), '--threshold', '10'], allKilled, scratchClassifier));
    assert.equal(above.exitCode, 0);
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
