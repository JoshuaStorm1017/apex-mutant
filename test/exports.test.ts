import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXPORT_FILENAMES, assertWorkItems, parseExportFormats, toCsv, toMarkdown, toSarif, writeExports } from '../src/exports.js';
import type { MutationResult, Report } from '../src/types.js';

function mutation(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    id: 'abc123', file: 'force-app/A.cls', operator: 'equality-negation',
    start: 0, end: 2, line: 12, column: 5, original: '==', replacement: '!=',
    outcome: 'survived', testsRun: 3, ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: 2, createdAt: '2026-01-01T00:00:00.000Z',
    tool: { name: 'apex-mutant', version: '0.0.0-test' },
    policy: { mode: 'advisory', threshold: 0 },
    traceability: { runId: 'run-1', workItems: ['ABC-123', 'release/2026.1'] },
    safeguards: {
      validator: 'built-in Salesforce validator', validationOnly: true, snapshotIsolated: true,
      orgCheck: { targetOrg: 'scratch', classification: 'scratch', message: "'scratch' is a scratch org." },
      sourceIntegrity: { verified: true, unchanged: true, filesChecked: 2, changedFiles: [], message: 'All 2 file(s) are identical.' },
      notes: [],
    },
    suppressions: { suppressed: [], problems: [] },
    baseline: { outcome: 'survived', testsRun: 3 },
    results: [mutation()], totalPlanned: 1, complete: true, ...overrides,
  };
}

test('export format parsing accepts lists, "all", and rejects anything else', () => {
  assert.deepEqual(parseExportFormats(['csv,sarif']), ['csv', 'sarif']);
  assert.deepEqual(parseExportFormats(['CSV', 'csv']), ['csv'], 'case-insensitive and de-duplicated');
  assert.deepEqual(parseExportFormats(['all']), ['csv', 'sarif', 'md']);
  assert.deepEqual(parseExportFormats([]), []);
  assert.throws(() => parseExportFormats(['xlsx']), /Unknown export format 'xlsx'/);
});

test('work items are validated, not sanitized after the fact', () => {
  assertWorkItems(['ABC-123', 'release/2026.1', 'a_b.c-1']);
  assert.throws(() => assertWorkItems(['=cmd|calc']), /Invalid work item/);
  assert.throws(() => assertWorkItems(['has space']), /Invalid work item/);
  assert.throws(() => assertWorkItems(['']), /Invalid work item/);
  assert.throws(() => assertWorkItems(['x'.repeat(65)]), /Invalid work item/);
});

test('CSV carries run traceability on every row and defuses spreadsheet formula injection', () => {
  const csv = toCsv(report({ results: [mutation({ original: '=cmd', replacement: '@SUM(1)' })] }));
  const [header, row, ...rest] = csv.trim().split('\n');
  assert.equal(rest.length, 0, 'one row per finding');
  assert.ok(header.startsWith('runId,workItems,tool,toolVersion,createdAt,mode,threshold,findingId,'));
  assert.ok(row.includes('"run-1","ABC-123 release/2026.1"'), 'run id and work items travel with every row');
  assert.ok(row.includes('"\'=cmd → @SUM(1)"'), 'a leading = is prefixed so spreadsheets do not evaluate it');
  assert.equal(row.includes(',=cmd'), false);
});

test('CSV quotes embedded quotes and flattens newlines so one finding stays one row', () => {
  const csv = toCsv(report({ baseline: { outcome: 'error', message: 'line one\nline "two"' } }));
  assert.equal(csv.trim().split('\n').length, 3, 'header plus baseline finding plus the surviving mutant');
  assert.ok(csv.includes('line one line ""two""'));
});

test('SARIF is well-formed, locates every code finding, and never emits an error level', () => {
  const sarif = JSON.parse(toSarif(report({
    results: [mutation(), mutation({ id: 'zzz', outcome: 'invalid', operator: 'arithmetic', testsRun: undefined })],
    totalPlanned: 2,
  })));
  assert.equal(sarif.version, '2.1.0');
  const [run] = sarif.runs;
  assert.equal(run.tool.driver.name, 'apex-mutant');
  assert.equal(run.tool.driver.version, '0.0.0-test');
  assert.equal(run.results.length, 2);
  const [gap] = run.results;
  assert.equal(gap.ruleId, 'test-gap/equality-negation');
  assert.equal(gap.locations[0].physicalLocation.artifactLocation.uri, 'force-app/A.cls');
  assert.deepEqual(gap.locations[0].physicalLocation.region, { startLine: 12, startColumn: 5 });
  assert.deepEqual(gap.properties.workItems, ['ABC-123', 'release/2026.1']);
  assert.equal(gap.properties.mutationId, 'abc123');
  assert.ok(run.results.every((r: { ruleId: string }) => run.tool.driver.rules.some((rule: { id: string }) => rule.id === r.ruleId)), 'every ruleId is declared');
  assert.ok(run.results.every((r: { level: string }) => r.level === 'note'), 'advisory runs emit notes only');
  assert.equal(run.properties.mutationScore, 0);
  assert.equal(run.properties.mode, 'advisory');
});

test('SARIF raises high-priority findings to warning only when the caller opted into enforcement, never to error', () => {
  const sarif = JSON.parse(toSarif(report({ policy: { mode: 'enforce', threshold: 80 } })));
  const levels = sarif.runs[0].results.map((r: { level: string }) => r.level);
  assert.deepEqual(levels, ['warning']);
  assert.equal(levels.includes('error'), false);
});

test('SARIF omits locations for run-level findings instead of inventing a file', () => {
  const sarif = JSON.parse(toSarif(report({ baseline: { outcome: 'error', message: 'no CLI' }, results: [], totalPlanned: 1, complete: false })));
  const runLevel = sarif.runs[0].results.filter((r: { ruleId: string }) => r.ruleId === 'run-quality');
  assert.equal(runLevel.length, 2, 'failed baseline and incomplete run');
  assert.ok(runLevel.every((r: { locations?: unknown }) => r.locations === undefined));
});

test('Markdown export is paste-ready: mode, safeguards, findings, hotspots, and the readiness checklist', () => {
  const md = toMarkdown(report());
  assert.ok(md.startsWith('# Apex Mutant run run-1'));
  assert.ok(md.includes('- Work items: ABC-123, release/2026.1'));
  assert.ok(md.includes('- Mode: advisory'));
  assert.ok(md.includes('Advisory run'));
  assert.ok(md.includes('validation-only'));
  assert.ok(md.includes('scratch'));
  assert.ok(md.includes('### [HIGH]'));
  assert.ok(md.includes('**Do this:**'));
  assert.ok(md.includes('| force-app/A.cls | 1 | 0 | 0.0% | 0 |'));
  assert.ok(md.includes('## Before enforcing a score in CI'));
  assert.ok(md.includes('- [ ] Runtime:'));
  assert.ok(toMarkdown(report({ policy: { mode: 'enforce', threshold: 80 } })).includes('- Mode: enforce (threshold 80%)'));
});

test('Markdown escapes table-breaking characters in table cells only, leaving prose readable', () => {
  const md = toMarkdown(report({ results: [mutation({ file: 'force-app/We|rd.cls', original: '&&', replacement: '||' })] }));
  assert.ok(md.includes('| force-app/We\\|rd.cls |'), 'the hotspot table cell is escaped');
  assert.ok(md.includes('(equality-negation: `&& → ||`)'), 'prose keeps the operator readable');
  assert.equal(md.includes('\\|\\|'), false);
});

test('writeExports writes exactly the requested files into the output directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apex-mutant-exports-'));
  try {
    const written = await writeExports(directory, report(), ['csv', 'sarif', 'md']);
    assert.deepEqual(written, [EXPORT_FILENAMES.csv, EXPORT_FILENAMES.sarif, EXPORT_FILENAMES.md]);
    for (const name of written) assert.ok((await readFile(join(directory, name), 'utf8')).length > 0);
    assert.deepEqual(await writeExports(directory, report(), []), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
