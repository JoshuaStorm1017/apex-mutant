import { spawn } from 'node:child_process';
import type { ExecutionResult, ValidationOptions } from './types.js';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const count = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Interpret only structured deployment evidence; never expose raw org output. */
export function parseSalesforceResult(stdout: string, exitCode: number | null): ExecutionResult {
  let envelope: JsonObject | undefined;
  try { envelope = object(JSON.parse(stdout)); } catch { /* Fail closed below. */ }
  const result = object(envelope?.result);
  if (!envelope || !result) return { outcome: 'error', message: 'Salesforce CLI did not return a deployment result.' };
  if (['Pending', 'Queued', 'InProgress', 'Canceling', 'FinalizingDeploy'].includes(String(result.status)) || result.done === false) {
    return { outcome: 'timeout', message: 'Validation did not finish within the CLI wait period. It may still be running in the org.' };
  }
  if (result.done !== true || !['Succeeded', 'Failed'].includes(String(result.status)) || result.checkOnly !== true) {
    return { outcome: 'error', message: 'Missing completed validation-only deployment evidence.' };
  }
  if (result.errorStatusCode || result.errorMessage) {
    return { outcome: 'error', message: 'Salesforce reported an operational deployment error.' };
  }
  const details = object(result.details);
  const componentFailures = list(details?.componentFailures);
  if (componentFailures.some(failure => !object(failure))) {
    return { outcome: 'error', message: 'Malformed component result evidence.' };
  }
  const componentErrors = componentFailures.filter(failure => object(failure)?.problemType !== 'Warning');
  const componentErrorCount = count(result.numberComponentErrors);
  const coverageOnly = componentErrors.length > 0 && componentErrors.every(failure =>
    /(?:code\s*coverage|test\s*coverage)/i.test(String(object(failure)?.problem ?? '')));
  if (coverageOnly) return { outcome: 'error', message: 'Validation failed the code coverage requirement.' };
  if (componentErrors.length || (componentErrorCount !== undefined && componentErrorCount > 0)) {
    // Metadata failures include compile errors and do not prove test sensitivity.
    return { outcome: 'invalid', message: 'Validation reported component or compilation errors.' };
  }
  if (componentErrorCount !== 0 || !details) {
    return { outcome: 'error', message: 'Missing component validation evidence.' };
  }
  const completedTests = count(result.numberTestsCompleted);
  const testErrors = count(result.numberTestErrors);
  const testResult = object(details.runTestResult);
  const failures = list(testResult?.failures);
  if (completedTests === undefined || testErrors === undefined || !testResult) {
    return { outcome: 'error', message: 'Validation did not provide evidence of executed tests.' };
  }
  const failureCount = count(testResult.numFailures);
  const runCount = count(testResult.numTestsRun);
  const testsRun = runCount ?? 0;
  if (runCount === undefined || runCount === 0 || failureCount === undefined || failures.some(failure => !object(failure))) {
    return { outcome: 'error', testsRun, message: 'Malformed or incomplete test result evidence.' };
  }
  if (completedTests + testErrors === 0 ||
      (testsRun !== completedTests + testErrors && testsRun !== completedTests) ||
      failureCount !== testErrors || failureCount > testsRun || failures.length !== failureCount) {
    return { outcome: 'error', testsRun, message: 'Inconsistent test result evidence.' };
  }
  if (result.success === true && result.status === 'Succeeded' && exitCode === 0 && envelope.status === 0 && testErrors === 0 && failureCount === 0 && failures.length === 0) {
    return { outcome: 'survived', testsRun, message: 'Validation completed and all executed tests passed.' };
  }
  const actualFailures = failures.filter(failure => {
    const entry = object(failure)!;
    return typeof entry.name === 'string' && entry.name.length > 0 &&
      typeof entry.methodName === 'string' && entry.methodName.length > 0 &&
      typeof entry.message === 'string' && entry.message.length > 0;
  });
  if (result.success === false && result.status === 'Failed' && testErrors > 0 && failureCount > 0 && actualFailures.length > 0 && exitCode !== null) {
    return { outcome: 'killed', testsRun, message: 'Completed validation reported failing Apex test methods.' };
  }
  return { outcome: 'error', testsRun, message: 'Validation failed without conclusive Apex test failures (for example, coverage or infrastructure).' };
}

/** Run sf directly, without a shell, in the caller's isolated project copy. */
export async function validateWithSalesforce(options: ValidationOptions): Promise<ExecutionResult> {
  const started = Date.now();
  const finish = (result: ExecutionResult): ExecutionResult => ({ ...result, durationMs: Date.now() - started });
  if (!options.targetOrg?.trim() || options.targetOrg.startsWith('-') ||
      !options.tests.length || options.tests.some(test => !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(test)) ||
      !options.sourceDirs.length || options.sourceDirs.some(dir => !dir.trim() || dir.startsWith('-') || dir.includes('\0')) ||
      !Number.isInteger(options.waitMinutes) || options.waitMinutes < 1 ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
    return finish({ outcome: 'error', message: 'Validation requires an explicit org, source paths, test names, and positive bounded timeout.' });
  }
  if (options.signal?.aborted) return finish({ outcome: 'error', message: 'Validation was canceled.' });
  const args = ['project', 'deploy', 'start', '--dry-run', '--test-level', 'RunSpecifiedTests',
    ...options.tests.flatMap(test => ['--tests', test]), '--target-org', options.targetOrg,
    ...options.sourceDirs.flatMap(dir => ['--source-dir', dir]), '--wait', String(options.waitMinutes), '--json'];
  return new Promise(resolve => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    const complete = (result: ExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(finish(result));
    };
    const stop = (result: ExecutionResult) => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      complete(result);
    };
    const abort = () => stop({ outcome: 'error', message: 'Validation was canceled. Remote validation may still be running.' });
    // Timer is initialized before any asynchronous child event can fire.
    const timer = setTimeout(() => stop({ outcome: 'timeout', message: 'Salesforce CLI exceeded the local timeout. Remote validation may still be running.' }), options.timeoutMs);
    try {
      child = spawn('sf', args, {
        cwd: options.projectDir, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true' },
      });
    } catch {
      complete({ outcome: 'error', message: 'Unable to start Salesforce CLI. Check installation and project directory.' });
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk: Buffer, keep: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop({ outcome: 'error', message: 'Salesforce CLI exceeded the bounded output limit.' });
      } else if (keep) stdout.push(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr!.on('data', (chunk: Buffer) => collect(chunk, false));
    child.on('error', () => complete({ outcome: 'error', message: 'Unable to run Salesforce CLI. Check installation, authentication, and project directory.' }));
    child.on('close', (code, signal) => complete(signal
      ? { outcome: 'error', message: 'Salesforce CLI terminated before validation completed.' }
      : parseSalesforceResult(Buffer.concat(stdout).toString('utf8'), code)));
  });
}
