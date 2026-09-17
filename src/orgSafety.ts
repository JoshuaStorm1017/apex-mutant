import { spawn } from 'node:child_process';
import type { OrgClassificationResult } from './types.js';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Classify the authenticated-org evidence from a parsed `sf org list auth --json`
 * response. That command's `OrgAuthorization[]` result carries `isSandbox` and
 * `isScratchOrg` booleans computed by the Salesforce CLI itself from cached auth-file
 * metadata (`@salesforce/core`'s `AuthInfo.listAllAuthorizations`, pinned source:
 * https://github.com/forcedotcom/sfdx-core/blob/53d5fd01877cde3b3c0942e4e8de3d272f828b6e/src/org/authInfo.ts#L303-L316
 * — the same fields `sf`'s own `plugin-auth` checks before letting a logout proceed).
 * There is no such field on `sf org display`'s output; that command was deliberately
 * not used here. Fails closed to 'unknown' whenever the evidence is anything less
 * than an explicit true/false pair. */
export function classifyFromAuthList(stdout: string, targetOrg: string): OrgClassificationResult {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { classification: 'unknown', message: 'Could not parse the authenticated-org list as JSON.' }; }
  const envelope = object(parsed);
  const list = envelope?.result;
  if (!Array.isArray(list)) return { classification: 'unknown', message: 'Unexpected shape from `sf org list auth --json`.' };
  const entry = list
    .map(object)
    .find((candidate) => candidate && (candidate.alias === targetOrg || candidate.username === targetOrg));
  if (!entry) return { classification: 'unknown', message: `'${targetOrg}' was not found in \`sf org list auth\`. Authenticate it first.` };
  if (entry.error) return { classification: 'unknown', message: `'${targetOrg}' has an authentication error.` };
  if (typeof entry.isSandbox !== 'boolean' || typeof entry.isScratchOrg !== 'boolean') {
    return { classification: 'unknown', message: `'${targetOrg}' is missing org-type evidence (isSandbox/isScratchOrg) from the Salesforce CLI.` };
  }
  if (entry.isScratchOrg) return { classification: 'scratch', message: `'${targetOrg}' is a scratch org.` };
  if (entry.isSandbox) return { classification: 'sandbox', message: `'${targetOrg}' is a sandbox.` };
  return { classification: 'production', message: `'${targetOrg}' is classified as production: neither isSandbox nor isScratchOrg is true.` };
}

/** Read-only: `sf org list auth` only reads already-authenticated orgs from local
 * config, it never queries or changes the org itself. As of the Salesforce CLI's
 * 2026-05-27 credential-redaction change, `accessToken` is redacted from this
 * command's output by default; this function never prints raw stdout regardless, and
 * never sets SF_TEMP_SHOW_SECRETS. Fails closed to 'unknown' on any subprocess
 * failure, timeout, or malformed output — an inconclusive check is never treated as
 * a safe org to run against.
 *
 * NOT verified against a real Salesforce CLI or org: this repository has neither.
 * Verified only against injected fake-subprocess fixtures (see test/orgSafety.test.ts). */
export async function classifyTargetOrg(targetOrg: string): Promise<OrgClassificationResult> {
  if (!targetOrg?.trim()) return { classification: 'unknown', message: 'No target org specified.' };
  return new Promise((resolve) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    const complete = (result: OrgClassificationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (result: OrgClassificationResult) => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      complete(result);
    };
    const timer = setTimeout(() => stop({ classification: 'unknown', message: 'Timed out listing authenticated orgs.' }), TIMEOUT_MS);
    try {
      child = spawn('sf', ['org', 'list', 'auth', '--json'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true' },
      });
    } catch {
      complete({ classification: 'unknown', message: 'Unable to start the Salesforce CLI to check org type.' });
      return;
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) stop({ classification: 'unknown', message: 'Salesforce CLI exceeded the bounded output limit.' });
      else stdout.push(chunk);
    });
    child.on('error', () => complete({ classification: 'unknown', message: 'Unable to run the Salesforce CLI to check org type.' }));
    child.on('close', (code, signal) => complete(signal
      ? { classification: 'unknown', message: 'Salesforce CLI terminated before the org-type check completed.' }
      : classifyFromAuthList(Buffer.concat(stdout).toString('utf8'), targetOrg)));
  });
}

/** The genuine guard: called before any mutant source is ever sent to `targetOrg`.
 * No override flag exists and none should be added — see AGENTS.md's
 * "never add a deploy/quick-deploy fallback" in spirit: this is the equivalent
 * boundary for "never silently run against production." */
export function assertSandboxOrScratch(result: OrgClassificationResult, targetOrg: string): void {
  if (result.classification !== 'sandbox' && result.classification !== 'scratch') {
    throw new Error(`Refusing to run against '${targetOrg}': ${result.message} apex-mutant only runs against a sandbox or scratch org, with no override — see README's "Quickstart: run" prerequisites.`);
  }
}
