# Claude / next-agent handoff

## Checkpoint 4: critical output-path symlink fix (Codex-found), doc corrections

Public open-source Apex mutation testing CLI, MIT license. Owner delegated the
remaining integration, verification, comparison, and documentation work to Claude to
conserve Codex credits; Codex reviews completed work and this checkpoint is a direct
response to a focused review Codex ran against checkpoint 3 (`ea3958a`). Codex found one
blocking security bug and several documentation-accuracy issues in that checkpoint; both
are fixed here. See [docs/COMPARISON.md](docs/COMPARISON.md) and
[REVIEW-NOTES.md](REVIEW-NOTES.md) for full evidence.

No Salesforce CLI or org exists on this development host; **live-org acceptance is
still NOT verified.** Every claim below that could plausibly need a real org has been
verified instead with an injected fake `Validator` or a real local subprocess shaped
like `sf` (see `test/salesforce.test.ts`'s fake-executable pattern) — never a real
Salesforce CLI or org.

## Blocker fixed this checkpoint: output writes could follow a symlink and overwrite arbitrary files

**Found by Codex**, reproduced independently before fixing: `cli.ts`'s `plan` command
wrote `plan.json` with a plain `writeFile(join(output, 'plan.json'), ...)`. If anything
— a leftover file from a previous tool, a symlink planted by another process, or a
maliciously-crafted repository a user cloned and ran `plan` against — had already placed
a symlink at `<output>/plan.json` pointing anywhere on disk the process could write to,
`writeFile` followed it and overwrote the *target*, not the symlink. Reproduced exactly:
a disposable fixture with `.apex-mutant/plan.json` symlinked to `force-app/Demo.cls`; a
plain `main(['plan', '--project', root])` call replaced the real Apex source file's
content with plan JSON.

The `--output must be outside package directories` guard (`cli.ts`) didn't help here
either way — that check is about which *directory* `--output` resolves to, not about
symlinks planted at individual *file paths* inside an otherwise-legitimate output
directory — but it had a second, related gap: it compared the literal, unresolved path
strings, so an `--output` directory that was itself a symlink (or sat behind one) into a
package directory could pass the check on paper while actually resolving inside the
source tree.

Fixed both, and added a small shared safe-output layer in `report.ts` (used by `cli.ts`'s
`plan` write and `report.ts`'s own `writeReport`, which the runner calls after every
mutant):

- **`writeFileAtomic(directory, name, content)`** (new, exported from `report.ts`):
  writes to a fresh randomly-named temp file, then `rename()`s it into place. POSIX
  `rename()` replaces whatever is at the destination — including a symlink — rather than
  writing through it, so a planted symlink at `plan.json`/`report.json`/`report.html`
  gets atomically replaced by a real file instead of used as a write target.
  `writeReport` already did this inline for its own two files; it's now the same
  extracted helper `cli.ts`'s `plan` command calls too, closing the actual reproduced
  bug.
- **`resolveRealPath(path)`** (new, exported from `report.ts`): resolves the real,
  symlink-free path of `path`, or of its nearest existing ancestor with the
  not-yet-created remainder appended if `path` doesn't exist yet. `cli.ts`'s
  `--output`-outside-package-directories check now compares *canonical* paths on both
  sides instead of literal strings, so a symlinked `--output` directory (or a symlinked
  ancestor of it) that actually resolves inside a package directory is rejected, not
  just one whose un-resolved path string happens to start with the package directory's.

New regression tests (12 total across the two areas, all skipped on `win32` where
symlink creation needs elevated privileges, matching the existing pattern in
`test/salesforce.test.ts`/`test/project.test.ts`):

- `test/cli.test.ts`: a symlink at the `plan.json` output path pointing at real Apex
  source — asserts the source is byte-for-byte unchanged after `plan` runs, and that the
  symlink is gone, replaced by a real `plan.json` with correct content. A separate test:
  `--output` given as a symlink whose real target sits inside a package directory is
  rejected with the same `--output must be outside package directories` error, even
  though the literal path string doesn't look like it's inside one.
- `test/report.test.ts`: `writeReport` (what the runner actually calls) with pre-existing
  symlinks at both `report.json` and `report.html` pointing at unrelated files — asserts
  those unrelated files are untouched and both output paths end up as real files with
  correct content. A direct unit test of `resolveRealPath` against a symlinked ancestor
  plus a not-yet-created nested path.

`npm run check`: **53/53** tests pass (up from 49), typecheck and build clean. Both
symlink scenarios were manually reproduced end-to-end (broken, then fixed) with real
disposable fixtures before any test was written — see `REVIEW-NOTES.md` for the exact
repro commands.

## Documentation corrections this checkpoint (also Codex-found)

- **`docs/COMPARISON.md` said an "arithmetic-operator deletion" operator was implemented
  in checkpoint 3. It was not** — only `increment-decrement` and
  `unary-negation-removal` were. Corrected; arithmetic-operator deletion (removing an
  operator and keeping one operand, e.g. `a + b` → `a`) needs a multi-token span edit
  the current `add()` helper in `mutations.ts` doesn't support, and remains unimplemented,
  now correctly described as such.
- **The comparison's operator count was wrong**: it claimed the upstream project has 22
  operators while separately listing 26 names underneath — an internal inconsistency
  that should have been caught immediately. Re-verified against a fresh checkout at the
  same pinned commit: 30 files under `src/mutator/`, 4 of them non-operator helpers,
  leaving **26** operators, cross-checked against 26 rows in their own README table.
  Corrected throughout `docs/COMPARISON.md`.
- **`docs/COMPARISON.md` implied coverage-scoped test selection and mutation grouping
  require abandoning validation-only `--dry-run`.** They don't — both are things a
  dry-run-only tool could do; they need a live org to *query* (coverage data) or
  *verify against* (a batched dry-run deploy's classification), not a different
  execution model. Only the upstream project's org-mutate-and-restore execution model
  and its paid third-party local-runtime integration actually require abandoning
  validation-only. Rewrote the "Recommendation" section to keep those two categories
  separate.
- **Source citations in `docs/COMPARISON.md` now pin permalinks** to the exact evaluated
  commit (`c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc`) with line numbers where a specific
  quote or line is cited, instead of bare repo-relative paths that would drift as their
  `main` branch moves.
- **The "no `SIGINT`/`SIGTERM` handler" finding about the upstream project is now
  explicitly labeled as static source analysis (a grep returning zero matches), not
  reproduced live behavior** — no Salesforce org was available to actually run their
  plugin and interrupt it mid-run to observe the org's resulting state. The previous
  wording stated the consequence ("...can leave the org's real Apex class body mutated")
  as if it had been observed; it was inferred from the absence of a pattern in their
  source, which is what's now stated.
- **Chronology correction in this file (previously misleading):** checkpoint 3's
  handoff described the npm-bin symlink guard bug as something found in *pre-existing*
  code, phrased as "the original direct-execution guard compared..." — but checkpoint
  2's actual shipped code (`1733b7f`) had **no guard at all**; `main()` ran
  unconditionally, which was always correct for the installed bin (just not
  unit-testable). The guard, and its bug, were both introduced by Claude's *own* refactor
  during checkpoint 3 while adding `main(argv, validate)` for in-process testing — the
  first version of that new guard compared raw `import.meta.url` strings and broke the
  npm-installed case, caught via a real tarball-install smoke test and fixed before it
  was ever part of a pushed commit (commit `af8bf94` already contains the fixed version;
  the broken intermediate version only ever existed in local, uncommitted edits). It was
  a bug Claude introduced and fixed within the same checkpoint, not one inherited from
  checkpoint 2 and merely discovered. `REVIEW-NOTES.md` is corrected to match.
- **Absolute "your project files are never edited" wording in `README.md` softened.**
  That claim, stated unqualified in the "How it works" section, was misleading given (a)
  `plan`/`run` output artifacts intentionally live inside the project by default
  (`.apex-mutant/`), and (b) the symlink bug above was a real, demonstrated counterexample
  to an unqualified version of that claim. Reworded to state precisely what's guaranteed
  (Apex source under package directories is never touched; output writes are atomic and
  replace rather than follow a pre-existing symlink at the destination) instead of an
  unconditional "nothing is ever written."

## Verified now (carried forward from checkpoint 3, corrected where noted above)

- `npm run check`: typecheck, **53** tests, and build all pass. Offline `npm run demo`
  still yields 5 mutants against `examples/basic`.
- **Engine**: 8 operators — the original 6 (`conditional-boundary`, `equality-negation`,
  `logical-connector`, `boolean-literal`, `negation-removal`, `arithmetic`) plus
  `increment-decrement` and `unary-negation-removal` (checkpoint 3). Still excludes
  strings/comments/annotations/queries/test code, per architecture contract.
- **Root modules reviewed and tested** (`project.ts`, `runner.ts`, `report.ts`,
  `cli.ts`): `test/project.test.ts` (9), `test/runner.test.ts` (8), `test/report.test.ts`
  (9, incl. two new symlink regressions), `test/cli.test.ts` (13, incl. two new symlink
  regressions).
- **Other defense-in-depth fix from checkpoint 3, unaffected by this checkpoint**:
  `assertSafeRelativePath` in `project.ts`/`runner.ts`, guarding against a hand-built
  `Project` (a public exported type) carrying an unsafe file key. Not reachable through
  the CLI today; a latent safety gap for library consumers, not an exploitable-today bug.
- **Comparison**: evaluated `scolladon/apex-mutation-testing` at commit `c3f95db`
  offline in an isolated temp checkout (never merged into this repo), including running
  its own unit suite (103 files / 2136 tests, all pass, all offline). Full evidence,
  corrected verified-vs-claimed table, and recommendation in
  [docs/COMPARISON.md](docs/COMPARISON.md). Headline: it mutates a live org Apex class
  body directly (Tooling API deploy + later restore); static analysis found no
  `SIGINT`/`SIGTERM` handler anywhere in its source (not reproduced live). It has 26
  operators (not 22 — corrected this checkpoint), coverage-scoped test selection, and
  graph-coloring-based mutation grouping — the latter two are compatible with a
  validation-only architecture in principle, just unverified without a live org
  (corrected framing this checkpoint; see `docs/COMPARISON.md`).
- **Docs**: README, `CONTRIBUTING.md`, `SECURITY.md` from checkpoint 3, with the
  "never edited" softening above applied this checkpoint.
- **Package/CI**: `npm pack --dry-run` re-inspected after this checkpoint's changes —
  contents unchanged (`dist/**`, `README.md`, `LICENSE`, `package.json`). CI green on
  every push. All commits pushed directly to `main` after verifying `gh api user`
  identity (`JoshuaStorm1017`) before each push.

## Claude work order (next)

1. **Live-org verification**, whenever a disposable scratch org/sandbox becomes
   available: run `plan` then `run` against `examples/basic` for real, confirm the exact
   `sf project deploy start --dry-run --json` shape this repo assumes still matches a
   current `sf` CLI version, and update this file with the result (pass or fail, with
   the exact `sf` version). Nothing above claims this is done.
2. **Windows verification** — confirm or refute the documented `spawn`/`.cmd` concern in
   README's "Known alpha limitations" with an actual Windows run of both `plan` and `run`.
3. Per `docs/COMPARISON.md`'s corrected recommendation: coverage-scoped test selection
   and mutation grouping are both compatible with validation-only and are the
   highest-value remaining gaps, but both need a live org to implement and verify
   correctly — don't attempt them offline-only.
4. Before filing the upstream interruption-safety observation as an issue against
   `scolladon/apex-mutation-testing`, confirm it against a real, live interrupted run
   first — the current finding is static-source-analysis only (see
   `docs/COMPARISON.md`), and an issue report should say what was actually observed, not
   just what a grep didn't find.
5. If `report.ts`'s new `writeFileAtomic`/`resolveRealPath` helpers get reused elsewhere
   in the future, keep the "replace a symlink, never write through it" property intact —
   it's the whole point, and it's specific to `rename()`'s POSIX semantics (untested on
   Windows, where symlink creation itself is already gated behind elevated privileges in
   most setups, matching this project's general Windows-uncertainty documented above).

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
Development: branch main; lanes are engine, Salesforce adapter, and root integration.
Review/testing: engine/adapter focused checks passed at checkpoint 2; root-module
integration tests and CLI end-to-end tests at checkpoint 3; a Codex-found critical
output-path symlink vulnerability fixed, and prior documentation inaccuracies
corrected, at checkpoint 4 (this one). 53 tests total, all offline/injected — no
Salesforce CLI or org has ever been used in this repository's verification. External
AgentOps recording was attempted but unavailable; this repository carries the public,
non-sensitive continuation ledger.
