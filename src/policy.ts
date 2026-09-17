import type { EnforcementPolicy, Report } from './types.js';

/** The evidence a team needs about its own runs before a mutation score can
 * reasonably gate a build. Deliberately generic engineering criteria: apex-mutant
 * cannot supply these for you, and shipping them as a checklist is the honest
 * alternative to shipping a default threshold that fails builds on day one. */
export const ENFORCEMENT_READINESS: readonly string[] = [
  'Runtime: a full run finishes inside the time your pipeline can afford, measured on your own codebase.',
  'Stability: repeated runs on unchanged source produce the same outcomes (no flaky kills or survivals).',
  'Scope: the mutants and tests a run covers are the ones you intend to gate on, not an arbitrary subset.',
  'Restoration safety: every run happens in a disposable or provably restored org, with evidence retained.',
  'Equivalent mutants: you have a way to record and exclude mutants no test could ever kill.',
  'False positives: inconclusive outcomes (invalid, timeout, error) are understood and do not silently move the score.',
];

/** What a report is allowed to claim about itself given the mode it ran in. */
export function advisoryNotice(policy: EnforcementPolicy): string {
  return policy.mode === 'advisory'
    ? 'Advisory run: the mutation score below is evidence about test quality, not a pass/fail gate. It does not affect the exit code.'
    : `Enforcing run: the caller opted in with --enforce and a threshold of ${policy.threshold}%. A completed run scoring below that threshold exits 1.`;
}

/** Mutation testing measures whether existing tests detect deliberate changes. It is
 * evidence about assertion strength only, and stating that plainly in every report
 * keeps the result from being read as broader assurance than it is. */
export const SCOPE_STATEMENT =
  'Mutation testing measures whether the selected Apex tests detect deliberate source changes. ' +
  'It does not replace integration, contract, UI, security, or environment testing, and it makes no claim about anything the selected tests do not execute.';

/** True when the run produced a score that can be read at all: a clean baseline, a
 * complete run, no unresolved environment failures, and at least one scored mutant. */
export function isConclusive(report: Report, errors: number, timeouts: number, score: number | null): boolean {
  return report.complete && report.baseline.outcome === 'survived' && !errors && !timeouts && score !== null;
}
