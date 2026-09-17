# Claude / next-agent handoff

## Current state

Public open-source Apex mutation testing CLI, MIT license, alpha. Owner has delegated
ongoing build work to Claude; Codex does medium-depth review of pushed checkpoints, no
concurrent edits. No Salesforce CLI or org exists on this development host — **live-org
acceptance is still NOT verified**, and every claim below that could plausibly need a
real org is instead verified with an injected fake `Validator` or a real local
subprocess shaped like `sf` (`test/salesforce.test.ts`'s fake-executable pattern).

`npm run check`: typecheck + **60** tests + build, all passing. `npm run demo` yields 5
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
- **B — next.** `apex-mutant doctor` command (offline by default: Node/platform, project
  validity, `sf` CLI presence/version, planned scope; optional `--target-org` read-only
  checks). A genuine pre-`run` guard that rejects a non-sandbox/scratch org classification
  (no silent fallback). Windows: either a real native launcher or an explicit early error
  pointing at WSL/macOS/Linux.
- **C — after B.** CI-automated tarball install/bin smoke test (so the checkpoint-4
  symlink-guard class of bug is caught automatically, not only by a manual repro).
  Release artifact (`.tgz` + SHA256 + dependency/license inventory) attached to a GitHub
  prerelease at `0.1.0-alpha.2`. No `npm publish`.
- **D — last.** `docs/TECHNICAL-REVIEW.md`: a generic, committee-ready brief (not tied to
  any named employer/company) covering architecture/data flow, permissions, dependencies,
  install/uninstall, platform support, and an acceptance matrix distinguishing what's
  verified offline from what's pending an authorized sandbox pilot. Also corrects
  remaining absolute "never edits project files" wording in `SECURITY.md`.

## Known limitations (unchanged)

- No live Salesforce org or CLI has ever been used to verify anything in this
  repository. Every "verified" claim is injected-validator or fake-subprocess-based.
- Windows support for `run` is undetermined (see README; being addressed in slice B).
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
(checkpoint 4) → Codex-found runner API-boundary fixes, in progress toward an
external-pilot-ready milestone (this checkpoint). 60 tests total, all offline/injected —
no Salesforce CLI or org has ever been used in this repository's verification.
