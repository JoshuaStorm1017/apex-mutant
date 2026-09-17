# Review notes

Concise, evidence-based log per checkpoint for Codex's medium-depth review. No
Salesforce CLI or org is available or used anywhere in this log.

## Checkpoint C — CI-automated tarball smoke test, release script, GitHub prerelease

**`scripts/tarball-smoke.mjs`**: packs a real tarball (not `--dry-run`), installs it
into an isolated temp directory with an explicit minimal `package.json` (not `npm
init --prefix`, which mis-wrote this repo's own `package.json` once before — see the
"one mistake" note further down this file), and runs the *installed*
`node_modules/.bin/apex-mutant` symlink for both `--help` and `plan`. This is the exact
manual repro that caught the checkpoint-4 npm-bin symlink-guard regression, now
automated. Verified it actually catches that regression class: temporarily restored the
pre-checkpoint-4 broken `isDirectlyExecuted` guard in `src/cli.ts`, ran the script, got
`tarball-smoke: FAILED — installed bin printed no usage text. Got: ""`, then reverted
(confirmed `git diff src/cli.ts` was empty afterward — nothing committed with the
regression in it). Now a step in `.github/workflows/ci.yml`, running on every push/PR
alongside `npm run check`.

**`scripts/release.mjs`**: builds the real tarball, lists its actual contents via
`tar -tzf` and fails loudly if anything falls outside `dist/**`/`README.md`/`LICENSE`/
`package.json`, computes its SHA256, generates a CycloneDX SBOM via npm's built-in
`npm sbom --sbom-format cyclonedx --omit dev` (patched post-generation to use
`package.json`'s actual name — `npm sbom` picked up this working directory's basename,
`apex-mutant-claude-work`, for the root component's display name instead, in this
worktree environment), and derives a plain-text `LICENSES.txt` from the SBOM's own
license data. Local run's exact output:

```
tarball: apex-mutant-0.1.0-alpha.2.tgz (packed via npm pack --json)
payload inspected: 30 entries, all match dist/**, README.md, LICENSE, package.json
sha256: <computed, independently re-verified with `shasum -a 256` — matched exactly>
license inventory:
  @apexdevtools/apex-parser@5.2.0  BSD-3-Clause
  antlr4@4.13.2  BSD-3-Clause               (transitive dependency)
  apex-mutant@0.1.0-alpha.2  MIT
```

**Version**: bumped `0.1.0-alpha.1` → `0.1.0-alpha.2` via `npm version --no-git-tag-version`
(no git tag from that command itself — the release step below creates the tag). Both
`package.json` and `package-lock.json` confirmed consistent
(`grep '"version"' package-lock.json` shows `0.1.0-alpha.2` in both the root and
`packages.""` entries).

**New `.github/workflows/release.yml`** (`workflow_dispatch`, `contents: write`): runs
`npm run check` + `scripts/tarball-smoke.mjs` + a version-match check + `scripts/
release.mjs`, uploads `release/` as a workflow artifact, then `gh release create
--prerelease` attaching the tarball/checksum/SBOM/license files. Reproducible: anyone
with write access can re-run it for a future version without touching this session.

**Actual release performed this checkpoint** (not just the workflow file — the real
thing, since the task asked for "GitHub prerelease... once checks pass," not only the
automation): see the addendum below this section for the exact release URL, the
uploaded asset's SHA256 **re-verified by downloading the asset back from GitHub and
re-hashing it**, distinct from the local `npm pack --dry-run` listings earlier
checkpoints relied on for payload inspection only.

No `npm publish`, no registry account touched, no auth/security settings changed.

## Checkpoint B — doctor command, sandbox/scratch org gate, native-Windows guard

Milestone: make the tool easier to pilot/review externally (owner-requested, 4 slices).

**`apex-mutant doctor`** (`runDoctor` in `src/cli.ts`): offline by default — Node/
platform, project validity (caught, reported, never thrown), planned mutation count vs.
total Apex files always in the snapshot (explicit note that filters narrow what's
tested, not what leaves the machine), `sf` CLI presence/version. `--target-org` adds one
read-only classification check. `--json` for machine-readable output. Exit `1` iff a
real `plan`/`run` problem was found.

**Sandbox/scratch org gate** (`src/orgSafety.ts`, new): `classifyTargetOrg` runs
`sf org list auth --json` (read-only, no target-org flag on that command — lists all
authenticated orgs, matched by alias/username) and classifies via `isSandbox`/
`isScratchOrg`, the fields the Salesforce CLI itself computes and caches. Verified by
reading pinned upstream source, not assumed:
- [`@salesforce/core` `authInfo.ts` lines 303–316](https://github.com/forcedotcom/sfdx-core/blob/53d5fd01877cde3b3c0942e4e8de3d272f828b6e/src/org/authInfo.ts#L303-L316) — where `isSandbox`/`isScratchOrg`/`isDevHub` are computed onto `OrgAuthorization`.
- [`plugin-auth`'s `org list auth` command](https://github.com/salesforcecli/plugin-auth/blob/6e37e793c3b2c6b61950f2832ed76c9e9e285e6f/src/commands/org/list/auth.ts) — confirms this is the command that surfaces `OrgAuthorization[]` as JSON.
- [`plugin-org`'s `org display` command](https://github.com/salesforcecli/plugin-org/blob/5261d6169db7f7eef81dc3e9b30c13ad4aa9677e/src/commands/org/display.ts) — confirmed by reading it that `sf org display --json` does **not** carry an `isSandbox` field; deliberately not used for classification.
- [forcedotcom/cli #3560](https://github.com/forcedotcom/cli/issues/3560) — confirms `accessToken` is redacted from these commands' JSON output by default since 2026-05-27 (already in effect). This code never sets `SF_TEMP_SHOW_SECRETS` and never prints raw stdout regardless.

`assertSandboxOrScratch` is wired into `cli.ts`'s `run` before `runMutations` is ever
called (verified: a fake classifier returning `production`/`unknown` results in 0
validator calls). No override flag. Fails closed to `'unknown'` on any subprocess
failure, timeout, missing-org, auth-error, or malformed-evidence case.

**Not verified against a real org, real `sf` CLI, or real Windows machine** — this
project has none of the three. All classification tests use a fake `sf` executable on
`PATH` (`test/orgSafety.test.ts`, mirroring `test/salesforce.test.ts`'s existing
pattern); the native-Windows tests use a `withPlatform` helper that temporarily
overrides `process.platform` via `Object.defineProperty` (`test/cli.test.ts`). Labeling
this explicitly rather than implying real-environment coverage.

**Windows**: `run` now throws immediately and clearly when `process.platform ===
'win32'`, before doing anything else, instead of attempting and possibly failing
unpredictably. `plan` and `doctor` are unaffected (verified under simulated `win32`:
`plan` still succeeds, `doctor` reports the sf-check as skipped with a clear reason
rather than a false negative).

```
npm run check   # typecheck clean, 73/73 tests pass (was 60), build clean
npm run demo    # unchanged
npx tsx src/cli.ts doctor --project examples/basic   # manually smoke-tested, real output above in this session
```

**Judgment calls:**
- `checkSalesforceCli`/`classifyTargetOrg` are not independently injectable into
  `main()` the way `validate`/`classifyOrg` are — `doctor`'s own tests work around this
  by not asserting on `sf`-CLI-presence-dependent fields rather than adding a fourth DI
  parameter. If `doctor` grows more sf-CLI-dependent checks, revisit this.
- The org classification is the CLI's *locally cached* auth-file metadata (populated at
  `sf org login` time), not a live API query — this is what the CLI's own other plugins
  rely on for the same purpose (see citations above), and keeps the check cheap and
  read-only, but means a very recently re-classified org (rare) could show stale data
  until re-authenticated.

## Checkpoint A — runner API-boundary fixes

Responds to a Codex review that found two reproduced gaps in `runMutations` (the
public library function, separate from the CLI) plus two smaller hardening items.

**Reproduced before fixing** (exact scripts, run via `tsx`, then deleted):

1. `runMutations(project, mutations, { output: '<root>/force-app', ... }, fakeValidator)`
   wrote `report.json`/`report.html` inside `force-app` (a package directory) — the
   `--output` guard existed only in `cli.ts`, not in the library entry point.
2. `runMutations` with a validator returning `{ outcome: 'survived', testsRun: 1 }` for
   the baseline then `{ outcome: 'survived', testsRun: 0 }` for the one mutant produced
   `report.complete === true` and `reportExitCode(report) === 0` — a mutant that ran
   zero tests was accepted as a real "survived" result.

**Fixed:**

- `report.ts`: new `assertOutputOutsidePackageDirs(root, packageDirs, output)`, the
  same canonical-path check from checkpoint 4, now shared by `cli.ts` and `runner.ts`
  instead of living only in `cli.ts`. `writeFileAtomic` wraps its `rename()` in
  try/catch and removes the temp file before rethrowing on failure.
- `runner.ts`: calls the shared check before `snapshotProject()` — rejects before any
  snapshot is created or the validator is ever invoked. New `sanitizeResult()` wraps
  every validator call (baseline and each mutant): outcome must be one of the five
  known values; `survived`/`killed` require `Number.isInteger(testsRun) && testsRun > 0`;
  anything else is downgraded to `{ outcome: 'error', message: '...' }`.
- `project.ts`: `assertSafeRelativePath` now splits on `/[/\\]/` (was `/` only) and
  rejects an `[A-Za-z]:` drive-letter prefix, so it rejects backslash-based traversal
  independent of which OS the check itself runs on.

**Re-verified fixed** with the same two repro scripts: gap 1 now throws
`Output directory must be outside package directories.` before the validator is called
(0 calls recorded); gap 2 now produces `report.results[0].outcome === 'error'` and
`report.complete === false` from the same input sequence.

**New tests** (7): `test/project.test.ts` (`assertSafeRelativePath` OS-independent
traversal, 1), `test/report.test.ts` (`assertOutputOutsidePackageDirs` direct/nested/
symlinked-ancestor/safe cases, `writeFileAtomic` temp-file-cleanup-on-rename-failure,
2), `test/runner.test.ts` (unsafe-output rejected before snapshot/validator/fixture
touched, the exact reported `testsRun: 0` scenario, a matrix of undefined/NaN/negative/
non-integer `testsRun` and unknown/missing/`null`/`undefined` results, a valid-contract
pass-through check, 4).

```
npm run check   # typecheck clean, 60/60 tests pass (was 53), build clean
npm run demo    # unchanged: 5 mutants against examples/basic
```

## Known limits, unchanged

No live Salesforce org or CLI used anywhere. Windows `run` support undetermined
(slice B). Coverage-scoped selection and mutation grouping not implemented (need a
live org; see `docs/COMPARISON.md`).

## Judgment calls

- Scope stayed to the two reported gaps plus the two smaller hardening items in the
  same review; no broader audit of every filesystem/validator touchpoint was attempted.
- `sanitizeResult` requires `testsRun > 0` (not `>= 0`) for `survived`/`killed`, matching
  the runner's pre-existing baseline gate (`testsRun! > 0`) rather than inventing a new
  threshold.
