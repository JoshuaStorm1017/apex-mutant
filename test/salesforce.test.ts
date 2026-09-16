import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { parseSalesforceResult, validateWithSalesforce } from '../src/salesforce.js';
import type { ValidationOptions } from '../src/types.js';

function response(overrides: Record<string, unknown> = {}, details: Record<string, unknown> = {}) {
  return { status: 0, result: {
    status: 'Succeeded', done: true, checkOnly: true, success: true,
    numberComponentErrors: 0, numberTestsCompleted: 2, numberTestErrors: 0,
    details: { componentFailures: [], runTestResult: { numTestsRun: 2, numFailures: 0, failures: [] }, ...details },
    ...overrides,
  } };
}
const parse = (value: unknown, exit = 0) => parseSalesforceResult(JSON.stringify(value), exit);
const testFailure = { name: 'SyntheticTest', methodName: 'checksValue', message: 'Synthetic assertion failed: private@example.invalid' };
const failed = (overrides: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => response({
  status: 'Failed', success: false, numberTestsCompleted: 1, numberTestErrors: 1, ...overrides,
}, { runTestResult: { numTestsRun: 2, numFailures: 1, failures: [testFailure] }, ...details });

test('completed passing validation survives, including harmless warnings', () => {
  assert.equal(parse(response()).outcome, 'survived');
  assert.equal(parse(response({}, { componentFailures: [{ problemType: 'Warning', problem: 'Synthetic warning' }] })).outcome, 'survived');
  assert.equal(parse(response({ numberTestsCompleted: '2', numberTestErrors: '0', numberComponentErrors: '0' })).outcome, 'survived');
});

test('only completed real test failures kill, including an all-failing test run', () => {
  assert.equal(parse(failed(), 1).outcome, 'killed');
  assert.equal(parse(failed({ numberTestsCompleted: 0 }, { runTestResult: { numTestsRun: 1, numFailures: 1, failures: testFailure } }), 1).outcome, 'killed');
  assert.equal(parse(failed({}, { componentFailures: [{ problemType: 'Warning' }] }), 1).outcome, 'killed');
  assert.equal(JSON.stringify(parse(failed(), 1)).includes('private@example.invalid'), false);
});

test('compilation wins over test failures and coverage alone never kills', () => {
  assert.equal(parse(failed({ numberComponentErrors: 1 }, { componentFailures: [{ problemType: 'Error', problem: 'Invalid type', componentType: 'ApexClass' }] }), 1).outcome, 'invalid');
  assert.equal(parse(response({ success: false, status: 'Failed' }, { runTestResult: { numTestsRun: 2, numFailures: 0, codeCoverageWarnings: [{ message: 'Low coverage' }] } }), 1).outcome, 'error');
  assert.equal(parse(response({ success: false, status: 'Failed', numberComponentErrors: 1 }, { componentFailures: [{ problemType: 'Error', problem: 'Code coverage is 50%' }] }), 1).outcome, 'error');
});

test('pending, canceled, malformed, missing, zero tests and CLI failures fail closed', () => {
  for (const status of ['Pending', 'Queued', 'InProgress', 'Canceling', 'FinalizingDeploy']) {
    assert.equal(parse(failed({ status, done: false }), 1).outcome, 'timeout');
  }
  for (const data of [
    {}, null, { status: 1, name: 'AuthError', message: 'secret' },
    response({ done: undefined }), response({ checkOnly: false }), response({ status: 'Canceled' }),
    response({ numberTestsCompleted: 0 }, { runTestResult: { numTestsRun: 0, numFailures: 0 } }),
    response({ numberComponentErrors: undefined }), response({}, { runTestResult: undefined }),
    response({ numberTestsCompleted: 99 }), failed({ errorStatusCode: 'SERVER_UNAVAILABLE' }),
    response({}, { componentFailures: ['invalid shape'] }),
    failed({}, { runTestResult: { numTestsRun: 2, numFailures: 1, failures: [{ message: 'No actual method' }] } }),
    failed({}, { runTestResult: { numTestsRun: 2, numFailures: 0, failures: [testFailure] } }),
  ]) assert.equal(parse(data, 1).outcome, 'error', JSON.stringify(data));
  assert.equal(parseSalesforceResult('not JSON secret', 1).outcome, 'error');
  assert.equal(parse(response(), 1).outcome, 'error');
});

test('real fake sf subprocess preserves explicit dry-run arguments, isolates cwd, and bounds failures', { skip: process.platform === 'win32' }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'apex-mutant-sf-'));
  const executable = join(fixture, 'sf');
  const capture = join(fixture, 'capture.json');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixture}:${dirname(process.execPath)}`;
  const options: ValidationOptions = {
    projectDir: fixture, sourceDirs: [join(fixture, 'first source'), join(fixture, 'second')],
    targetOrg: 'synthetic-org; echo unsafe', tests: ['ExampleTest', 'OtherTest.method'], waitMinutes: 3, timeoutMs: 5000,
  };
  const script = async (body: string) => {
    await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
    await chmod(executable, 0o700);
  };
  try {
    await script(`require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.stderr.write('private@example.invalid'); process.stdout.write(${JSON.stringify(JSON.stringify(response()))});`);
    const result = await validateWithSalesforce(options);
    assert.equal(result.outcome, 'survived');
    assert.equal(JSON.stringify(result).includes('private@example.invalid'), false);
    const recorded = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(recorded.args, ['project', 'deploy', 'start', '--dry-run', '--test-level', 'RunSpecifiedTests', '--tests', 'ExampleTest', '--tests', 'OtherTest.method', '--target-org', options.targetOrg, '--source-dir', options.sourceDirs[0], '--source-dir', options.sourceDirs[1], '--wait', '3', '--json']);
    assert.equal(recorded.cwd, await (await import('node:fs/promises')).realpath(fixture));
    await script(`process.stdout.write(${JSON.stringify(JSON.stringify(failed()))}); process.exitCode = 1;`);
    assert.equal((await validateWithSalesforce(options)).outcome, 'killed');
    await script(`process.stdout.write(${JSON.stringify(JSON.stringify(failed({ done: false, status: 'InProgress' })))}); process.exitCode = 1;`);
    assert.equal((await validateWithSalesforce(options)).outcome, 'timeout');
    await script(`process.stdout.write('private@example.invalid malformed output'); process.exitCode = 1;`);
    const malformed = await validateWithSalesforce(options);
    assert.equal(malformed.outcome, 'error');
    assert.equal(JSON.stringify(malformed).includes('private@example.invalid'), false);
    await script('setInterval(() => {}, 1000);');
    assert.equal((await validateWithSalesforce({ ...options, timeoutMs: 100 })).outcome, 'timeout');
    const controller = new AbortController();
    const pending = validateWithSalesforce({ ...options, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    assert.equal((await pending).outcome, 'error');
    assert.equal((await validateWithSalesforce({ ...options, signal: controller.signal })).outcome, 'error');
    await script(`process.stdout.write('x'.repeat(5 * 1024 * 1024));`);
    assert.equal((await validateWithSalesforce(options)).outcome, 'error');
    await script(`process.stderr.write('x'.repeat(5 * 1024 * 1024));`);
    assert.equal((await validateWithSalesforce(options)).outcome, 'error');
    await rm(executable);
    assert.equal((await validateWithSalesforce(options)).outcome, 'error');
    for (const invalid of [{ tests: [] }, { targetOrg: '' }, { sourceDirs: [] }, { timeoutMs: 0 }, { waitMinutes: 0 }, { tests: ['--dry-run=false'] }]) {
      assert.equal((await validateWithSalesforce({ ...options, ...invalid })).outcome, 'error');
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(fixture, { recursive: true, force: true });
  }
});
