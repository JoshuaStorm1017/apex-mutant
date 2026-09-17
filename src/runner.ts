import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyMutation } from './mutations.js';
import { snapshotProject, assertSafeRelativePath, verifySourceIntegrity, type Project } from './project.js';
import { writeReport, assertOutputOutsidePackageDirs } from './report.js';
import { assertWorkItems, writeExports, type ExportFormat } from './exports.js';
import { TOOL_NAME, VERSION } from './version.js';
import { ADVISORY_POLICY } from './types.js';
import type { EnforcementPolicy, Mutation, Report, RunSafeguards, SuppressionRecord, ValidationOptions, Validator, ExecutionResult, Outcome } from './types.js';

const VALID_OUTCOMES = new Set<Outcome>(['killed', 'survived', 'invalid', 'timeout', 'error']);

/** A custom Validator is arbitrary caller code; never trust its result shape as
 * evidence without checking it. An unknown outcome, or a 'survived'/'killed' claim
 * without a real (finite, positive, integer) testsRun count, is downgraded to
 * `error` rather than silently counted as a kill or a survival. */
function sanitizeResult(result: ExecutionResult): ExecutionResult {
  if (!result || typeof result !== 'object' || !VALID_OUTCOMES.has(result.outcome)) {
    return { outcome: 'error', message: 'Validator returned a result with a missing or unrecognized outcome.' };
  }
  const testsRunIsPositiveInteger = Number.isInteger(result.testsRun) && result.testsRun! > 0;
  if ((result.outcome === 'survived' || result.outcome === 'killed') && !testsRunIsPositiveInteger) {
    return { outcome: 'error', message: `Validator reported '${result.outcome}' without a valid positive testsRun count; this cannot be trusted as test evidence.` };
  }
  if (result.testsRun !== undefined && !(Number.isInteger(result.testsRun) && result.testsRun >= 0)) {
    return { outcome: 'error', message: `Validator returned a malformed testsRun value for outcome '${result.outcome}'.` };
  }
  return result;
}

/** What the caller can tell apex-mutant about how this run is being executed. Only
 * the fields a caller can actually vouch for are accepted; everything else is
 * recorded by the runner itself. Omitted fields fail closed: a run whose caller
 * claims nothing is reported as un-attested rather than as validation-only. */
export interface SafeguardEvidence {
  validator?: string;
  validationOnly?: boolean;
  orgCheck?: RunSafeguards['orgCheck'];
  notes?: string[];
}

export interface RunOptions {
  targetOrg: string;
  tests: string[];
  waitMinutes: number;
  timeoutMs: number;
  output: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, result: ExecutionResult) => void;
  /** Defaults to advisory: the score is reported and never gates the exit code. */
  policy?: EnforcementPolicy;
  workItems?: string[];
  runId?: string;
  safeguards?: SafeguardEvidence;
  /** Mutants excluded by in-source markers, recorded so the exclusion is visible. */
  suppressions?: SuppressionRecord;
  exports?: ExportFormat[];
}

const UNATTESTED_VALIDATOR = 'Caller-supplied validator: apex-mutant cannot attest what it sends to the org.';

function assertPolicy(policy: EnforcementPolicy): void {
  if ((policy.mode !== 'advisory' && policy.mode !== 'enforce') ||
    !Number.isFinite(policy.threshold) || policy.threshold < 0 || policy.threshold > 100) {
    throw new Error("Policy must be mode 'advisory' or 'enforce' with a threshold between 0 and 100.");
  }
}

export async function runMutations(project: Project, mutations: Mutation[], options: RunOptions, validate: Validator): Promise<Report> {
  if (!options.targetOrg.trim() || !options.tests.length || options.tests.some((t) => !t.trim())) throw new Error('An explicit target org and test class names are required.');
  if (!mutations.length) throw new Error('No mutations selected. Try different source paths or operators.');
  if (!(options.waitMinutes >= 1) || !(options.timeoutMs >= 1)) throw new Error('Wait and timeout must be positive.');
  const policy = options.policy ?? ADVISORY_POLICY;
  assertPolicy(policy);
  const workItems = [...(options.workItems ?? [])];
  assertWorkItems(workItems);
  const exportFormats = options.exports ?? [];
  // Checked before any snapshot is created or the validator is ever invoked: this is
  // also the CLI's --output guard, shared so a library caller gets the same guarantee.
  await assertOutputOutsidePackageDirs(project.root, project.packageDirs, options.output);
  const snapshot = await snapshotProject(project);
  const report: Report = {
    schemaVersion: 2,
    tool: { name: TOOL_NAME, version: VERSION },
    createdAt: new Date().toISOString(),
    policy,
    traceability: { runId: options.runId ?? randomUUID(), workItems },
    safeguards: {
      validator: options.safeguards?.validator ?? UNATTESTED_VALIDATOR,
      validationOnly: options.safeguards?.validationOnly === true,
      snapshotIsolated: true,
      orgCheck: options.safeguards?.orgCheck ?? null,
      sourceIntegrity: null,
      notes: [...(options.safeguards?.notes ?? [])],
    },
    suppressions: {
      suppressed: [...(options.suppressions?.suppressed ?? [])],
      problems: [...(options.suppressions?.problems ?? [])],
    },
    baseline: { outcome: 'error', message: 'Baseline has not completed.' },
    results: [], totalPlanned: mutations.length, complete: false,
  };
  const validation: ValidationOptions = {
    projectDir: snapshot.directory, sourceDirs: project.packageDirs,
    targetOrg: options.targetOrg, tests: options.tests,
    waitMinutes: options.waitMinutes, timeoutMs: options.timeoutMs, signal: options.signal,
  };
  async function execute(): Promise<ExecutionResult> {
    try { return sanitizeResult(await validate(validation)); }
    catch { return { outcome: 'error', message: 'Validator failed unexpectedly. Check local Salesforce CLI configuration.' }; }
  }
  try {
    await writeReport(options.output, report);
    if (!options.signal?.aborted) {
      report.baseline = await execute();
      await writeReport(options.output, report);
      // Mutant results are only meaningful against a clean baseline; anything else
      // means the environment, not the tests, decided the outcome.
      if (report.baseline.outcome === 'survived' && report.baseline.testsRun! > 0) {
        for (const mutation of mutations) {
          if (options.signal?.aborted) break;
          const source = project.files.get(mutation.file);
          if (source === undefined) throw new Error('Mutation references a file outside the project snapshot.');
          assertSafeRelativePath(mutation.file);
          const filename = join(snapshot.directory, mutation.file);
          await writeFile(filename, applyMutation(source, mutation));
          let result: ExecutionResult;
          try { result = await execute(); }
          finally { await writeFile(filename, source); }
          report.results.push({ ...mutation, ...result });
          await writeReport(options.output, report);
          options.onProgress?.(report.results.length, mutations.length, result);
          // Stop spending org requests when the environment has failed or a job is still running.
          if (result.outcome === 'error' || result.outcome === 'timeout') break;
        }
        report.complete = report.results.length === mutations.length && !options.signal?.aborted;
      }
    }
    // Evidence, not a restatement: re-read the project's own files and record whether
    // they still match what was read before the run.
    report.safeguards.sourceIntegrity = await verifySourceIntegrity(project);
    await writeReport(options.output, report);
    if (exportFormats.length) await writeExports(options.output, report, exportFormats);
    return report;
  } finally { await snapshot.cleanup(); }
}
