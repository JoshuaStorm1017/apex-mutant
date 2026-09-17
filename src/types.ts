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
export interface Report {
  schemaVersion: 1;
  createdAt: string;
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
