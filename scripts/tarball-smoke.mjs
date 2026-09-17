#!/usr/bin/env node
// Automates the exact manual repro that caught the npm-bin symlink-guard regression
// (see HANDOFF.md/REVIEW-NOTES.md, checkpoint 4): pack a real tarball, install it into
// an isolated directory the way an actual user would, and run the *installed*
// node_modules/.bin symlink — not `tsx src/cli.ts`, which cannot see that class of bug.
// Runs in CI on every push (.github/workflows/ci.yml) so this is never manual-only again.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'apex-mutant-tarball-smoke-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function fail(message) {
  console.error(`tarball-smoke: FAILED — ${message}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

try {
  console.log(`Working directory: ${work}`);
  run('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const packOutput = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], { cwd: root }));
  const tarball = join(work, packOutput[0].filename);
  console.log(`Packed: ${packOutput[0].filename}`);

  const installDir = join(work, 'install');
  mkdirSync(installDir, { recursive: true });
  // A minimal, explicit package.json — deliberately not `npm init`, which has been
  // observed to write to the *caller's* package.json instead of --prefix's target
  // in this environment (see REVIEW-NOTES.md's "one mistake made and corrected").
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'apex-mutant-smoke-test', version: '0.0.0', private: true }, null, 2));
  run('npm', ['install', '--prefix', installDir, tarball], { cwd: root });

  const bin = join(installDir, 'node_modules', '.bin', 'apex-mutant');
  const help = run(bin, ['--help']);
  if (!help.includes('Usage:')) fail(`installed bin printed no usage text. Got: ${JSON.stringify(help.slice(0, 200))}`);
  console.log('Installed bin --help: OK');

  const fixture = join(work, 'fixture');
  cpSync(join(root, 'examples', 'basic'), fixture, { recursive: true });
  const planOutput = run(bin, ['plan', '--project', fixture]);
  const match = /Apex Mutant · (\d+) mutations planned/.exec(planOutput);
  if (!match || Number(match[1]) < 1) fail(`installed bin's plan command did not report a positive mutation count. Got: ${JSON.stringify(planOutput.slice(0, 300))}`);
  console.log(`Installed bin plan: OK (${match[1]} mutations planned against examples/basic)`);

  console.log('tarball-smoke: PASSED');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
