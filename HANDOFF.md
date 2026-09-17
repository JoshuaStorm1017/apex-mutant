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

`npm run check`: typecheck + **116** tests + build, all passing. `npm run demo` yields 5
mutants against `examples/basic`. CI runs `npm run check`, `npm run demo`, and a real
tarball-install-and-run smoke test (`scripts/tarball-smoke.mjs`) on every push.

Key docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module contract),
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) (requirement → code → test traceability,
plus the open gaps with proposed acceptance tests),
[docs/COMPARISON.md](docs/COMPARISON.md) (evaluation against
`scolladon/apex-mutation-testing`), [docs/TECHNICAL-REVIEW.md](docs/TECHNICAL-REVIEW.md)
(committee-ready brief with an acceptance matrix and a runnable synthetic pilot recipe),
[REVIEW-NOTES.md](REVIEW-NOTES.md) (per-checkpoint self-validation evidence).

## Milestone just completed: advisory-first product requirements

Implemented in one checkpoint (evidence in `REVIEW-NOTES.md` checkpoint E), from external
review feedback turned into generic product requirements — no organization's internal
policy is encoded anywhere in the repo:

- **Advisory-first reporting.** `run` reports in advisory mode by default: the mutation
  score never changes the exit code. Gating needs `--enforce` *and* an explicit
  `--threshold`; either alone is rejected rather than silently resolved. Exit code 2
  keeps its meaning (the run produced no readable result) in both modes. Reports state
  the mode, the scope of the evidence, and the readiness checklist a team should satisfy
  before enforcing (`src/policy.ts`). SARIF never emits `error` level.
- **Test-improvement findings.** Surviving mutants become located, prioritized findings
  with a concrete suggested assertion per operator class; `invalid`/`timeout`/`error`
  mutants are reported separately as "unproven" and never read as gaps; failed baselines
  and short runs become run-quality findings; file hotspots rank where gaps concentrate
  (`src/findings.ts`).
- **Execution safeguard evidence.** Every report records which validator ran and whether
  it was the built-in validation-only path (a caller-supplied `Validator` is recorded as
  un-attested — never assumed safe), the org classification that was enforced, snapshot
  isolation, and a post-run byte-for-byte re-read of every project file
  (`verifySourceIntegrity`). Anything unverifiable reports `verified: false`, never
  `unchanged: true`.
- **Portable exports and traceability.** `--export csv,sarif,md` writes tool-agnostic
  artifacts; `--work-item <id>` (validated up front) stamps caller-supplied identifiers
  into the report and every export. CSV defuses spreadsheet formula injection
  (`src/exports.ts`).

Equivalent-mutant suppression landed in the same milestone: in-source
`// apex-mutant-disable-next-line <operator|all>: <reason>` markers, read from the
lexer's comment tokens (so a `//` in a string literal is a string), with a mandatory
reason. Suppressed mutants are never validated, never scored, and always listed with
their reason; malformed, unknown-operator, and stale markers suppress nothing and are
reported by `plan`, `run`, `doctor`, and the report's findings. Suppression is applied
before every filter, so narrowing a run cannot resurrect a suppressed mutant
(`src/suppressions.ts`, `planProjectDetailed` in `src/project.ts`).

Tool-side run-to-run stability is now tested too: two runs over unchanged source produce
identical reports apart from `runId` and timestamps. That is determinism in this tool
only — it says nothing about a real org's stability, which still needs a pilot.

Report `schemaVersion` is now **2** (`tool`, `policy`, `traceability`, `safeguards` are
and `suppressions` are new top-level fields; `report.json` also carries derived
`findings`, `hotspots`, and the readiness checklist). `plan.json` is `schemaVersion: 2`
as well, with `suppressed` and `suppressionProblems`. `reportExitCode(report)` now reads the policy from the report
instead of taking a threshold argument — a breaking library API change, acceptable at
alpha and called out here deliberately.

## Previous milestone: easier to pilot and review externally

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
- **No runtime evidence, and no org-side stability evidence.** Readiness item 1 (a full
  run's wall-clock time on a real codebase) is unmeasured, and the tool-side determinism
  test says nothing about whether a real org answers the same way twice
  (`docs/REQUIREMENTS.md` G2/G3) — both need a live org.
- **Suppression is location-based, not identity-based.** An in-source marker follows the
  code it sits next to, but moving that code to another line (or another file) leaves a
  stale marker. That is reported loudly, never silently honored, but it is still manual
  upkeep.
- No resumable runs (`docs/REQUIREMENTS.md` G4).

## Next priorities

1. **An authorized sandbox/scratch org pilot** — the single highest-value next step.
   `docs/TECHNICAL-REVIEW.md`'s "Synthetic pilot recipe" is ready to run as-is against
   `examples/basic`; update that doc's acceptance matrix and this file with the actual
   result (pass or fail, exact `sf` CLI version) once someone does it.
2. **Real Windows verification** (or a real WSL run) of `plan`, `doctor`, and the
   native-Windows early-error path for `run`.
3. **Resumable runs** (`docs/REQUIREMENTS.md` G4) — the largest remaining
   offline-buildable gap, and the one that most reduces the cost of a long pilot run.
4. Per `docs/COMPARISON.md`: coverage-scoped test selection and mutation grouping,
   once org access exists to build and verify them against.
5. Consider filing the interruption-safety observation about
   `scolladon/apex-mutation-testing` (no `SIGINT`/`SIGTERM` handler found around its org
   rollback, via static analysis only) upstream — after confirming it against a live
   interrupted run first, per `docs/COMPARISON.md`'s own caveat.

## Delivery ledger

Product outcome: a developer can identify surviving Apex mutants without changing
source or deploying org metadata, get a concrete suggested assertion for each one, and
export the result — with their own work-item identifiers — into whatever tracks the
work. Nothing fails a build unless someone explicitly asked for it to.
Architecture: Node/TypeScript, parser-aware mutation generation, validation-only
sequential execution.
Review/testing history: engine/adapter → root-module + CLI integration tests →
Codex-found output-path symlink fix + doc corrections → Codex-found runner
API-boundary fixes → doctor/org-gate/Windows-guard → CI-automated tarball smoke test +
versioned GitHub prerelease → technical-review brief → advisory-first reporting,
findings, safeguard evidence, and portable exports → equivalent-mutant suppression and
tool-side stability evidence (this checkpoint). 116 tests total,
all offline/injected or platform-simulated — no Salesforce CLI, org, or Windows machine
has ever been used in this repository's verification.
