import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyMutation } from './mutations.js';
import { snapshotProject, type Project } from './project.js';
import { writeReport } from './report.js';
import type { Mutation, Report, ValidationOptions, Validator, ExecutionResult } from './types.js';

export interface RunOptions {
  targetOrg: string;
  tests: string[];
  waitMinutes: number;
  timeoutMs: number;
  output: string;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number, result: ExecutionResult) => void;
}

export async function runMutations(project: Project, mutations: Mutation[], options: RunOptions, validate: Validator): Promise<Report> {
  if (!options.targetOrg.trim() || !options.tests.length || options.tests.some((t) => !t.trim())) throw new Error('An explicit target org and test class names are required.');
  if (!mutations.length) throw new Error('No mutations selected. Try different source paths or operators.');
  if (!(options.waitMinutes >= 1) || !(options.timeoutMs >= 1)) throw new Error('Wait and timeout must be positive.');
  const snapshot = await snapshotProject(project);
  const report: Report = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    baseline: { outcome: 'error', message: 'Baseline has not completed.' },
    results: [], totalPlanned: mutations.length, complete: false,
  };
  const validation: ValidationOptions = {
    projectDir: snapshot.directory, sourceDirs: project.packageDirs,
    targetOrg: options.targetOrg, tests: options.tests,
    waitMinutes: options.waitMinutes, timeoutMs: options.timeoutMs, signal: options.signal,
  };
  async function execute(): Promise<ExecutionResult> {
    try { return await validate(validation); }
    catch { return { outcome: 'error', message: 'Validator failed unexpectedly. Check local Salesforce CLI configuration.' }; }
  }
  try {
    await writeReport(options.output, report);
    if (options.signal?.aborted) return report;
    report.baseline = await execute();
    await writeReport(options.output, report);
    if (report.baseline.outcome !== 'survived' || !(report.baseline.testsRun! > 0)) return report;
    for (const mutation of mutations) {
      if (options.signal?.aborted) break;
      const source = project.files.get(mutation.file);
      if (source === undefined) throw new Error('Mutation references a file outside the project snapshot.');
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
    await writeReport(options.output, report);
    return report;
  } finally { await snapshot.cleanup(); }
}
