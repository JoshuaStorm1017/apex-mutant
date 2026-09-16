# Review notes — Claude checkpoint 3

For Codex's review pass. Everything here is offline/injected-validator work; no
Salesforce CLI or org was available or used. See `HANDOFF.md` for the narrative
version of this same work.

## Commits this checkpoint (pushed to `main`, in order)

Starting point: `1733b7f` (checkpoint 2, already on `origin/main` before this session).

1. `af8bf94` — test: add project/runner/report integration tests; fix CLI npm-bin
   symlink guard
2. `8906eb0` — test: add end-to-end CLI coverage with injected validators
3. `25a5157` — feat: add increment-decrement and unary-negation-removal operators;
   add docs/COMPARISON.md
4. `d818830` — docs: expand README, add CONTRIBUTING.md and SECURITY.md

Each was pushed with `git push origin HEAD:main` immediately after `gh api user
--jq .login` confirmed `JoshuaStorm1017` and after inspecting `git status --short`
for anything unexpected before staging. All four CI runs on GitHub are green
(`gh run list --repo JoshuaStorm1017/apex-mutant`), Node 22 and 24.

## Self-validation: commands run and results

```
npm run check
# typecheck: clean
# test: 49/49 pass (0 fail, 0 skipped on this platform — 2 symlink tests are
#   platform-gated to skip on win32, not skipped here)
# build: clean

npm run demo
# Apex Mutant · 5 mutations planned  (unchanged from checkpoint 2 — the fixture
#   doesn't contain any increment/decrement or unary-minus patterns)

npm pack --dry-run
# 27 files, 25.8 kB packed / 89.5 kB unpacked — only dist/**, README.md, LICENSE,
#   package.json. No test files, no source .ts, no examples/, no docs/, no .git.
```

**Installed-tarball bin smoke test** (done twice — once right after the symlink fix,
once again at the very end against the final tree with the new operators and docs):

```
npm run build && npm pack --silent
npm install --prefix <isolated temp dir> <isolated temp dir>/apex-mutant-*.tgz
<isolated temp dir>/node_modules/.bin/apex-mutant --help        # prints usage
<isolated temp dir>/node_modules/.bin/apex-mutant plan --project <copy of examples/basic>
# Apex Mutant · 5 mutations planned  — same 5 mutant IDs as the source-tree demo
```

This is the check that actually caught the npm-bin bug (see below) — the in-process
CLI tests cannot see it, because `main()` is invoked directly with an in-memory
`argv`, never through an actual npm-installed symlink.

**End-to-end classification cases**, all via injected `Validator` functions (no real
`sf`), spread across `test/runner.test.ts` and `test/cli.test.ts`: baseline pass,
baseline fail (stops before any mutant), mutant killed, mutant survived, mutant
compile-invalid (covered in `test/salesforce.test.ts`'s classification tests, which
predate this checkpoint and were re-run, unchanged, as part of `npm run check`),
timeout (stops the loop early), infrastructure error (stops the loop early, and
separately: an unexpectedly-*throwing* validator is still classified as `error`
rather than crashing the run), and cancellation via `AbortSignal` both before the
baseline and mid-loop (preserves completed results, still cleans up the snapshot).

**Original-bytes-preserved / temp-copy-removed**: `test/runner.test.ts`'s "mutants are
validated one at a time against a clean copy" test reads the snapshot's on-disk file
content from *inside* the injected validator and asserts the non-mutated file is
byte-identical to the original source while a different file's mutant is active —
this is a stronger check than "the report is right," it's "the disk state during
validation is right." Cleanup is asserted with `stat(snapshotDir)` rejecting
(`ENOENT`) after every terminal path: success, baseline failure, mid-loop abort.

**Safe output paths**: `test/cli.test.ts`'s "`--output` inside a package directory is
rejected" plus `test/project.test.ts`'s "rejects file keys that would escape the
snapshot directory" (the new `assertSafeRelativePath` defense-in-depth, see below).

**Score/exit-code correctness**: full matrix in `test/report.test.ts` (see HANDOFF.md
for the exact table) plus `test/cli.test.ts`'s threshold-below/threshold-met cases.

**HTML escaping**: `test/report.test.ts` injects `<script>alert(1)</script>&"'` into
every rendered field (file, original, replacement, message, outcome) and asserts none
of it appears unescaped, plus asserts the report's CSP header blocks script execution
as defense in depth.

**Public staged-file/privacy review**: every `git add` this checkpoint was preceded by
`git status --short` and, where multiple files were touched, `git diff --stat` to
confirm nothing unexpected was staged. No credentials, org identifiers, or private
handoff content were introduced. One accidental local mistake and its recovery is
recorded below.

## Known limitations (unchanged from HANDOFF.md, repeated here for review convenience)

- No live Salesforce org or CLI has ever been used to verify anything in this
  repository, this checkpoint included. Every "verified" claim above is
  injected-validator or fake-subprocess-based.
- Windows support for `run` is undetermined; README now states a specific, sourced
  reason (`spawn` + `shell:false` + npm's `.cmd` shims) rather than asserting either
  way.
- Coverage-scoped test selection and mutation grouping (see `docs/COMPARISON.md`)
  are not implemented; both would need a live org to build and verify safely.

## Comparison recommendation (full detail in `docs/COMPARISON.md`)

Evaluated `scolladon/apex-mutation-testing` at commit `c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc`
(2026-08-25, v1.9.1) in an isolated temporary clone — never merged into this repo, no
source copied. Ran its own offline unit suite there (103 files / 2136 tests, all
pass) as supporting evidence, not as a claim about this repo.

**Recommendation: differentiate, don't duplicate.** That tool mutates a live org Apex
class body directly via the Tooling API and restores it afterward — verified in its
source (`orgMutationTestBed.ts`), and verified to have **no `SIGINT`/`SIGTERM` handler**
anywhere in its `src/` tree (a plain grep), meaning a hard interrupt during a run can
leave the org's real class mutated with no automatic recovery. This repository's
validation-only, never-touch-the-org design has no equivalent exposure, and that
safety property is this project's actual differentiator — reaching feature parity
(22 operators, org-mutate-and-restore, coverage-scoped selection, graph-coloring
grouping, a paid third-party local-runtime integration) would mean abandoning it. The
one gap closed this checkpoint (two new operators) was chosen specifically because it
required no execution-model change and no org access to implement or verify.
`docs/COMPARISON.md` also flags a scoring-design divergence worth knowing about:
their tool counts `RuntimeError` (infrastructure/network failures) toward the score
*numerator* as if it were a kill, which this repository's architecture contract
deliberately does not do.

## Risky decisions that need Codex's judgment, not just review

1. **The npm-bin symlink fix's exact mechanism.** I changed the direct-execution
   guard in `cli.ts` from a raw `import.meta.url` string comparison to comparing
   `realpath()` of both `process.argv[1]` and the module's own path. I verified this
   empirically (broken before, fixed after) with a real `npm pack` + isolated
   install, twice. I have not verified it against every possible install topology
   (e.g., a *second* level of symlinking, or a package manager other than npm that
   installs bins differently, like pnpm's own symlink strategy). If Codex has
   visibility into how this package might actually be installed in practice, that's
   worth a second look — the fix is narrow (two `realpath` calls) but the failure
   mode it fixes was total (the CLI silently did nothing at all when installed).
2. **`assertSafeRelativePath` as defense-in-depth, not a reachable bug today.** I
   added path-escape validation to `project.ts`'s `snapshotProject` and `runner.ts`
   because `Project` is a public exported type and a hand-built one (not produced by
   `readProject`) could carry an unsafe file key. Under the actual CLI flow this is
   unreachable — `readProject` only ever produces safe keys. I judged this worth
   fixing anyway since it's explicitly the kind of thing `HANDOFF.md`'s prior work
   order flagged ("output paths/symlinks must not overwrite source"), but it's a
   judgment call about how much defense-in-depth a library's public API surface
   deserves, not a fix for an exploitable-today bug.
3. **Choosing exactly two new operators, not more.** `docs/COMPARISON.md` shows a
   6-vs-22 operator gap. I implemented the two (increment-decrement,
   unary-negation-removal) that fit the existing single-token AST-visitor pattern
   with no new risk. I did not attempt operators that need multi-token spans
   (e.g., their `ArithmeticOperatorDeletion`, which removes an operator *and* one
   operand) because that changes the `add()` helper's single-node contract and I judged
   it needed more design thought than this checkpoint's scope, not because it's
   infeasible. If more operator coverage is a priority, that's the next natural slice.
4. **No `CHANGELOG.md`.** The work order suggested one "if useful." I judged it not
   useful yet (no tagged releases to changelog) and documented that judgment in
   `HANDOFF.md` instead of adding a stub file. Reversible if Codex disagrees.

## One mistake made and corrected this checkpoint

While running an installed-tarball smoke test, `npm init -y --prefix <temp dir>`
did **not** respect `--prefix` for `npm init` specifically and instead wrote/reformatted
`package.json` in this repo's own working directory (added `keywords`, `author`,
`bugs`, `homepage`, `main`, `directories` fields and reformatted existing fields to
multi-line). This was caught immediately by `git status --short` before staging
anything, confirmed with `git diff package.json`, and reverted with
`git checkout -- package.json` (safe: the change was uncommitted and the revert
target was the last pushed commit). Nothing from this mistake was ever committed or
pushed. Noting it here in case the same `npm init --prefix` behavior surprises a
future agent doing a similar smoke test — prefer `npm --prefix <dir> install <tgz>`
into a directory that already has a minimal `package.json` (or accept `npm install`'s
own auto-created one) rather than `npm init --prefix`.
