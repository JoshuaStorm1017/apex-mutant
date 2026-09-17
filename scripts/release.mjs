#!/usr/bin/env node
// Minimal, reproducible release-artifact builder. Produces exactly what a GitHub
// prerelease should attach: the real npm tarball (not a --dry-run listing), its
// SHA256, a CycloneDX SBOM, and a plain-text license inventory derived from it —
// then inspects the tarball's actual payload and fails loudly if anything beyond
// the expected dist/README/LICENSE/package.json set is present.
//
// Never publishes to the npm registry and never touches git tags/releases itself;
// see .github/workflows/release.yml (CI) or run this locally, then hand the
// contents of release/ to `gh release create` yourself or via that workflow.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const outDir = join(root, 'release');

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' });
}

function fail(message) {
  console.error(`release script: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
console.log(`Building release artifacts for ${pkg.name}@${pkg.version}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. The real tarball (not --dry-run: this actually writes the file npm would publish).
run('npm', ['run', 'build']);
const packOutput = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', outDir]));
if (!Array.isArray(packOutput) || packOutput.length !== 1) fail('unexpected `npm pack --json` output shape.');
const tarball = packOutput[0];
const tarballPath = join(outDir, tarball.filename);
console.log(`  tarball: ${tarball.filename} (${tarball.size} bytes packed, ${tarball.unpackedSize} unpacked)`);

// 2. Inspect the actual payload before trusting it. Every entry must be one of the
//    expected published paths — this is the guard that would catch, e.g., a stray
//    .env or test/ directory ending up in a real publish.
const listing = run('tar', ['-tzf', tarballPath]).trim().split('\n').map((l) => l.replace(/^package\//, ''));
const allowed = /^(dist\/.*|README\.md|LICENSE|package\.json)$/;
const unexpected = listing.filter((entry) => entry && !allowed.test(entry));
if (unexpected.length) fail(`unexpected file(s) in the published tarball, refusing to release: ${unexpected.join(', ')}`);
console.log(`  payload inspected: ${listing.length} entries, all match dist/**, README.md, LICENSE, package.json`);

// 3. SHA256 of the exact bytes that would be uploaded/installed.
const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
writeFileSync(join(outDir, 'SHA256SUMS'), `${sha256}  ${tarball.filename}\n`);
console.log(`  sha256: ${sha256}`);

// 4. SBOM (CycloneDX, production dependencies only — this is what ships).
//    npm sbom's root component name can pick up the working-directory basename
//    instead of package.json's name in some environments (e.g. a linked git
//    worktree); patched here so the artifact is correct regardless.
const sbom = JSON.parse(run('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev']));
if (sbom.metadata?.component) {
  sbom.metadata.component.name = pkg.name;
  sbom.metadata.component['bom-ref'] = `${pkg.name}@${pkg.version}`;
}
writeFileSync(join(outDir, 'sbom.cyclonedx.json'), JSON.stringify(sbom, null, 2) + '\n');

// 5. A short, human-readable license inventory derived from the same SBOM data,
//    so a reviewer doesn't have to parse CycloneDX JSON by hand.
const components = [sbom.metadata.component, ...(sbom.components ?? [])];
const licenseLines = components
  .map((c) => {
    const licenses = (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression ?? 'UNKNOWN').join(', ');
    return `${c.name}@${c.version}  ${licenses || 'UNKNOWN'}`;
  })
  .sort();
writeFileSync(join(outDir, 'LICENSES.txt'), licenseLines.join('\n') + '\n');
console.log(`  license inventory: ${licenseLines.length} package(s), see release/LICENSES.txt`);
for (const line of licenseLines) console.log(`    ${line}`);

console.log(`\nDone. Artifacts in ${outDir}/: ${tarball.filename}, SHA256SUMS, sbom.cyclonedx.json, LICENSES.txt`);
