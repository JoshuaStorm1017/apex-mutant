export interface Mutation {
  id: string;
  file: string;
  operator: string;
  start: number;
  end: number;
  line: number;
  column: number;
  original: string;
  replacement: string;
}

export type Outcome = 'survived' | 'killed' | 'invalid' | 'timeout' | 'error';
export interface ExecutionResult {
  outcome: Outcome;
  message?: string;
  testsRun?: number;
  durationMs?: number;
}
export interface MutationResult extends Mutation, ExecutionResult {}
export interface ValidationOptions {
  projectDir: string;
  sourceDirs: string[];
  targetOrg: string;
  tests: string[];
  waitMinutes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}
export type Validator = (options: ValidationOptions) => Promise<ExecutionResult>;

/** Advisory is the default and the only mode that needs no prior evidence: the
 * mutation score is reported but never decides the exit code. 'enforce' is an
 * explicit, opt-in gate and requires a threshold the caller chose deliberately. */
export type EnforcementMode = 'advisory' | 'enforce';
export interface EnforcementPolicy {
  mode: EnforcementMode;
  /** Only consulted in 'enforce' mode. */
  threshold: number;
}
export const ADVISORY_POLICY: EnforcementPolicy = { mode: 'advisory', threshold: 0 };

/** Free-form identifiers (ticket, story, change request, test-case ID) supplied by
 * the caller and echoed into every export so a run can be attached to whatever
 * work-tracking system a team uses. apex-mutant never contacts such a system. */
export interface Traceability {
  runId: string;
  workItems: string[];
}

/** Whether the local Apex source is byte-for-byte what apex-mutant read before the
 * run. `verified: false` means the check itself could not be completed (for example
 * an in-memory project with no files on disk) — never that the source is unchanged. */
export interface SourceIntegrity {
  verified: boolean;
  unchanged: boolean;
  filesChecked: number;
  changedFiles: string[];
  message: string;
}

/** What apex-mutant can actually attest about how a run was executed. Every field is
 * evidence recorded from this process, not a claim about Salesforce's behavior. */
export interface RunSafeguards {
  /** What performed validation. A caller-supplied Validator is arbitrary code, so it
   * is recorded as such and never described as validation-only. */
  validator: string;
  /** True only when the run used an execution path apex-mutant itself constrains to
   * validation-only (`sf project deploy start --dry-run`). */
  validationOnly: boolean;
  /** Mutants are written into a temporary snapshot copy; project files are never
   * edited in place. Always true — recorded so an export carries the evidence. */
  snapshotIsolated: boolean;
  /** Result of the pre-run sandbox/scratch classification, when one was performed. */
  orgCheck: { targetOrg: string; classification: OrgClassification; message: string } | null;
  sourceIntegrity: SourceIntegrity | null;
  notes: string[];
}

export interface Report {
  schemaVersion: 2;
  tool: { name: string; version: string };
  createdAt: string;
  policy: EnforcementPolicy;
  traceability: Traceability;
  safeguards: RunSafeguards;
  baseline: ExecutionResult;
  results: MutationResult[];
  totalPlanned: number;
  complete: boolean;
}

/** 'unknown' covers every failure-closed case: no match, ambiguous evidence, a
 * subprocess/parse failure, or a timeout. It is never treated as safe to run against. */
export type OrgClassification = 'sandbox' | 'scratch' | 'production' | 'unknown';
export interface OrgClassificationResult {
  classification: OrgClassification;
  message: string;
}
export type OrgClassifier = (targetOrg: string) => Promise<OrgClassificationResult>;
