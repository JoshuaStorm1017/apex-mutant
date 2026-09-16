import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
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
