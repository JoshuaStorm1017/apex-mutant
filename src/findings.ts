import type { Mutation, MutationResult, Report, SuppressedMutation } from './types.js';

export type FindingCategory = 'test-gap' | 'unproven-mutant' | 'suppressed' | 'run-quality';
export type FindingPriority = 'high' | 'medium' | 'low';
/** How plausible it is that a surviving mutant of this operator class is behaviorally
 * equivalent to the original (i.e. no test could ever kill it). A heuristic about the
 * operator, never a proof about this particular line — apex-mutant does no semantic
 * analysis. 'low' means a survivor here is usually a real assertion gap. */
export type EquivalenceRisk = 'low' | 'moderate' | 'unknown';

export interface Finding {
  id: string;
  category: FindingCategory;
  priority: FindingPriority;
  equivalenceRisk: EquivalenceRisk;
  file: string;
  line: number;
  column: number;
  operator: string;
  change: string;
  title: string;
  detail: string;
  /** A concrete next action, phrased so it can be pasted into a work item. */
  suggestedAction: string;
  testsRun?: number;
}

export interface FileHotspot {
  file: string;
  survived: number;
  killed: number;
  scored: number;
  /** killed / (killed + survived) for this file, or null when nothing scored. */
  score: number | null;
  inconclusive: number;
}

interface OperatorGuidance {
  priority: FindingPriority;
  equivalenceRisk: EquivalenceRisk;
  behavior: string;
  action: string;
}

/** What a surviving mutant of each operator class actually tells a developer, and the
 * smallest test change that would close the gap. Wording is deliberately about
 * assertions and inputs — a mutation score on its own is not an action. */
const OPERATOR_GUIDANCE: Record<string, OperatorGuidance> = {
  'equality-negation': {
    priority: 'high', equivalenceRisk: 'low',
    behavior: 'the equality check was inverted and the selected tests still passed, so no test distinguishes the matching case from the non-matching one',
    action: 'Exercise this comparison with a value that matches and one that does not, and assert a different observable result (return value, DML written, or error thrown) for each.',
  },
  'boolean-literal': {
    priority: 'high', equivalenceRisk: 'low',
    behavior: 'the literal was flipped and the selected tests still passed, so no test asserts anything that depends on its value',
    action: 'Assert the behavior this flag controls — the state or output that differs between true and false — rather than only that the code runs.',
  },
  'logical-connector': {
    priority: 'high', equivalenceRisk: 'low',
    behavior: 'AND and OR were swapped and the selected tests still passed, so no test covers an input combination where the two differ',
    action: 'Add a case where one operand is true and the other false, and assert the result differs from the all-true and all-false cases.',
  },
  'negation-removal': {
    priority: 'high', equivalenceRisk: 'low',
    behavior: 'the `!` was removed and the selected tests still passed, so the guarded branch is not asserted in both directions',
    action: 'Cover both the negated and non-negated condition and assert a different outcome for each.',
  },
  'conditional-boundary': {
    priority: 'medium', equivalenceRisk: 'moderate',
    behavior: 'the comparison boundary moved by one (for example `<` to `<=`) and the selected tests still passed, so no test pins the exact boundary value',
    action: 'Add a case at the exact boundary value and assert which side it falls on. If the boundary value cannot occur by construction, record this mutant as equivalent instead of adding a test.',
  },
  'arithmetic': {
    priority: 'medium', equivalenceRisk: 'moderate',
    behavior: 'the arithmetic operator was changed and the selected tests still passed, so no test asserts the computed value',
    action: 'Assert the exact computed value for at least one input where the original and mutated operators differ, instead of asserting only that a value is non-null.',
  },
  'increment-decrement': {
    priority: 'medium', equivalenceRisk: 'moderate',
    behavior: 'an increment was changed to a decrement (or the reverse) and the selected tests still passed, so no test asserts the resulting count or index',
    action: 'Assert the final counter, size, or index value after the loop or accumulation, not just that it completed.',
  },
  'unary-negation-removal': {
    priority: 'medium', equivalenceRisk: 'moderate',
    behavior: 'a unary minus was removed and the selected tests still passed, so no test asserts the sign of the value',
    action: 'Assert the signed value (including a negative case) where this expression is used.',
  },
};

const UNKNOWN_OPERATOR: OperatorGuidance = {
  priority: 'medium', equivalenceRisk: 'unknown',
  behavior: 'the change survived the selected tests, so no test observed the difference it makes',
  action: 'Assert the behavior this expression controls with inputs where the original and mutated code differ.',
};

export function operatorGuidance(operator: string): OperatorGuidance {
  return OPERATOR_GUIDANCE[operator] ?? UNKNOWN_OPERATOR;
}

const location = (mutation: Mutation) => `${mutation.file}:${mutation.line}:${mutation.column}`;
const change = (mutation: Mutation) => `${mutation.original.trim() || '(empty)'} → ${mutation.replacement.trim() || '(removed)'}`;

const PRIORITY_ORDER: Record<FindingPriority, number> = { high: 0, medium: 1, low: 2 };

function testGap(result: MutationResult): Finding {
  const guidance = operatorGuidance(result.operator);
  return {
    id: result.id, category: 'test-gap', priority: guidance.priority,
    equivalenceRisk: guidance.equivalenceRisk,
    file: result.file, line: result.line, column: result.column, operator: result.operator,
    change: change(result), testsRun: result.testsRun,
    title: `Unkilled ${result.operator} mutant at ${location(result)}`,
    detail: `At ${location(result)}, ${change(result)}: ${guidance.behavior}.` +
      (result.testsRun ? ` ${result.testsRun} test method(s) ran against the mutant and all passed.` : ''),
    suggestedAction: guidance.action,
  };
}

function unprovenMutant(result: MutationResult): Finding {
  return {
    id: result.id, category: 'unproven-mutant', priority: 'low', equivalenceRisk: 'unknown',
    file: result.file, line: result.line, column: result.column, operator: result.operator,
    change: change(result), testsRun: result.testsRun,
    title: `No test evidence for ${result.operator} mutant at ${location(result)}`,
    detail: `At ${location(result)}, ${change(result)} produced outcome '${result.outcome}'` +
      `${result.message ? ` — ${result.message}` : ''}. This mutant proves nothing about test quality either way and is excluded from the score.`,
    suggestedAction: result.outcome === 'invalid'
      ? 'No action needed for test quality: the mutant did not compile. Exclude this operator here if such mutants are frequent enough to waste run time.'
      : 'Re-run this mutant once the environment issue is resolved; the score below is based on fewer mutants than planned.',
  };
}

function suppressedFinding(mutation: SuppressedMutation): Finding {
  return {
    id: mutation.id, category: 'suppressed', priority: 'low', equivalenceRisk: 'unknown',
    file: mutation.file, line: mutation.line, column: mutation.column, operator: mutation.operator,
    change: change(mutation),
    title: `Suppressed ${mutation.operator} mutant at ${location(mutation)}`,
    detail: `This mutant was never validated because line ${mutation.markerLine} of ${mutation.file} suppresses it: "${mutation.reason}". It is excluded from the score's denominator.`,
    suggestedAction: 'Re-check this reason whenever the surrounding logic changes. A suppression that outlives its justification quietly caps the score with no evidence behind it.',
  };
}

function runQuality(id: string, title: string, detail: string, action: string, priority: FindingPriority = 'high'): Finding {
  return {
    id, category: 'run-quality', priority, equivalenceRisk: 'unknown',
    file: '', line: 0, column: 0, operator: '', change: '',
    title, detail, suggestedAction: action,
  };
}

/** Turn a report into concrete, per-location work items. Surviving mutants become
 * test-gap findings with a suggested assertion; mutants with no test evidence become
 * separate, explicitly lower-priority findings so they are never mistaken for gaps;
 * run-level problems (failed baseline, aborted run, environment errors) are reported
 * as run-quality findings rather than silently degrading the score. */
export function buildFindings(report: Report): Finding[] {
  const findings: Finding[] = [];
  if (report.baseline.outcome !== 'survived') {
    findings.push(runQuality(
      'baseline-not-green',
      'Baseline validation did not pass before mutants ran',
      `The unmutated project produced outcome '${report.baseline.outcome}'` +
        `${report.baseline.message ? ` — ${report.baseline.message}` : ''}. Mutant results are only meaningful when the unmutated project validates cleanly with the selected tests.`,
      'Fix the baseline first: confirm the selected test classes exist, pass, and that the project deploys as a validation-only run.',
    ));
  }
  for (const result of report.results) {
    if (result.outcome === 'survived') findings.push(testGap(result));
    else if (result.outcome !== 'killed') findings.push(unprovenMutant(result));
  }
  for (const mutation of report.suppressions.suppressed) findings.push(suppressedFinding(mutation));
  for (const [index, problem] of report.suppressions.problems.entries()) {
    findings.push(runQuality(
      `suppression-problem-${index}`,
      `Suppression marker problem in ${problem.file}:${problem.line}`,
      `${problem.message} Nothing was suppressed by it, so no mutant is hidden — but the marker is not doing what its author expects.`,
      'Fix or remove the marker so the file says what it means.',
      'medium',
    ));
  }
  if (!report.complete) {
    findings.push(runQuality(
      'run-incomplete',
      'Run did not evaluate every planned mutant',
      `${report.results.length} of ${report.totalPlanned} planned mutant(s) were evaluated. Any score below is computed from the evaluated subset only.`,
      'Re-run the remaining mutants (or narrow the plan with --include/--max-mutants) before using this run as evidence.',
      'medium',
    ));
  }
  return findings.sort((a, b) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.id.localeCompare(b.id));
}

/** Where the unkilled mutants concentrate. Files are ranked by surviving mutants,
 * then by weakest score — a standing list of which Apex is least covered by
 * assertions, rather than a single project-wide number. */
export function fileHotspots(report: Report): FileHotspot[] {
  const byFile = new Map<string, FileHotspot>();
  for (const result of report.results) {
    const hotspot = byFile.get(result.file) ??
      { file: result.file, survived: 0, killed: 0, scored: 0, score: null, inconclusive: 0 };
    if (result.outcome === 'survived') hotspot.survived++;
    else if (result.outcome === 'killed') hotspot.killed++;
    else hotspot.inconclusive++;
    hotspot.scored = hotspot.killed + hotspot.survived;
    hotspot.score = hotspot.scored ? hotspot.killed / hotspot.scored * 100 : null;
    byFile.set(result.file, hotspot);
  }
  return [...byFile.values()].sort((a, b) =>
    b.survived - a.survived || (a.score ?? 101) - (b.score ?? 101) || a.file.localeCompare(b.file));
}
