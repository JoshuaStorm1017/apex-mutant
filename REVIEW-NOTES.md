# Review notes

Concise, evidence-based log per checkpoint for Codex's medium-depth review. No
Salesforce CLI or org is available or used anywhere in this log.

## Checkpoint F — equivalent-mutant suppression and tool-side stability evidence

Closes the two gaps checkpoint E documented as buildable without an org
(`docs/REQUIREMENTS.md` G1 and the offline half of G3). Both are readiness items the
enforcement checklist itself asks for, so shipping the checklist without them would have
been asking users for evidence the tool made impossible to collect.

**Design change from the proposal, and why.** `docs/REQUIREMENTS.md` originally proposed
a suppression file keyed on mutation IDs. Implementing it revealed that would not work:
`mutationId` hashes the **entire file's source**, so every suppression in a file would go
stale on any edit anywhere in it — including edits far from the suppressed line. The
feature is therefore in-source and location-based:

    // apex-mutant-disable-next-line conditional-boundary: i is never 0 here
    Boolean b = true; // apex-mutant-disable-line all: compile-time constant

- Markers are read from the **lexer's comment tokens** (`ApexLexer.LINE_COMMENT`), not by
  scanning text. Verified: a `//` inside a string literal is a string, and suppresses
  nothing (`test/suppressions.test.ts`). This keeps the AGENTS.md rule — never guess at
  Apex syntax — rather than trading it for a convenient regex.
- A directive inside a `/* … */` block comment is **reported, not honored**: commenting
  code out is not the same as suppressing a mutant.
- A reason is mandatory (≥5 non-space characters). Missing reason, unknown operator,
  typo'd directive, and stale markers all suppress nothing and are reported — by `plan`
  (stderr), `run` (stderr), the report's findings, and `doctor` (non-zero exit).
- Suppression is applied during planning, **before** `--include`/`--exclude`/
  `--operators`/`--max-mutants`, so narrowing a run can never resurrect a suppressed
  mutant. Unused-marker detection deliberately runs against each file's *complete*
  mutation set, so filtering a run does not make other markers look stale.
- Suppressed mutants cost no org request (never validated), never enter the score, and
  are always visible: `plan` output, `plan.json` (now `schemaVersion: 2`), the report's
  `suppressions`, a `suppressed` finding carrying the stated reason, and a `suppressed`
  count in the summary beside the score.

**Stale markers are reported, not fatal.** A stale marker hides nothing — nothing was
suppressed — but its author believes otherwise. Failing the run over a comment typo would
be worse than saying so loudly in four places.

**Stability evidence.** `test/runner.test.ts` now runs the same project twice with the
same injected validator and compares the **whole report**, allowing only `runId` and
timestamps to differ. Scope is stated honestly in the test and in
`docs/TECHNICAL-REVIEW.md`: this is determinism in the tool, and says nothing about
whether a real org answers the same way twice (still G3's live half).

**Verification performed (all offline; no Salesforce CLI or org was used)**

- `npm run check`: typecheck + **116 tests** (104 → 116) + build, all passing.
- Two behaviors were caught by the new tests rather than by inspection, and fixed:
  (1) the first implementation reported a "directive in a non-line-comment" problem for a
  `//` inside a string literal — it scanned every token's text rather than only comment
  tokens; (2) a typo'd directive (`apex-mutant-disable-everything`) was silently ignored,
  so a user's intended suppression would have done nothing quietly. Both now behave as
  the tests assert.
- `OPERATOR_IDS` is now exported from `src/mutations.ts` and used by suppression-scope
  validation and by the findings-guidance coverage test, so a new operator cannot be
  added without both noticing.

## Checkpoint E — advisory-first reporting, findings, safeguard evidence, portable exports

Source of the requirements: external review feedback on this project, turned into
generic product requirements. Nothing organization-specific is encoded in the repo —
the readiness checklist and scope statement in `src/policy.ts` are engineering criteria,
not anyone's policy, and no employer, org name, or internal standard appears anywhere.

**What changed**

- `src/policy.ts` (new): `ENFORCEMENT_READINESS` (6 evidence items), `SCOPE_STATEMENT`
  (what mutation testing does *not* cover), `advisoryNotice`, `isConclusive`.
- `src/findings.ts` (new): per-operator guidance (what a survivor of each operator class
  actually means, plus the assertion that would kill it), `buildFindings`, `fileHotspots`.
- `src/exports.ts` (new): CSV/SARIF/Markdown renderers, format parsing, work-item
  validation, `writeExports`.
- `src/version.ts` (new): tool name/version for artifact provenance, pinned to
  package.json by `test/version.test.ts`.
- `src/types.ts`: `Report` is `schemaVersion: 2` with `tool`, `policy`, `traceability`,
  `safeguards`; `EnforcementPolicy`, `Traceability`, `SourceIntegrity`, `RunSafeguards`.
- `src/report.ts`: `reportExitCode(report)` reads the policy from the report (breaking
  API change from `reportExitCode(report, threshold)`); HTML gained advisory banner,
  findings, hotspots, safeguards, and readiness sections; `report.json` gained derived
  `findings`/`hotspots`/`enforcementReadiness`/`scope`.
- `src/project.ts`: `verifySourceIntegrity` — re-reads every project file after a run.
- `src/runner.ts`: builds the v2 report, validates the policy and work items before any
  work, records safeguards, runs the integrity check, writes exports.
- `src/cli.ts`: `--enforce`, `--export`, `--work-item`; `--threshold` now requires
  `--enforce`; prints the advisory notice and the top findings with their actions.

**Verification performed (all offline; no Salesforce CLI or org was used)**

- `npm run check`: typecheck + **104 tests** (73 → 104; 31 added, 2 rewritten) + build,
  all passing. `npm run demo` unchanged at 5 mutants.
- End-to-end artifact check against `examples/basic` with an injected validator (a
  throwaway script outside the repo, not committed): produced `report.json`,
  `report.html`, `findings.csv`, `report.sarif`, `summary.md` for a 5-mutant run and
  inspected each by hand. Two defects were found this way and fixed before committing:
  (1) Markdown escaped `|` in prose as well as in table cells, rendering `&& → \|\|`
  in a heading — now escaped in table cells only, with a test pinning both halves;
  (2) confirmed the CSV formula-injection defusal actually fires on real output (the
  `= → (removed)` conditional-boundary cell is written as `"'= → (removed)"`).
- Adversarial cases covered by the new tests rather than by inspection: an injected
  validator is never recorded as validation-only; an in-memory project reports source
  integrity as `verified: false` (not `unchanged: true`); a validator that edits the
  developer's source mid-run is caught and named in the report; `--threshold` alone and
  `--enforce` alone are both rejected; invalid work items and unknown export formats are
  rejected before a run starts; SARIF emits no `error` level in either mode; HTML escapes
  the new caller-supplied safeguard/traceability fields.

**Judgment calls**

- *Exit code 2 still fires in advisory mode.* Advisory means the **score** never fails
  anything. A failed baseline, an incomplete run, or an environment error means the tool
  produced no evidence at all — reporting that as success would be the dishonest option,
  and it is not a quality gate. Stated explicitly in README and `--help`.
- *`--threshold` without `--enforce` is an error, not a warning.* It previously worked
  (defaulting to 0) and now fails, which is a breaking CLI change at alpha. A threshold
  that silently does nothing is worse than an error that says why.
- *`validationOnly` is false for any caller-supplied validator*, including the ones the
  test suite injects. A `Validator` is arbitrary code; apex-mutant cannot attest what it
  sends to an org, so the report says "not attested" rather than inheriting the built-in
  path's guarantee.
- *`equivalenceRisk` is a per-operator heuristic, labelled as one.* Boundary and
  arithmetic survivors are marked `moderate` and their suggested action says to record an
  equivalent mutant instead of inventing a test. No semantic analysis is performed and
  none is claimed.
- *Findings are derived, never stored in the report.* `report.json` is written after
  every mutant; storing findings would let a partially-written report carry stale ones.
- *Work items are validated up front, not sanitized afterwards.* They end up in CSV,
  SARIF, and Markdown that other systems parse; a conservative accepted shape is safer
  than post-hoc escaping in three formats.
- *`docs/REQUIREMENTS.md` lists what is still missing.* Equivalent-mutant suppression
  (G1) and run-to-run stability evidence (G3) are gaps, named as gaps, with the
  acceptance test each needs — including in `docs/TECHNICAL-REVIEW.md`'s acceptance
  matrix, so the gap travels with the document a reviewer reads.

**Unchanged limits**

No Salesforce CLI, org, or Windows machine was used. Everything above is verified with
injected validators, real temp-directory projects, and platform simulation — same
standard as every previous checkpoint.

## Checkpoint D — docs/TECHNICAL-REVIEW.md, SECURITY.md correction (milestone complete)

Final slice of the "easier to pilot/review externally" milestone (A–D). No code
changes — docs only, so `npm run check` is unchanged at 73/73; ran it anyway to confirm.

**`docs/TECHNICAL-REVIEW.md`** (new): generic committee-ready brief — explicitly not
tied to any named employer or review body. Covers architecture/data flow (with an
ASCII diagram), the exact `sf` commands this tool runs and why each is read-only, a
dependency/license table (cross-referencing the SBOM `scripts/release.mjs` generates
per-release rather than duplicating stale numbers), install/uninstall, a platform
support table, API/time budget, the remote-cancellation limitation (`Ctrl+C` stops the
local process but not an already-in-flight remote validation — quotes the exact message
`src/salesforce.ts` already returns for this), and an acceptance matrix that explicitly
separates what's verified offline from what's pending a real sandbox pilot.

**Synthetic pilot recipe**: uses the `examples/basic` fixture already in this repo,
including its deliberately-weak `checksEligibility` boundary test. Before writing the
expected results, verified the mutation-effect reasoning empirically rather than by
hand-tracing alone: wrote a throwaway pure-JS simulation of `DiscountService`'s logic
(original vs. each of the 5 known mutants) and ran the existing test assertions against
each variant. Result: **3 of 5 mutants killed, 2 survive** (60% score) — not the single
survivor a quick read of the test's own comment would suggest. The `<`→`<=` boundary in
`price`'s negative-amount check also survives, because no existing test calls
`price(0, ...)` — this was not previously documented anywhere in this repo. The
document states this is a logic-equivalent simulation, not a real Apex/org run, and
flags the acceptance matrix accordingly (⏳ pending a real pilot to confirm it holds
against actual `sf` CLI/org behavior). Simulation script deleted after use, not committed.

**`SECURITY.md` correction**: "Never edits your original project files" was too
absolute given `plan`/`run` intentionally write output artifacts inside the project by
default. Reworded to distinguish "your Apex source is never edited" from "nothing is
ever written into your project" (false), and to cross-reference the atomic-write /
symlink-resistance guarantee and the sandbox/scratch gate, matching what
`docs/TECHNICAL-REVIEW.md` and `HANDOFF.md` now also say.

```
npm run check   # unchanged: 73/73 pass, typecheck/build clean (docs-only checkpoint)
npm run demo    # unchanged: 5 mutants against examples/basic
```

**Judgment calls:**
- Did not fabricate or imply any live-org verification anywhere in the new document —
  every "verified" cell in its acceptance matrix names the actual offline/simulated
  mechanism, and every org-dependent claim is explicitly marked pending.
- Cross-referenced the SBOM/license table to "generated fresh per release" rather than
  hardcoding the current two-dependency list into the review doc, so it doesn't go
  stale if dependencies change without this doc being updated in lockstep.

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

**Actual release performed this checkpoint** — not just the workflow file — created
directly from this session after pushing checkpoint C's code and confirming CI green
(`gh api user --jq .login` → `JoshuaStorm1017` immediately beforehand):

- URL: https://github.com/JoshuaStorm1017/apex-mutant/releases/tag/v0.1.0-alpha.2
- Tag/target: `v0.1.0-alpha.2` at commit `bb480fbb9c0209d386b9460e05bb97059afa4cdc`
  (the exact commit CI had just confirmed green, incl. the new tarball-smoke step)
- Marked `isPrerelease: true`
- Assets: `apex-mutant-0.1.0-alpha.2.tgz`, `SHA256SUMS`, `sbom.cyclonedx.json`, `LICENSES.txt`

**This is distinguished from a mere dry-run listing** by downloading the actual
uploaded asset back and re-verifying it, not by trusting the local build:

```
gh release download v0.1.0-alpha.2 --dir <fresh dir>
shasum -a 256 <fresh dir>/apex-mutant-0.1.0-alpha.2.tgz
# → 072ab7f5b5c87e67f4e6d5fa3e91877b7ee187832718327cb8e0495fff087dfd
```

That hash matches, byte for byte, both the release's own `SHA256SUMS` asset and the
hash computed at build time locally — three independent computations, all identical.
Then installed the **downloaded** tarball (not the local build) into a fresh isolated
directory and ran the installed bin:

```
npm install --prefix <fresh install dir> <downloaded tgz>
<fresh install dir>/node_modules/.bin/apex-mutant --help
# → prints full usage text including the `doctor` command, confirming the
#   installed-from-the-actual-public-release bin works end to end
```

Scratch verification directory removed afterward; nothing from it was committed.

**Incident, disclosed:** while grepping `HANDOFF.md` for a line containing the text
"npm publish" in backticks, a shell command string had unescaped backticks inside
double quotes, which bash interpreted as command substitution — `npm publish` was
executed for real. It failed closed on its own for two independent reasons, verified
immediately after: this machine has no npm registry auth at all (`npm whoami` →
`ENEEDAUTH`), and npm additionally refused with "You must specify a tag using --tag
when publishing a prerelease version." `npm view apex-mutant` confirms `404 Not Found`
on the real registry — nothing was published, no account was touched. Root cause:
backticks inside a double-quoted Bash string are live command substitution, not literal
characters; will avoid backticks in any grep/search pattern passed as a shell string
going forward (single-quote the pattern, or avoid backtick characters in it entirely).

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
