import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderHtml, reportExitCode, summarize, writeReport } from '../src/report.js';
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
    schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z',
    baseline: { outcome: 'survived', testsRun: 3 },
    results: [], totalPlanned: 0, complete: false, ...overrides,
  };
}

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

test('reportExitCode: 2 for incomplete, failed baseline, unresolved error/timeout, or no score; 1 below threshold; 0 otherwise', () => {
  const killed = mutation({ outcome: 'killed' });
  const survived = mutation({ outcome: 'survived' });

  assert.equal(reportExitCode(report({ results: [killed], complete: false })), 2, 'incomplete run');
  assert.equal(reportExitCode(report({ baseline: { outcome: 'killed' }, results: [killed], complete: true })), 2, 'baseline itself failed');
  assert.equal(reportExitCode(report({ results: [killed, mutation({ outcome: 'error' })], complete: true })), 2, 'unresolved error present');
  assert.equal(reportExitCode(report({ results: [killed, mutation({ outcome: 'timeout' })], complete: true })), 2, 'unresolved timeout present');
  assert.equal(reportExitCode(report({ results: [mutation({ outcome: 'invalid' })], complete: true })), 2, 'no scored mutants at all');

  assert.equal(reportExitCode(report({ results: [survived, survived, killed], complete: true }), 50), 1, 'below threshold');
  assert.equal(reportExitCode(report({ results: [survived, survived, killed], complete: true }), 33), 0, 'meets threshold');
  assert.equal(reportExitCode(report({ results: [killed, killed], complete: true })), 0, '100% score with default threshold');
});
