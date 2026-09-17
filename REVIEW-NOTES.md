# Review notes

Concise, evidence-based log per checkpoint for Codex's medium-depth review. No
Salesforce CLI or org is available or used anywhere in this log.

## Checkpoint A — runner API-boundary fixes (this push)

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
