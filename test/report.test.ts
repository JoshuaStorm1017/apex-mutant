import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, lstat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderHtml, reportExitCode, resolveRealPath, summarize, writeReport, writeFileAtomic, assertOutputOutsidePackageDirs } from '../src/report.js';
import type { MutationResult, Report } from '../src/types.js';

function mutation(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    id: 'abc', file: 'force-app/A.cls', operator: 'boolean-literal',
    start: 0, end: 4, line: 1, column: 1, original: 'true', replacement: 'false',
    outcome: 'killed', ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: 2, createdAt: '2026-01-01T00:00:00.000Z',
    tool: { name: 'apex-mutant', version: 'test' },
    policy: { mode: 'advisory', threshold: 0 },
    traceability: { runId: 'run-1', workItems: [] },
    safeguards: {
      validator: 'test validator', validationOnly: false, snapshotIsolated: true,
      orgCheck: null, sourceIntegrity: null, notes: [],
    },
    baseline: { outcome: 'survived', testsRun: 3 },
    results: [], totalPlanned: 0, complete: false, ...overrides,
  };
}
const enforcing = (threshold: number): Report['policy'] => ({ mode: 'enforce', threshold });

test('summarize counts each outcome and reports score as null with no scored mutants', () => {
  const r = report({ results: [mutation({ outcome: 'killed' }), mutation({ outcome: 'survived' }), mutation({ outcome: 'invalid' }), mutation({ outcome: 'timeout' }), mutation({ outcome: 'error' })] });
  const s = summarize(r);
  assert.deepEqual(s, { killed: 1, survived: 1, invalid: 1, timeout: 1, error: 1, scored: 2, total: 5, score: 50 });
  assert.equal(summarize(report()).score, null);
  assert.equal(summarize(report({ results: [mutation({ outcome: 'invalid' })] })).score, null);
});

test('renderHtml escapes attacker-controlled mutation content in every field', () => {
  const malicious = '<script>alert(1)</script>&"\'';
  const r = report({
    baseline: { outcome: 'error', message: malicious },
    results: [mutation({ file: malicious, original: malicious, replacement: malicious, message: malicious, outcome: 'survived' })],
    totalPlanned: 1,
  });
  const html = renderHtml(r);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes(malicious), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes("script-src 'none'"), 'CSP must block script execution as defense in depth');
});

test('renderHtml shows an explanatory row when there are no results yet', () => {
  const html = renderHtml(report());
  assert.ok(html.includes('No mutation results'));
  assert.ok(html.includes('N/A'));
  assert.ok(html.includes('Incomplete run'));
});

test('renderHtml marks a finished report as complete', () => {
  const html = renderHtml(report({ complete: true, results: [mutation()], totalPlanned: 1 }));
  assert.ok(html.includes('Run complete'));
});

test('writeReport is atomic and always produces both report files, overwriting the previous version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apex-mutant-report-'));
  try {
    await writeReport(dir, report({ results: [mutation({ outcome: 'survived' })], totalPlanned: 2 }));
    let names = (await readdir(dir)).sort();
    assert.deepEqual(names, ['report.html', 'report.json']);
    const first = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(first.results.length, 1);
    assert.equal(first.summary.total, 1);

    await writeReport(dir, report({ results: [mutation({ outcome: 'survived' }), mutation({ outcome: 'killed' })], totalPlanned: 2, complete: true }));
    names = (await readdir(dir)).sort();
    assert.deepEqual(names, ['report.html', 'report.json'], 'no leftover .tmp files after a successful write');
    const second = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(second.results.length, 2);
    assert.equal(second.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeReport creates the output directory when missing', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'apex-mutant-report-')), 'nested', 'output');
  try {
    await writeReport(dir, report());
    await stat(join(dir, 'report.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeReport never writes through a pre-existing symlink at report.json/report.html: this is what the runner relies on for safe --output paths', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apex-mutant-report-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'apex-mutant-elsewhere-'));
  const decoyJson = join(elsewhere, 'decoy.json');
  const decoyHtml = join(elsewhere, 'decoy.html');
  try {
    await writeFile(decoyJson, 'not a report');
    await writeFile(decoyHtml, '<not a report>');
    await symlink(decoyJson, join(dir, 'report.json'));
    await symlink(decoyHtml, join(dir, 'report.html'));

    await writeReport(dir, report({ results: [mutation()], totalPlanned: 1 }));

    assert.equal(await readFile(decoyJson, 'utf8'), 'not a report', 'a file a symlink happened to point at must never be overwritten');
    assert.equal(await readFile(decoyHtml, 'utf8'), '<not a report>');
    assert.equal((await lstat(join(dir, 'report.json'))).isSymbolicLink(), false, 'the symlink must be replaced by a real file');
    assert.equal((await lstat(join(dir, 'report.html'))).isSymbolicLink(), false);
    const written = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(written.results.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('resolveRealPath resolves an existing symlinked ancestor and appends a not-yet-created remainder literally', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-realpath-'));
  try {
    const real = join(root, 'real-target');
    await mkdir(real, { recursive: true });
    const link = join(root, 'link');
    await symlink(real, link);

    assert.equal(await resolveRealPath(link), await resolveRealPath(real));
    // "future/output" does not exist yet under the symlink; the resolved path
    // must still land under the symlink's real target, not the symlink itself.
    const resolved = await resolveRealPath(join(link, 'future', 'output'));
    assert.equal(resolved, join(await resolveRealPath(real), 'future', 'output'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeFileAtomic cleans up its temp file when the final rename fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apex-mutant-atomic-'));
  try {
    // A directory sitting where the file should go makes the final rename() fail
    // (EISDIR/EPERM) without needing to mock the filesystem.
    await mkdir(join(dir, 'report.json'));
    await assert.rejects(writeFileAtomic(dir, 'report.json', 'content'));
    const leftovers = (await readdir(dir)).filter((name) => name !== 'report.json');
    assert.deepEqual(leftovers, [], 'no orphaned .report.json.<uuid>.tmp file should remain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertOutputOutsidePackageDirs rejects a direct, a not-yet-created nested, and a symlinked-ancestor path into a package directory, and accepts a safe one', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apex-mutant-outputcheck-'));
  try {
    const packageDir = join(root, 'force-app');
    await mkdir(packageDir, { recursive: true });

    await assert.rejects(assertOutputOutsidePackageDirs(root, ['force-app'], packageDir), /outside package directories/);
    await assert.rejects(assertOutputOutsidePackageDirs(root, ['force-app'], join(packageDir, 'deep', 'not', 'yet', 'created')), /outside package directories/);

    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const link = join(root, 'output-link');
    await symlink(elsewhere, link);
    await assert.doesNotReject(assertOutputOutsidePackageDirs(root, ['force-app'], link), 'a symlink resolving safely outside the package dir must be accepted');

    const insidePackage = join(packageDir, 'reports');
    await mkdir(insidePackage, { recursive: true });
    const badLink = join(root, 'bad-output-link');
    await symlink(insidePackage, badLink);
    await assert.rejects(assertOutputOutsidePackageDirs(root, ['force-app'], badLink), /outside package directories/);

    await assert.doesNotReject(assertOutputOutsidePackageDirs(root, ['force-app'], join(root, '.apex-mutant')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reportExitCode: 2 for incomplete, failed baseline, unresolved error/timeout, or no score; 1 below threshold; 0 otherwise', () => {
  const killed = mutation({ outcome: 'killed' });
  const survived = mutation({ outcome: 'survived' });

  assert.equal(reportExitCode(report({ results: [killed], complete: false })), 2, 'incomplete run');
  assert.equal(reportExitCode(report({ baseline: { outcome: 'killed' }, results: [killed], complete: true })), 2, 'baseline itself failed');
  assert.equal(reportExitCode(report({ results: [killed, mutation({ outcome: 'error' })], complete: true })), 2, 'unresolved error present');
  assert.equal(reportExitCode(report({ results: [killed, mutation({ outcome: 'timeout' })], complete: true })), 2, 'unresolved timeout present');
  assert.equal(reportExitCode(report({ results: [mutation({ outcome: 'invalid' })], complete: true })), 2, 'no scored mutants at all');

  assert.equal(reportExitCode(report({ results: [survived, survived, killed], complete: true, policy: enforcing(50) })), 1, 'below threshold in enforce mode');
  assert.equal(reportExitCode(report({ results: [survived, survived, killed], complete: true, policy: enforcing(33) })), 0, 'meets threshold in enforce mode');
  assert.equal(reportExitCode(report({ results: [survived, survived, killed], complete: true })), 0, 'advisory mode never gates on the score');
  assert.equal(reportExitCode(report({ results: [killed, killed], complete: true })), 0, '100% score with default threshold');
});
