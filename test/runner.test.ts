import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyMutation, generateMutations } from '../src/mutations.js';
import { runMutations, type RunOptions } from '../src/runner.js';
import type { ExecutionResult, Project, Validator } from '../src/types.js';

function fakeOutput() {
  return join('/tmp', 'apex-mutant-runner-test-does-not-exist', Math.random().toString(36).slice(2));
}

function project(files: Record<string, string>): Project {
  return {
    root: '/virtual-root',
    packageDirs: ['force-app'],
    files: new Map(Object.entries(files)),
    config: { packageDirectories: [{ path: 'force-app' }] },
  };
}

function baseOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return { targetOrg: 'scratch-org', tests: ['ExampleTest'], waitMinutes: 5, timeoutMs: 5000, output: fakeOutput(), ...overrides };
}

const SOURCE_A = 'public class A { void m() { Boolean b = true; Integer x = 1 * 2; } }';
const SOURCE_B = 'public class B { void m() { Boolean b = false; } }';

test('runMutations validates its inputs before touching the filesystem', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  const validator: Validator = async () => ({ outcome: 'survived', testsRun: 1 });
  await assert.rejects(runMutations(p, mutations, baseOptions({ targetOrg: '' }), validator), /target org/);
  await assert.rejects(runMutations(p, mutations, baseOptions({ tests: [] }), validator), /target org/);
  await assert.rejects(runMutations(p, [], baseOptions(), validator), /No mutations selected/);
  await assert.rejects(runMutations(p, mutations, baseOptions({ waitMinutes: 0 }), validator), /positive/);
  await assert.rejects(runMutations(p, mutations, baseOptions({ timeoutMs: 0 }), validator), /positive/);
});

test('runMutations rejects an --output inside a package directory before creating a snapshot, invoking the validator, or touching any fixture file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-runner-outputcheck-'));
  try {
    await mkdir(join(root, 'force-app'), { recursive: true });
    const classFile = join(root, 'force-app', 'A.cls');
    await writeFile(classFile, SOURCE_A);
    const originalBytes = await readFile(classFile);
    const p: Project = { root, packageDirs: ['force-app'], files: new Map([['force-app/A.cls', SOURCE_A]]), config: {} };
    const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
    let calls = 0;
    const validator: Validator = async () => { calls++; return { outcome: 'survived', testsRun: 1 }; };
    await assert.rejects(
      runMutations(p, mutations, baseOptions({ output: join(root, 'force-app', 'reports') }), validator),
      /outside package directories/,
    );
    assert.equal(calls, 0, 'the validator must never be invoked when --output is unsafe');
    assert.deepEqual(await readFile(classFile), originalBytes, 'the fixture must be untouched by a rejected run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runMutations sanitizes a custom validator's baseline result: unknown/malformed contracts never pass the gate", async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  const badResults: unknown[] = [
    { outcome: 'survived' }, { outcome: 'survived', testsRun: 0 }, { outcome: 'survived', testsRun: NaN },
    { outcome: 'survived', testsRun: -1 }, { outcome: 'survived', testsRun: 1.5 }, { outcome: 'killed', testsRun: 0 },
    { outcome: 'mysterious-new-outcome', testsRun: 5 }, {}, null, undefined,
  ];
  for (const bad of badResults) {
    let calls = 0;
    const validator: Validator = async () => { calls++; return bad as ExecutionResult; };
    const report = await runMutations(p, mutations, baseOptions(), validator);
    assert.equal(calls, 1, `only the baseline should run: ${JSON.stringify(bad)}`);
    assert.equal(report.baseline.outcome, 'error', JSON.stringify(bad));
    assert.equal(report.complete, false);
  }
});

test('a mutant claiming survived without a real positive testsRun count is downgraded to error and stops the run: exact reported scenario', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  assert.ok(mutations.length >= 2);
  let call = 0;
  // Baseline genuinely survives; the mutant's "survived" claim carries zero executed
  // tests, which must never be trusted as evidence that the tests actually ran.
  const results: unknown[] = [{ outcome: 'survived', testsRun: 1 }, { outcome: 'survived', testsRun: 0 }];
  const validator: Validator = async () => results[call++] as ExecutionResult;
  const report = await runMutations(p, mutations, baseOptions(), validator);
  assert.equal(report.results.length, 1, 'the error must stop the loop rather than continue to the next mutant');
  assert.equal(report.results[0].outcome, 'error');
  assert.match(report.results[0].message ?? '', /testsRun/);
  assert.equal(report.complete, false);
});

test('a validator result with a genuinely valid contract passes through untouched', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  const validator: Validator = async () => ({ outcome: 'survived', testsRun: 3, message: 'ok' });
  const report = await runMutations(p, mutations, baseOptions(), validator);
  assert.deepEqual(report.baseline, { outcome: 'survived', testsRun: 3, message: 'ok' });
});

test('a failing baseline stops before any mutant is validated and the snapshot is cleaned up', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  const calls: string[] = [];
  let snapshotDir = '';
  const validator: Validator = async (options) => {
    calls.push(options.projectDir);
    snapshotDir = options.projectDir;
    return { outcome: 'killed', testsRun: 3, message: 'Baseline itself fails tests.' };
  };
  const output = fakeOutput();
  const report = await runMutations(p, mutations, baseOptions({ output }), validator);
  assert.equal(calls.length, 1, 'only the baseline should be validated');
  assert.equal(report.baseline.outcome, 'killed');
  assert.deepEqual(report.results, []);
  assert.equal(report.complete, false);
  await assert.rejects(stat(snapshotDir), 'temporary snapshot must be removed after a baseline failure');
  const onDisk = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(onDisk.baseline.outcome, 'killed');
  assert.deepEqual(onDisk.results, []);
});

test('a baseline that reports zero executed tests is treated as inconclusive, not passing', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  let calls = 0;
  const validator: Validator = async () => { calls++; return { outcome: 'survived', testsRun: 0 }; };
  const report = await runMutations(p, mutations, baseOptions(), validator);
  assert.equal(calls, 1);
  assert.deepEqual(report.results, []);
  assert.equal(report.complete, false);
});

test('mutants are validated one at a time against a clean copy: no leakage between files or mutations', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A, 'force-app/B.cls': SOURCE_B });
  const mutations = [...generateMutations(SOURCE_A, 'force-app/A.cls'), ...generateMutations(SOURCE_B, 'force-app/B.cls')];
  assert.ok(mutations.length >= 2);
  let baselineSeen = false;
  let mutantCalls = 0;
  const validator: Validator = async (options) => {
    if (!baselineSeen) { baselineSeen = true; return { outcome: 'survived', testsRun: 1 }; }
    const currentMutation = mutations[mutantCalls++];
    for (const file of ['force-app/A.cls', 'force-app/B.cls']) {
      const content = await readFile(join(options.projectDir, file), 'utf8');
      if (file === currentMutation.file) {
        const source = file === 'force-app/A.cls' ? SOURCE_A : SOURCE_B;
        assert.equal(content, applyMutation(source, currentMutation), 'active mutation must be applied exactly');
      } else {
        assert.equal(content, file === 'force-app/A.cls' ? SOURCE_A : SOURCE_B, 'untouched file must stay pristine during another file\'s mutation');
      }
    }
    return { outcome: 'survived', testsRun: 1 };
  };
  const report = await runMutations(p, mutations, baseOptions(), validator);
  assert.equal(report.results.length, mutations.length);
  assert.equal(report.complete, true);
  assert.ok(report.results.every((r) => r.outcome === 'survived'));
});

test('an error or timeout outcome stops spending further validation requests', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  assert.ok(mutations.length >= 2);
  let call = 0;
  const results: ExecutionResult[] = [{ outcome: 'survived', testsRun: 1 }, { outcome: 'timeout', testsRun: 0 }, { outcome: 'survived', testsRun: 1 }];
  const validator: Validator = async () => results[call++];
  const report = await runMutations(p, mutations, baseOptions(), validator);
  assert.equal(call, 2, 'baseline + first mutant only; the timeout must stop the run early');
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].outcome, 'timeout');
  assert.equal(report.complete, false);
});

test('an already-aborted signal returns immediately without validating anything', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const validator: Validator = async () => { calls++; return { outcome: 'survived', testsRun: 1 }; };
  const report = await runMutations(p, mutations, baseOptions({ signal: controller.signal }), validator);
  assert.equal(calls, 0);
  assert.equal(report.baseline.message, 'Baseline has not completed.');
  assert.equal(report.complete, false);
});

test('aborting mid-run preserves already-completed results and still cleans up', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  assert.ok(mutations.length >= 2);
  const controller = new AbortController();
  let call = 0;
  let snapshotDir = '';
  const validator: Validator = async (options) => {
    snapshotDir = options.projectDir;
    call++;
    if (call === 2) controller.abort();
    return { outcome: 'survived', testsRun: 1 };
  };
  const report = await runMutations(p, mutations, baseOptions({ signal: controller.signal }), validator);
  assert.equal(report.results.length, 1, 'the mutant validated before the abort still counts');
  assert.equal(report.complete, false);
  await assert.rejects(stat(snapshotDir));
});

test('an unexpectedly rejecting validator is classified as an error, never silently swallowed', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  let call = 0;
  const validator: Validator = async () => {
    call++;
    if (call === 1) return { outcome: 'survived', testsRun: 1 };
    throw new Error('subprocess exploded');
  };
  const report = await runMutations(p, mutations, baseOptions(), validator);
  assert.equal(report.results[0].outcome, 'error');
  assert.equal(report.complete, false);
});

test('a run records advisory mode, traceability, and un-attested validator evidence by default', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls').slice(0, 1);
  const output = await mkdtemp(join(tmpdir(), 'apex-mutant-evidence-'));
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    const report = await runMutations(p, mutations, baseOptions({ output, workItems: ['ABC-1'] }), validator);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.policy.mode, 'advisory', 'advisory is the default operating mode');
    assert.deepEqual(report.traceability.workItems, ['ABC-1']);
    assert.ok(report.traceability.runId.length > 0);
    assert.equal(report.safeguards.snapshotIsolated, true);
    // A caller-supplied validator is arbitrary code: the report must not claim it was validation-only.
    assert.equal(report.safeguards.validationOnly, false);
    assert.match(report.safeguards.validator, /cannot attest/);
    assert.equal(report.safeguards.orgCheck, null);
    const written = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(written.policy.mode, 'advisory');
    assert.ok(Array.isArray(written.findings), 'report.json carries derived findings');
    assert.ok(Array.isArray(written.hotspots));
    assert.ok(Array.isArray(written.enforcementReadiness));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('caller-supplied safeguard evidence is recorded verbatim, and only an explicit true claims validation-only', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls').slice(0, 1);
  const output = await mkdtemp(join(tmpdir(), 'apex-mutant-evidence2-'));
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    const report = await runMutations(p, mutations, baseOptions({
      output,
      safeguards: {
        validator: 'built-in validator', validationOnly: true,
        orgCheck: { targetOrg: 'scratch', classification: 'scratch', message: 'scratch org' },
        notes: ['pilot run'],
      },
    }), validator);
    assert.equal(report.safeguards.validationOnly, true);
    assert.equal(report.safeguards.validator, 'built-in validator');
    assert.equal(report.safeguards.orgCheck?.classification, 'scratch');
    assert.deepEqual(report.safeguards.notes, ['pilot run']);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('source integrity is verified against the real project files and reported as unproven when it cannot be', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-integrity-'));
  const output = await mkdtemp(join(tmpdir(), 'apex-mutant-integrity-out-'));
  try {
    await mkdir(join(root, 'force-app'), { recursive: true });
    await writeFile(join(root, 'force-app', 'A.cls'), SOURCE_A);
    const onDisk: Project = { root, packageDirs: ['force-app'], files: new Map([['force-app/A.cls', SOURCE_A]]), config: {} };
    const mutations = generateMutations(SOURCE_A, 'force-app/A.cls').slice(0, 1);
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    const report = await runMutations(onDisk, mutations, baseOptions({ output }), validator);
    assert.deepEqual(report.safeguards.sourceIntegrity, {
      verified: true, unchanged: true, filesChecked: 1, changedFiles: [],
      message: 'All 1 file(s) are byte-for-byte identical to what apex-mutant read before the run.',
    });

    // An in-memory project has nothing on disk to compare: that is 'unproven', never 'unchanged'.
    const virtual = await runMutations(project({ 'force-app/A.cls': SOURCE_A }), mutations, baseOptions({ output }), validator);
    assert.equal(virtual.safeguards.sourceIntegrity?.verified, false);
    assert.equal(virtual.safeguards.sourceIntegrity?.unchanged, false);
    assert.match(virtual.safeguards.sourceIntegrity!.message, /could not be re-read/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('source integrity reports local files that changed during the run instead of assuming isolation held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-integrity-changed-'));
  const output = await mkdtemp(join(tmpdir(), 'apex-mutant-integrity-changed-out-'));
  try {
    await mkdir(join(root, 'force-app'), { recursive: true });
    await writeFile(join(root, 'force-app', 'A.cls'), SOURCE_A);
    const onDisk: Project = { root, packageDirs: ['force-app'], files: new Map([['force-app/A.cls', SOURCE_A]]), config: {} };
    const mutations = generateMutations(SOURCE_A, 'force-app/A.cls').slice(0, 1);
    // Something outside apex-mutant edits the developer's source mid-run.
    const validator: Validator = async () => {
      await writeFile(join(root, 'force-app', 'A.cls'), SOURCE_B);
      return { outcome: 'survived', testsRun: 2 };
    };
    const report = await runMutations(onDisk, mutations, baseOptions({ output }), validator);
    assert.equal(report.safeguards.sourceIntegrity?.verified, true);
    assert.equal(report.safeguards.sourceIntegrity?.unchanged, false);
    assert.deepEqual(report.safeguards.sourceIntegrity?.changedFiles, ['force-app/A.cls']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test('runMutations rejects an invalid policy or work item before doing any work', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls');
  let calls = 0;
  const validator: Validator = async () => { calls++; return { outcome: 'survived', testsRun: 1 }; };
  await assert.rejects(runMutations(p, mutations, baseOptions({ policy: { mode: 'enforce', threshold: 101 } }), validator), /threshold between 0 and 100/);
  await assert.rejects(runMutations(p, mutations, baseOptions({ policy: { mode: 'gate' as unknown as 'enforce', threshold: 10 } }), validator), /advisory' or 'enforce/);
  await assert.rejects(runMutations(p, mutations, baseOptions({ workItems: ['=danger'] }), validator), /Invalid work item/);
  assert.equal(calls, 0, 'nothing is validated before the options are accepted');
});

test('requested exports are written once the run finishes, alongside the incremental report', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls').slice(0, 1);
  const output = await mkdtemp(join(tmpdir(), 'apex-mutant-exports-run-'));
  try {
    const validator: Validator = async () => ({ outcome: 'survived', testsRun: 2 });
    await runMutations(p, mutations, baseOptions({ output, exports: ['csv', 'sarif', 'md'], workItems: ['ABC-9'] }), validator);
    const csv = await readFile(join(output, 'findings.csv'), 'utf8');
    const sarif = JSON.parse(await readFile(join(output, 'report.sarif'), 'utf8'));
    const markdown = await readFile(join(output, 'summary.md'), 'utf8');
    assert.ok(csv.includes('ABC-9'));
    assert.equal(sarif.version, '2.1.0');
    assert.ok(markdown.includes('ABC-9'));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('exports are still written when the baseline never passes, so a failed run is reportable too', async () => {
  const p = project({ 'force-app/A.cls': SOURCE_A });
  const mutations = generateMutations(SOURCE_A, 'force-app/A.cls').slice(0, 1);
  const output = await mkdtemp(join(tmpdir(), 'apex-mutant-exports-baseline-'));
  try {
    const validator: Validator = async () => ({ outcome: 'error', message: 'no CLI' });
    const report = await runMutations(p, mutations, baseOptions({ output, exports: ['md'] }), validator);
    assert.equal(report.results.length, 0);
    const markdown = await readFile(join(output, 'summary.md'), 'utf8');
    assert.ok(markdown.includes('Baseline validation did not pass'));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
