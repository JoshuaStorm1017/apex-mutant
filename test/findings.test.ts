import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFindings, fileHotspots, operatorGuidance } from '../src/findings.js';
import { OPERATOR_IDS } from '../src/mutations.js';
import type { MutationResult, Report } from '../src/types.js';

function mutation(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    id: 'abc', file: 'force-app/A.cls', operator: 'boolean-literal',
    start: 0, end: 4, line: 7, column: 3, original: 'true', replacement: 'false',
    outcome: 'survived', testsRun: 4, ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemaVersion: 2, createdAt: '2026-01-01T00:00:00.000Z',
    tool: { name: 'apex-mutant', version: 'test' },
    policy: { mode: 'advisory', threshold: 0 },
    traceability: { runId: 'run-1', workItems: [] },
    safeguards: { validator: 'test', validationOnly: false, snapshotIsolated: true, orgCheck: null, sourceIntegrity: null, notes: [] },
    suppressions: { suppressed: [], problems: [] },
    baseline: { outcome: 'survived', testsRun: 4 },
    results: [], totalPlanned: 0, complete: true, ...overrides,
  };
}

test('a surviving mutant becomes a located, actionable test-gap finding', () => {
  const [finding, ...rest] = buildFindings(report({ results: [mutation()], totalPlanned: 1 }));
  assert.equal(rest.length, 0);
  assert.equal(finding.category, 'test-gap');
  assert.equal(finding.priority, 'high');
  assert.equal(finding.equivalenceRisk, 'low');
  assert.equal(finding.file, 'force-app/A.cls');
  assert.equal(finding.line, 7);
  assert.equal(finding.column, 3);
  assert.equal(finding.change, 'true → false');
  assert.match(finding.detail, /force-app\/A\.cls:7:3/);
  assert.match(finding.detail, /4 test method\(s\) ran against the mutant and all passed/);
  // The point of a finding is the next action, not the label.
  assert.ok(finding.suggestedAction.length > 40, 'a finding must carry a concrete suggested action');
  assert.equal(finding.suggestedAction, operatorGuidance('boolean-literal').action);
});

test('mutants with no test evidence are separated from real gaps and ranked below them', () => {
  const findings = buildFindings(report({
    results: [
      mutation({ id: 'invalid-1', outcome: 'invalid', message: 'Validation reported component or compilation errors.', testsRun: undefined }),
      mutation({ id: 'survived-1', outcome: 'survived' }),
      mutation({ id: 'killed-1', outcome: 'killed' }),
    ],
    totalPlanned: 3,
  }));
  assert.deepEqual(findings.map((f) => f.id), ['survived-1', 'invalid-1'], 'killed mutants produce no finding; gaps rank first');
  const [, unproven] = findings;
  assert.equal(unproven.category, 'unproven-mutant');
  assert.equal(unproven.priority, 'low');
  assert.match(unproven.detail, /proves nothing about test quality/);
  assert.match(unproven.suggestedAction, /did not compile/);
});

test('operator guidance covers every operator the planner emits, and unknown operators degrade honestly', () => {
  for (const operator of OPERATOR_IDS) {
    const guidance = operatorGuidance(operator);
    assert.ok(guidance.behavior.length > 20, `${operator} needs an explanation of what a survivor means`);
    assert.ok(guidance.action.length > 20, `${operator} needs a suggested action`);
    assert.notEqual(guidance.equivalenceRisk, 'unknown', `${operator} should have an assessed equivalence risk`);
  }
  const unknown = operatorGuidance('operator-that-does-not-exist');
  assert.equal(unknown.equivalenceRisk, 'unknown');
  assert.equal(unknown.priority, 'medium');
});

test('boundary and arithmetic survivors are flagged as possible equivalent mutants rather than certain gaps', () => {
  const findings = buildFindings(report({
    results: [mutation({ operator: 'conditional-boundary', original: '<', replacement: '<=' })], totalPlanned: 1,
  }));
  assert.equal(findings[0].equivalenceRisk, 'moderate');
  assert.match(findings[0].suggestedAction, /equivalent/);
});

test('a failed baseline and a short run are reported as run-quality findings, not as test gaps', () => {
  const findings = buildFindings(report({
    baseline: { outcome: 'error', message: 'Salesforce CLI unavailable.' },
    results: [mutation()], totalPlanned: 5, complete: false,
  }));
  const baseline = findings.find((f) => f.id === 'baseline-not-green');
  const incomplete = findings.find((f) => f.id === 'run-incomplete');
  assert.ok(baseline && incomplete, 'both run-level problems are reported');
  assert.equal(baseline!.category, 'run-quality');
  assert.match(baseline!.detail, /Salesforce CLI unavailable/);
  assert.match(incomplete!.detail, /1 of 5 planned mutant\(s\) were evaluated/);
  assert.equal(findings[0].id, 'baseline-not-green', 'a broken run outranks individual findings');
});

test('a clean, complete, fully-killed run produces no findings at all', () => {
  assert.deepEqual(buildFindings(report({ results: [mutation({ outcome: 'killed' })], totalPlanned: 1 })), []);
});

test('hotspots rank files by surviving mutants, then by weakest score', () => {
  const hotspots = fileHotspots(report({
    results: [
      mutation({ file: 'force-app/A.cls', outcome: 'survived' }),
      mutation({ file: 'force-app/A.cls', outcome: 'killed' }),
      mutation({ file: 'force-app/B.cls', outcome: 'survived' }),
      mutation({ file: 'force-app/B.cls', outcome: 'survived' }),
      mutation({ file: 'force-app/C.cls', outcome: 'invalid' }),
    ],
    totalPlanned: 5,
  }));
  assert.deepEqual(hotspots.map((h) => h.file), ['force-app/B.cls', 'force-app/A.cls', 'force-app/C.cls']);
  assert.deepEqual(hotspots[0], { file: 'force-app/B.cls', survived: 2, killed: 0, scored: 2, score: 0, inconclusive: 0 });
  assert.equal(hotspots[1].score, 50);
  assert.equal(hotspots[2].score, null, 'a file with nothing scored has no score, not a zero');
});
