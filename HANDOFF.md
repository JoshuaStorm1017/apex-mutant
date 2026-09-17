# Claude / next-agent handoff

## Current state

Public open-source Apex mutation testing CLI, MIT license, alpha, version
`0.1.0-alpha.2` ([released](https://github.com/JoshuaStorm1017/apex-mutant/releases/tag/v0.1.0-alpha.2),
prerelease, not published to the npm registry). Owner has delegated ongoing build work
to Claude; Codex does medium-depth review of pushed checkpoints, no concurrent edits.

No Salesforce CLI or org exists on this development host — **live-org acceptance is
still NOT verified.** Every claim in this repository that could plausibly need a real
org is instead verified with an injected fake `Validator`/`OrgClassifier` or a real
local subprocess shaped like `sf` (`test/salesforce.test.ts`'s fake-executable pattern).
No real Windows machine exists either — native-Windows behavior is verified by
simulating `process.platform` in tests, not by running on Windows.

`npm run check`: typecheck + **73** tests + build, all passing. `npm run demo` yields 5
mutants against `examples/basic`. CI runs `npm run check`, `npm run demo`, and a real
tarball-install-and-run smoke test (`scripts/tarball-smoke.mjs`) on every push.

Key docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module contract),
[docs/COMPARISON.md](docs/COMPARISON.md) (evaluation against
`scolladon/apex-mutation-testing`), [docs/TECHNICAL-REVIEW.md](docs/TECHNICAL-REVIEW.md)
(committee-ready brief with an acceptance matrix and a runnable synthetic pilot recipe),
[REVIEW-NOTES.md](REVIEW-NOTES.md) (per-checkpoint self-validation evidence).

## Milestone just completed: easier to pilot and review externally

Four slices, all done and pushed (full evidence in `REVIEW-NOTES.md`; summarized here):

- **Runner API-boundary fixes**: `runMutations` (the library entry point, not just the
  CLI) now enforces the `--output`-outside-package-directories guard
  (`assertOutputOutsidePackageDirs`, shared with `cli.ts`) and sanitizes every
  `Validator` result (`sanitizeResult`) — an unrecognized outcome, or a
  `survived`/`killed` claim without a real positive `testsRun`, is downgraded to
  `error` rather than trusted. `assertSafeRelativePath` rejects backslash-based
  traversal independent of host OS. `writeFileAtomic` cleans up its temp file if the
  final rename fails.
- **`apex-mutant doctor`** command (offline by default: Node/platform, project
  validity, planned mutation count vs. total Apex files always in the snapshot,
  `sf` CLI presence). **Sandbox/scratch org gate** (`src/orgSafety.ts`): `run` refuses
  to send any mutant source to `--target-org` unless `sf org list auth --json`
  classifies it as a sandbox or scratch org — no override flag, fails closed to
  `'unknown'` on any ambiguity. **Native Windows** gets an early, clear error for `run`
  instead of an unpredictable failure; `plan`/`doctor` are unaffected.
- **Distribution**: `scripts/tarball-smoke.mjs` (real pack + install + installed-bin
  run, now in CI on every push — verified it actually catches the checkpoint-4
  npm-symlink-guard regression class) and `scripts/release.mjs` (real tarball, payload
  allowlist check, SHA256, CycloneDX SBOM, license inventory). Version bumped to
  `0.1.0-alpha.2` and released as a GitHub prerelease — the uploaded asset was
  downloaded back and re-hashed to confirm it matches the local build.
- **`docs/TECHNICAL-REVIEW.md`** and a `SECURITY.md` correction (the "never edits
  project files" claim was too absolute given output artifacts intentionally live
  inside the project — reworded to state precisely what's guaranteed).

**One incident disclosed** (see `REVIEW-NOTES.md`'s checkpoint C for the full account):
a shell-quoting mistake caused an accidental `npm publish` attempt during this
milestone. It failed closed on its own (no registry auth configured, plus npm's own
prerelease-tag requirement); confirmed via `npm view apex-mutant` → `404 Not Found`.
Nothing was published.

## Known limitations

- No live Salesforce org, real `sf` CLI, or real Windows machine has ever been used to
  verify anything in this repository. Every such claim is injected-validator,
  fake-subprocess, or simulated-platform based — see the acceptance matrix in
  `docs/TECHNICAL-REVIEW.md` for exactly which claims that applies to.
- Coverage-scoped test selection and mutation grouping are not implemented; both are
  compatible with validation-only in principle but need a live org to build and verify
  (see `docs/COMPARISON.md`).

## Next priorities

1. **An authorized sandbox/scratch org pilot** — the single highest-value next step.
   `docs/TECHNICAL-REVIEW.md`'s "Synthetic pilot recipe" is ready to run as-is against
   `examples/basic`; update that doc's acceptance matrix and this file with the actual
   result (pass or fail, exact `sf` CLI version) once someone does it.
2. **Real Windows verification** (or a real WSL run) of `plan`, `doctor`, and the
   native-Windows early-error path for `run`.
3. Per `docs/COMPARISON.md`: coverage-scoped test selection and mutation grouping,
   once org access exists to build and verify them against.
4. Consider filing the interruption-safety observation about
   `scolladon/apex-mutation-testing` (no `SIGINT`/`SIGTERM` handler found around its org
   rollback, via static analysis only) upstream — after confirming it against a live
   interrupted run first, per `docs/COMPARISON.md`'s own caveat.

## Delivery ledger

Product outcome: a developer can identify surviving Apex mutants without changing
source or deploying org metadata.
Architecture: Node/TypeScript, parser-aware mutation generation, validation-only
sequential execution.
Review/testing history: engine/adapter → root-module + CLI integration tests →
Codex-found output-path symlink fix + doc corrections → Codex-found runner
API-boundary fixes → doctor/org-gate/Windows-guard → CI-automated tarball smoke test +
versioned GitHub prerelease → technical-review brief (this checkpoint). 73 tests total,
all offline/injected or platform-simulated — no Salesforce CLI, org, or Windows machine
has ever been used in this repository's verification.
