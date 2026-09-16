# Claude / next-agent handoff

## Checkpoint 3: full integration test suite, CLI symlink fix, comparison, docs

Public open-source Apex mutation testing CLI, MIT license. Owner delegated the
remaining integration, verification, comparison, and documentation work to Claude to
conserve Codex credits; Codex reviews completed work only. This checkpoint covers the
Claude work order from checkpoint 2 in full, plus an owner-requested comparison against
`scolladon/apex-mutation-testing`. See [docs/COMPARISON.md](docs/COMPARISON.md) and
[REVIEW-NOTES.md](REVIEW-NOTES.md) for that comparison's evidence and the exact
self-validation run for this checkpoint.

No Salesforce CLI or org exists on this development host; **live-org acceptance is
still NOT verified.** Every claim below that could plausibly need a real org has been
verified instead with an injected fake `Validator` or a real local subprocess shaped
like `sf` (see `test/salesforce.test.ts`'s fake-executable pattern) — never a real
Salesforce CLI or org.

## Verified now

- `npm run check`: typecheck, **49** tests (parser engine, Salesforce result
  classification/subprocess, project discovery/snapshotting, runner baseline/abort/
  cleanup semantics, report scoring/exit-codes/HTML-escaping, and full CLI behavior),
  and build all pass. Offline `npm run demo` still yields 5 mutants against
  `examples/basic`, unchanged by the new operators (that fixture doesn't happen to
  contain increment/decrement or unary-minus patterns).
- **Engine**: 8 operators now — the original 6 (`conditional-boundary`,
  `equality-negation`, `logical-connector`, `boolean-literal`, `negation-removal`,
  `arithmetic`) plus two added this checkpoint (`increment-decrement`,
  `unary-negation-removal`), added because the `scolladon/apex-mutation-testing`
  comparison (below) showed a large operator-count gap and these two fit the existing
  single-token AST-visitor pattern with zero execution/safety-model changes. Still
  excludes strings/comments/annotations/queries/test code, per architecture contract.
- **Root modules reviewed and tested** (`project.ts`, `runner.ts`, `report.ts`,
  `cli.ts`) — this was the main item left open at checkpoint 2:
  - `test/project.test.ts` (9 tests): Apex discovery incl. multi-package-dir projects
    with no Apex at all, missing-meta-companion rejection, missing/empty/overlapping/
    escaping `packageDirectories` rejection, symlinked package-dir ancestor and
    symlinked-file rejection, deterministic include/exclude/operator/`maxMutants`
    filtering, and snapshot config allowlisting.
  - `test/runner.test.ts` (8 tests): input validation, baseline-gates-mutants,
    zero-executed-tests-is-not-a-pass, **no leakage between mutants or files** (each
    mutant is validated against a clean copy; proven by reading the snapshot disk state
    from inside the injected validator), error/timeout stopping the loop early, abort
    before and during a run, and an unexpectedly-throwing validator still producing a
    classified `error` result rather than crashing the run.
  - `test/report.test.ts` (7 tests): score/denominator math, HTML-escaping of
    attacker-controlled mutation content in every field (file/original/replacement/
    message/outcome), atomic incremental writes (temp file + rename, no leftover
    `.tmp`), and the full `reportExitCode` matrix (incomplete/baseline-failed/
    unresolved-error-or-timeout/no-score → 2; below threshold → 1; met threshold → 0).
  - `test/cli.test.ts` (11 tests): help/usage, `plan` (text/JSON/no-matches-exits-2),
    `--output` escaping into a package directory rejected, numeric-option validation,
    `run`'s required-flags validation, `run` end-to-end with an injected validator
    (score/threshold/exit-code correctness), and **`run` against the real
    `validateWithSalesforce` with `sf` removed from `PATH`** — proving the
    missing-Salesforce-CLI path fails closed (exit 2, baseline `error`, zero mutant
    results) without ever touching a real org.
- **Bugs found and fixed**:
  1. `project.ts`/`runner.ts`: added `assertSafeRelativePath` as defense-in-depth
     against a hand-built `Project` (a public exported type) carrying a file key that
     could escape the snapshot directory via `..` segments. Not reachable through the
     CLI today (`readProject` only ever produces safe keys), but `Project` is public
     API surface, so this is a real, if currently latent, safety gap for library
     consumers. Covered by `test/project.test.ts`'s "rejects file keys that would
     escape the snapshot directory."
  2. `cli.ts`: **the installed npm bin was completely non-functional.** The original
     direct-execution guard compared `import.meta.url === pathToFileURL(process.argv[1]).href`.
     `node_modules/.bin/apex-mutant` is a symlink to `dist/cli.js`; Node resolves
     `import.meta.url` to the symlink's real target, while `process.argv[1]` stays the
     symlink path as invoked — so the string comparison always failed and `main()`
     never ran when installed via npm. Verified broken with a real `npm pack` +
     install into an isolated temp directory (`apex-mutant --help` printed nothing).
     Fixed by comparing `realpath(process.argv[1])` against `realpath(this module)`
     instead of raw URLs. Re-verified fixed the same way, twice — once right after the
     fix, once again at the very end of this checkpoint against the final tree
     (including the new operators and docs). See `REVIEW-NOTES.md` for the exact
     commands. This was caught by Codex's review, not by the test suite — the
     automated tests exercise `main()` in-process and can't see an npm-symlink bug;
     the only way to catch it is exactly the manual pack+install smoke test now
     documented in `REVIEW-NOTES.md` and worth repeating after any change to the
     bottom of `cli.ts`.
  3. `cli.ts`: refactored `main()` to accept `(argv, validate)` so `test/cli.test.ts`
     could exercise the real CLI in-process with an injected validator, instead of
     spawning subprocesses. The direct-execution guard means importing `cli.ts` in
     tests no longer has the side effect of running `main()` against real `argv`.
- **Comparison**: evaluated `scolladon/apex-mutation-testing` at commit `c3f95db`
  offline in an isolated temp checkout (never merged into this repo), including
  running its own unit suite (103 files / 2136 tests, all pass, all offline). Full
  evidence, verified-vs-claimed table, and recommendation in
  [docs/COMPARISON.md](docs/COMPARISON.md). Headline: it mutates a live org Apex class
  body directly (Tooling API deploy + later restore) and has no `SIGINT`/`SIGTERM`
  handler around that restore (verified by source grep) — a genuine interruption-safety
  gap this repository's validation-only, never-touch-the-org design doesn't have. It
  also has 22 operators, coverage-scoped test selection, and graph-coloring-based
  mutation grouping, none of which this repo has yet and none of which can be added
  without a live org to verify against.
- **Docs**: README rewritten with runnable clone/build/plan/run examples, a full CLI
  option table, the 8-operator table with exclusions explained, exit-code semantics,
  report-privacy notes, the Apex-only-snapshot/`.forceignore` explanation, and honest
  alpha limitations — including a specific, sourced reason (`spawn` + `shell:false` +
  npm's `.cmd` shims) that `run` may not work on Windows, rather than an unverified
  claim either way. Added `CONTRIBUTING.md` (the injected-validator testing pattern)
  and `SECURITY.md` (reporting scope + deliberate risk boundaries). Did not add a
  `CHANGELOG.md` — there are no tagged releases yet, so it would just duplicate this
  file; revisit once there's a first real release.
- **Package/CI**: `npm pack --dry-run` contents inspected — only `dist/**`,
  `README.md`, `LICENSE`, `package.json` (27 files, 25.8 kB packed). CI
  (`.github/workflows/ci.yml`, Node 22 + 24) green on every push this checkpoint,
  including `npm run check`, `npm run demo`, and `npm pack --dry-run`. All commits
  this checkpoint pushed directly to `main` after verifying `gh api user` identity
  (`JoshuaStorm1017`) before each push.

## Claude work order (next)

The checkpoint-2 work order (integration tests, bug fixes, README, package/CI
verification) is now complete. Remaining priorities, roughly in order:

1. **Live-org verification**, whenever a disposable scratch org/sandbox becomes
   available: run `plan` then `run` against `examples/basic` for real, confirm the
   exact `sf project deploy start --dry-run --json` shape this repo assumes still
   matches a current `sf` CLI version, and update this file with the result
   (pass or fail, with the exact `sf` version). Nothing above claims this is done.
2. **Windows verification** — confirm or refute the documented `spawn`/`.cmd`
   concern in README's "Known alpha limitations" with an actual Windows run of both
   `plan` and `run`.
3. Per `docs/COMPARISON.md`'s recommendation: coverage-scoped test selection and
   mutation-grouping are the highest-value remaining gaps, but both need a live org to
   implement and verify (they depend on querying `ApexCodeCoverage`/coverage data) —
   don't attempt them offline-only.
4. Consider filing the interruption-safety gap found in
   `scolladon/apex-mutation-testing` (no `SIGINT`/`SIGTERM` handler around its org
   rollback) as an upstream issue, per `docs/COMPARISON.md`'s "contribution angle."

## Original work plan

1. Parser-based mutation engine with focused tests.
2. Validation-only Salesforce adapter with outcome classification and subprocess tests.
3. Project discovery, isolated runner, CLI, incremental JSON and standalone HTML reports.
4. Synthetic SFDX sample, integration tests, public CI, package verification, updated documentation.

## Delivery ledger

Product outcome: a developer can identify surviving Apex mutants without changing
source or deploying org metadata.
Analysis: acceptance criteria are recorded in docs/ARCHITECTURE.md.
Architecture: Node/TypeScript, parser-aware mutation generation, validation-only
sequential execution.
Development: branch main; lanes are engine, Salesforce adapter, and root integration
(this checkpoint closed the root-integration lane).
Review/testing: engine/adapter focused checks passed at checkpoint 2; root-module
integration tests, CLI end-to-end tests, and a comparison-driven engine addition
completed this checkpoint (49 tests total, all offline/injected). External AgentOps
recording was attempted but unavailable; this repository carries the public,
non-sensitive continuation ledger.
