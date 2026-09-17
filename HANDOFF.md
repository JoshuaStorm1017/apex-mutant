# Claude / next-agent handoff

## Current state

Public open-source Apex mutation testing CLI, MIT license, alpha. Owner has delegated
ongoing build work to Claude; Codex does medium-depth review of pushed checkpoints, no
concurrent edits. No Salesforce CLI or org exists on this development host — **live-org
acceptance is still NOT verified**, and every claim below that could plausibly need a
real org is instead verified with an injected fake `Validator` or a real local
subprocess shaped like `sf` (`test/salesforce.test.ts`'s fake-executable pattern).

`npm run check`: typecheck + **73** tests + build, all passing. `npm run demo` yields 5
mutants against `examples/basic`, unchanged. Engine has 8 mutation operators (see
README's operator table). See `docs/COMPARISON.md` for the evaluation against
`scolladon/apex-mutation-testing` and `REVIEW-NOTES.md` for exact self-validation
commands/results at each checkpoint.

## In progress: making the tool easier to pilot and review externally

Owner's current milestone (four slices, being built in order, each self-validated and
pushed separately):

- **A — done, this push.** Fixed two API-boundary gaps a Codex review found and I
  independently reproduced in `runMutations` (the public library entry point, as
  distinct from the CLI): (1) the `--output`-outside-package-directories guard existed
  only in `cli.ts`, so calling `runMutations` directly with an unsafe `output` wrote
  report files into a package directory; (2) a custom `Validator`'s result was trusted
  without checking its shape, so e.g. `{ outcome: 'survived', testsRun: 0 }` for a
  mutant was silently accepted as real evidence — reproduced exactly:
  `complete: true`, `reportExitCode: 0` from a mutant that ran zero tests. Also fixed,
  same review: `assertSafeRelativePath` only checked `/`-separated segments, so a
  `\`-based traversal string wasn't caught independent of host OS; and
  `writeFileAtomic` could leave an orphaned temp file behind if the final `rename`
  failed. Fixes:
  - `report.ts`: new `assertOutputOutsidePackageDirs(root, packageDirs, output)`,
    shared by `cli.ts` and `runner.ts` (previously duplicated/missing). `writeFileAtomic`
    now cleans up its temp file in a catch-and-rethrow if `rename` fails.
  - `runner.ts`: calls `assertOutputOutsidePackageDirs` before creating any snapshot or
    invoking the validator; added `sanitizeResult()`, applied to every validator call
    (baseline and every mutant) — an unrecognized `outcome`, or a `survived`/`killed`
    claim without a finite positive integer `testsRun`, is downgraded to `error` rather
    than trusted.
  - `project.ts`: `assertSafeRelativePath` now splits on `[/\\]` and rejects a
    drive-letter prefix, independent of the host OS.
  - Tests: 7 new (`test/project.test.ts`, `test/report.test.ts`, `test/runner.test.ts`)
    covering direct/nested-nonexistent/symlinked-ancestor/safe output paths, the exact
    reported `testsRun: 0` scenario, undefined/NaN/negative/non-integer `testsRun`,
    unknown/missing outcome, `null`/`undefined` results, and the temp-file-cleanup path.
- **B — done, this push.** `apex-mutant doctor` command (`src/cli.ts`'s `runDoctor`):
  fully offline by default — Node/platform, project validity (caught and reported, not
  thrown), planned mutation count vs. total Apex files in the snapshot (with an explicit
  note that `--include`/`--exclude` only narrow what's *tested*, not what leaves the
  machine), and `sf` CLI presence/version. `--target-org` adds one read-only check.
  New `src/orgSafety.ts`: `classifyTargetOrg` runs `sf org list auth --json` (read-only)
  and classifies via the CLI's own cached `isSandbox`/`isScratchOrg` fields — the actual
  fields other official `sf` plugins use for this, pinned source citations in the file's
  doc comment (`sf org display` does **not** carry this field; deliberately not used).
  `assertSandboxOrScratch` is the genuine guard: wired into `cli.ts`'s `run` before
  `runMutations` is ever called, no override flag. Fails closed to `'unknown'` on any
  subprocess failure, timeout, missing org, auth error, or malformed evidence.
  Windows: `run` now fails immediately and clearly on `process.platform === 'win32'`
  (Node can't safely spawn the `sf.cmd` shim with `shell:false`) rather than attempting
  and failing unpredictably; `plan` and `doctor` are unaffected (no subprocess needed for
  their offline checks). 27 new tests (`test/orgSafety.test.ts` — fake-`sf`-on-PATH
  classification incl. production/sandbox/scratch/missing/malformed/auth-error; `doctor`
  and org-gate/native-Windows integration tests in `test/cli.test.ts`, the latter via a
  `withPlatform` test helper that overrides `process.platform`, since no Windows runner
  exists here either). **None of this has been exercised against a real Salesforce CLI,
  org, or Windows machine** — every claim is fake-subprocess or simulated-platform only.
- **C — done, this push.** `scripts/tarball-smoke.mjs`: packs a real tarball, installs
  it into an isolated directory the way a user would, and runs the *installed*
  `node_modules/.bin` symlink (not `tsx src/cli.ts`, which can't see that class of bug).
  Verified it actually catches the checkpoint-4 regression class by temporarily
  reintroducing the broken `isDirectlyExecuted` guard, confirming the script fails with
  "installed bin printed no usage text," then reverting (no net diff). Now wired into
  `.github/workflows/ci.yml` on every push/PR. `scripts/release.mjs`: builds the real
  tarball, inspects its actual payload against an allowlist (fails loudly on anything
  outside `dist/**`/`README.md`/`LICENSE`/`package.json`), computes SHA256, generates a
  CycloneDX SBOM via npm's built-in `npm sbom` (patched to use the correct package name —
  it picked up the working-directory basename instead in this environment), and derives
  a plain-text `LICENSES.txt` from it. New `.github/workflows/release.yml`
  (`workflow_dispatch`) runs the same script and attaches its output to a GitHub
  prerelease. Version bumped to `0.1.0-alpha.2` (`package.json` + `package-lock.json`,
  via `npm version --no-git-tag-version`, both consistent). See `REVIEW-NOTES.md` for
  the actual release evidence (checksums, and confirmation the uploaded release asset's
  hash matches what was built locally — not just a `--dry-run` listing). No `npm publish`,
  no registry account changes.
- **D — last.** `docs/TECHNICAL-REVIEW.md`: a generic, committee-ready brief (not tied to
  any named employer/company) covering architecture/data flow, permissions, dependencies,
  install/uninstall, platform support, and an acceptance matrix distinguishing what's
  verified offline from what's pending an authorized sandbox pilot. Also corrects
  remaining absolute "never edits project files" wording in `SECURITY.md`.

## Known limitations (unchanged)

- No live Salesforce org or CLI has ever been used to verify anything in this
  repository. Every "verified" claim is injected-validator or fake-subprocess-based.
- The sandbox/scratch org gate (`orgSafety.ts`) and the native-Windows early error are
  both untested against the real thing (real `sf`, real org, real Windows). If a real
  org's `sf org list auth --json` output ever differs from what's assumed, `run` fails
  closed to `'unknown'` (refuses), never open.
- Coverage-scoped test selection and mutation grouping are not implemented; both are
  compatible with validation-only in principle but need a live org to build and verify
  (see `docs/COMPARISON.md`).

## Delivery ledger

Product outcome: a developer can identify surviving Apex mutants without changing
source or deploying org metadata.
Architecture: Node/TypeScript, parser-aware mutation generation, validation-only
sequential execution.
Review/testing history: engine/adapter (checkpoint 2) → root-module + CLI integration
tests (checkpoint 3) → Codex-found output-path symlink fix + doc corrections
(checkpoint 4) → Codex-found runner API-boundary fixes (slice A) → doctor command +
sandbox/scratch org gate + native-Windows guard (slice B) → CI-automated tarball smoke
test + versioned GitHub prerelease (slice C, this checkpoint), in progress toward an
external-pilot-ready milestone. 73 tests total, all offline/injected or
platform-simulated — no Salesforce CLI, org, or Windows machine has ever been used in
this repository's verification.
