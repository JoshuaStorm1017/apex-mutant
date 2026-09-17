import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { classifyFromAuthList, classifyTargetOrg, assertSandboxOrScratch } from '../src/orgSafety.js';

function authList(entries: unknown[]) {
  return JSON.stringify({ status: 0, result: entries });
}

test('classifyFromAuthList: production is only classified when both org-type flags are explicitly false', () => {
  const result = classifyFromAuthList(authList([{ alias: 'prod', username: 'a@example.com', isSandbox: false, isScratchOrg: false }]), 'prod');
  assert.equal(result.classification, 'production');
});

test('classifyFromAuthList: sandbox and scratch are both accepted classifications', () => {
  assert.equal(classifyFromAuthList(authList([{ alias: 'sb', isSandbox: true, isScratchOrg: false }]), 'sb').classification, 'sandbox');
  assert.equal(classifyFromAuthList(authList([{ alias: 'so', isSandbox: false, isScratchOrg: true }]), 'so').classification, 'scratch');
  // A scratch org's isSandbox flag is not authoritative on its own; isScratchOrg wins.
  assert.equal(classifyFromAuthList(authList([{ alias: 'both', isSandbox: true, isScratchOrg: true }]), 'both').classification, 'scratch');
});

test('classifyFromAuthList: matches by alias or by username', () => {
  const list = authList([{ username: 'user@example.com', isSandbox: true, isScratchOrg: false }]);
  assert.equal(classifyFromAuthList(list, 'user@example.com').classification, 'sandbox');
});

test('classifyFromAuthList fails closed to unknown: no match, malformed JSON, non-array result, missing flags, and an auth error', () => {
  assert.equal(classifyFromAuthList(authList([{ alias: 'other', isSandbox: true, isScratchOrg: false }]), 'missing').classification, 'unknown');
  assert.equal(classifyFromAuthList('not json', 'x').classification, 'unknown');
  assert.equal(classifyFromAuthList(JSON.stringify({ status: 0, result: 'not-an-array' }), 'x').classification, 'unknown');
  assert.equal(classifyFromAuthList(authList([{ alias: 'x', isSandbox: 'yes', isScratchOrg: false }]), 'x').classification, 'unknown');
  assert.equal(classifyFromAuthList(authList([{ alias: 'x' }]), 'x').classification, 'unknown');
  assert.equal(classifyFromAuthList(authList([{ alias: 'x', error: 'invalid_grant', isSandbox: true, isScratchOrg: false }]), 'x').classification, 'unknown');
});

test('assertSandboxOrScratch allows sandbox/scratch and rejects production/unknown with no override', () => {
  assert.doesNotThrow(() => assertSandboxOrScratch({ classification: 'sandbox', message: 'ok' }, 'x'));
  assert.doesNotThrow(() => assertSandboxOrScratch({ classification: 'scratch', message: 'ok' }, 'x'));
  assert.throws(() => assertSandboxOrScratch({ classification: 'production', message: 'is prod' }, 'x'), /Refusing to run/);
  assert.throws(() => assertSandboxOrScratch({ classification: 'unknown', message: 'no evidence' }, 'x'), /Refusing to run/);
});

test('classifyTargetOrg calls `sf org list auth --json`, fails closed on missing/malformed/slow/absent CLI, and never needs a real org', { skip: process.platform === 'win32' }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'apex-mutant-orgsafety-'));
  const executable = join(fixture, 'sf');
  const capture = join(fixture, 'capture.json');
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixture}:${dirname(process.execPath)}`;
  const script = async (body: string) => {
    await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
    await chmod(executable, 0o700);
  };
  try {
    await script(`require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));
      process.stdout.write(${JSON.stringify(authList([{ alias: 'scratch-org', isSandbox: false, isScratchOrg: true }]))});`);
    const result = await classifyTargetOrg('scratch-org');
    assert.equal(result.classification, 'scratch');
    const args = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(args, ['org', 'list', 'auth', '--json']);

    await script(`process.stdout.write('not json'); process.exitCode = 0;`);
    assert.equal((await classifyTargetOrg('scratch-org')).classification, 'unknown');

    await rm(executable);
    assert.equal((await classifyTargetOrg('scratch-org')).classification, 'unknown');
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(fixture, { recursive: true, force: true });
  }
});

test('classifyTargetOrg rejects an empty/missing target org without spawning anything', async () => {
  assert.equal((await classifyTargetOrg('')).classification, 'unknown');
  assert.equal((await classifyTargetOrg('   ')).classification, 'unknown');
});
