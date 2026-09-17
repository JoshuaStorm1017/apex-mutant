import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMutations } from '../src/mutations.js';
import { applySuppressions, findSuppressions, staleMarkerProblem } from '../src/suppressions.js';
import { planProjectDetailed } from '../src/project.js';
import type { Project } from '../src/project.js';

const project = (files: Record<string, string>): Project => ({
  root: '/virtual-root', packageDirs: ['force-app'],
  files: new Map(Object.entries(files)), config: {},
});

test('a well-formed marker is read from the line comment above the code it applies to', () => {
  const source = [
    'public class A {',
    '  // apex-mutant-disable-next-line conditional-boundary: quantity is never zero here',
    '  Boolean m(Integer i) { return i < 3; }',
    '}',
  ].join('\n');
  const { markers, problems } = findSuppressions(source, 'force-app/A.cls');
  assert.deepEqual(problems, []);
  assert.deepEqual(markers, [{
    file: 'force-app/A.cls', line: 2, scope: 'conditional-boundary',
    reason: 'quantity is never zero here', appliesToLine: 3,
  }]);
});

test('a trailing marker applies to its own line, and directives are case-insensitive', () => {
  const source = 'public class A {\n  Boolean m() { return true; } // APEX-MUTANT-DISABLE-LINE All: constant by design\n}';
  const { markers, problems } = findSuppressions(source, 'force-app/A.cls');
  assert.deepEqual(problems, []);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].scope, 'all');
  assert.equal(markers[0].appliesToLine, 2);
  assert.equal(markers[0].reason, 'constant by design', 'the reason keeps its original casing');
});

test('markers are read from comment tokens, so a directive inside a string literal is just a string', () => {
  const source = 'public class A {\n  String s = \'// apex-mutant-disable-line all: not a directive\';\n  Boolean m() { return true; }\n}';
  const { markers, problems } = findSuppressions(source, 'force-app/A.cls');
  assert.deepEqual(markers, [], 'a string is never a suppression');
  assert.deepEqual(problems, [], 'and it is not reported as a broken one either');
});

test('a directive in a block comment is reported, not honored: commenting code out is not suppressing it', () => {
  const source = 'public class A {\n  /* apex-mutant-disable-next-line all: hidden in a block */\n  Boolean m() { return true; }\n}';
  const { markers, problems } = findSuppressions(source, 'force-app/A.cls');
  assert.deepEqual(markers, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /only works in a \/\/ line comment/);
});

test('a marker without a real reason, or with an unknown scope, suppresses nothing and says why', () => {
  const cases: [string, RegExp][] = [
    ['// apex-mutant-disable-next-line all', /missing a scope and a reason/],
    ['// apex-mutant-disable-next-line all:', /missing a scope and a reason/],
    ['// apex-mutant-disable-next-line all: ok', /at least 5 characters/],
    ['// apex-mutant-disable-next-line not-an-operator: some good reason', /Unknown suppression scope/],
    ['// apex-mutant-disable-everything all: some good reason', /Unrecognized suppression directive/],
  ];
  for (const [comment, expected] of cases) {
    const { markers, problems } = findSuppressions(`public class A {\n  ${comment}\n  Boolean m() { return true; }\n}`, 'force-app/A.cls');
    assert.deepEqual(markers, [], `${comment} must suppress nothing`);
    assert.equal(problems.length, 1, comment);
    assert.match(problems[0].message, expected);
  }
});

test('suppression is scoped to the named operator, and "all" covers every operator on the line', () => {
  const source = 'public class A {\n  Boolean m(Integer i) { return i < 3 && true; }\n}';
  const mutations = generateMutations(source, 'force-app/A.cls');
  assert.ok(mutations.length >= 3, 'fixture should produce boundary, connector, and literal mutants');

  const scoped = applySuppressions(mutations, [{ file: 'force-app/A.cls', line: 1, scope: 'boolean-literal', reason: 'documented', appliesToLine: 2 }]);
  assert.deepEqual(scoped.suppressed.map((m) => m.operator), ['boolean-literal']);
  assert.equal(scoped.kept.length, mutations.length - 1);
  assert.deepEqual(scoped.unusedMarkers, []);
  assert.equal(scoped.suppressed[0].reason, 'documented');
  assert.equal(scoped.suppressed[0].markerLine, 1);

  const all = applySuppressions(mutations, [{ file: 'force-app/A.cls', line: 1, scope: 'all', reason: 'documented', appliesToLine: 2 }]);
  assert.deepEqual(all.kept, []);
  assert.equal(all.suppressed.length, mutations.length);
});

test('a marker that matches nothing is reported as stale rather than silently accepted', () => {
  const source = 'public class A {\n  Boolean m(Integer i) { return i < 3; }\n}';
  const mutations = generateMutations(source, 'force-app/A.cls');
  const marker = { file: 'force-app/A.cls', line: 40, scope: 'all', reason: 'code moved away', appliesToLine: 41 };
  const { kept, suppressed, unusedMarkers } = applySuppressions(mutations, [marker]);
  assert.equal(kept.length, mutations.length, 'nothing is hidden by a stale marker');
  assert.deepEqual(suppressed, []);
  assert.deepEqual(unusedMarkers, [marker]);
  const problem = staleMarkerProblem(marker);
  assert.equal(problem.line, 40);
  assert.match(problem.message, /matches no mutation on line 41/);
});

test('planProjectDetailed excludes suppressed mutants from the plan and reports marker problems', () => {
  const p = project({
    'force-app/A.cls': [
      'public class A {',
      '  // apex-mutant-disable-next-line boolean-literal: this flag is compile-time constant',
      '  Boolean m() { return true; }',
      '  // apex-mutant-disable-next-line all: nothing on the following line',
      '  }',
      '',
    ].join('\n'),
  });
  const plan = planProjectDetailed(p);
  assert.deepEqual(plan.mutations, [], 'the only mutant in this file is suppressed');
  assert.equal(plan.suppressed.length, 1);
  assert.equal(plan.suppressed[0].operator, 'boolean-literal');
  assert.equal(plan.suppressed[0].reason, 'this flag is compile-time constant');
  assert.equal(plan.problems.length, 1, 'the second marker matched nothing');
  assert.match(plan.problems[0].message, /matches no mutation/);
});

test('suppression is applied before filters, so narrowing a run never resurrects a suppressed mutant', () => {
  const source = [
    'public class A {',
    '  // apex-mutant-disable-next-line boolean-literal: constant by construction',
    '  Boolean m(Integer i) { return i < 3 && true; }',
    '}',
  ].join('\n');
  const p = project({ 'force-app/A.cls': source });
  const filtered = planProjectDetailed(p, { operators: ['boolean-literal'] });
  assert.deepEqual(filtered.mutations, [], 'the suppressed mutant is not selected even when it is the only operator asked for');
  assert.equal(filtered.suppressed.length, 1);

  // A marker for a different operator is not stale just because this run filtered it out.
  const other = planProjectDetailed(p, { operators: ['conditional-boundary'] });
  assert.equal(other.mutations.length, 1);
  assert.deepEqual(other.problems, []);
  assert.deepEqual(other.suppressed, [], 'suppressed entries respect the operator filter for display');
});
