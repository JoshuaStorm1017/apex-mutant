# Review notes — Claude checkpoint 4

Checkpoint 4 is a direct response to a focused Codex review of checkpoint 3 (`ea3958a`).
Codex found one blocking security bug and several documentation-accuracy issues; both
categories are addressed here. Everything below is offline/injected-validator work; no
Salesforce CLI or org was available or used. See `HANDOFF.md` for the narrative version.

## The blocker: output writes could follow a symlink

Codex's report: `cli.ts`'s `plan` command wrote `plan.json` with a plain `writeFile`,
following any pre-existing symlink at that path; the `--output`-outside-package-directory
guard was lexical-only and could be bypassed by a symlinked output directory.

**Reproduced independently before fixing** — exact commands:

```
mkdir -p <fixture>/force-app
echo '{ "packageDirectories": [{ "path": "force-app", "default": true }] }' > <fixture>/sfdx-project.json
echo 'public class Demo { void m() { Boolean b = true; } }' > <fixture>/force-app/Demo.cls
echo '<ApexClass/>' > <fixture>/force-app/Demo.cls-meta.xml
mkdir -p <fixture>/.apex-mutant
ln -sf <fixture>/force-app/Demo.cls <fixture>/.apex-mutant/plan.json

# via tsx, calling the exported main() directly:
main(['plan', '--project', '<fixture>'])

# before the fix: <fixture>/force-app/Demo.cls now contains plan JSON, not Apex source.
```

Confirmed: `Demo.cls` was overwritten with the plan JSON. Second scenario, also
reproduced: an `--output` given as a symlink whose real target sits inside a package
directory passed the old lexical check (the literal path string didn't start with
`force-app`) even though it resolved inside the package tree.

**Fix** (see `HANDOFF.md` for the full description): extracted a `writeFileAtomic`
helper into `report.ts` (temp file + `rename()`, which replaces a symlink at the
destination rather than writing through it) and reused it for both `plan.json` (the
actual reproduced bug) and `report.json`/`report.html` (already using this pattern
inline, now shared). Added a `resolveRealPath` helper and switched the
`--output`-outside-package-directories check in `cli.ts` to compare canonical
(symlink-resolved) paths on both sides instead of literal strings.

**Re-verified fixed**, same two scenarios, same exact commands — after the fix,
`Demo.cls` is untouched and `plan.json` is a real file with correct content; the
symlinked-output-directory case now throws `--output must be outside package
directories.` as expected.

**New regression tests** (12 total, `{ skip: process.platform === 'win32' }` where
symlink creation needs elevated privileges):

- `test/cli.test.ts`: "a pre-existing symlink at the plan.json output path never gets
  written through" and "`--output` that is a symlink resolving into a package directory
  is rejected."
- `test/report.test.ts`: "writeReport never writes through a pre-existing symlink at
  report.json/report.html" (this is the path the runner actually uses) and a direct unit
  test of `resolveRealPath` against a symlinked ancestor with a not-yet-created nested
  path.

```
npm run check
# typecheck: clean
# test: 53/53 pass (up from 49)
# build: clean
```

## Documentation corrections (also from Codex's review)

1. **`docs/COMPARISON.md` falsely claimed "arithmetic-operator deletion" was
   implemented.** It was not — only `increment-decrement` and `unary-negation-removal`
   were added in checkpoint 3. Corrected, with an explanation of why
   arithmetic-operator-deletion specifically wasn't attempted (needs a multi-token span
   edit the current `add()` helper doesn't support).
2. **The upstream operator count was wrong and internally inconsistent**: claimed 22,
   listed 26 names underneath. Re-cloned the upstream repo at the same pinned commit and
   recounted precisely: `ls src/mutator/*.ts | wc -l` → 30; 4 are non-operator helpers
   (`astUtils.ts`, `baseListener.ts`, `baseReturnMutator.ts`, `mutationListener.ts`);
   26 remain. Cross-checked against `grep -c '^| \*\*' README.md` on their README's
   operator table → 26. Corrected throughout `docs/COMPARISON.md`.
3. **`docs/COMPARISON.md` wrongly implied coverage-scoped test selection and mutation
   grouping require abandoning validation-only `--dry-run`.** They don't — both need a
   live org to query or verify against, not a different execution model. Only the
   upstream project's org-mutate-and-restore execution and its paid third-party
   local-runtime integration actually require that. Rewrote the "Recommendation"
   section in `docs/COMPARISON.md` to separate these two categories explicitly.
4. **Source citations now pin permalinks** to the exact evaluated commit
   (`c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc`) with line numbers, instead of bare
   repo-relative paths.
5. **The "no `SIGINT`/`SIGTERM` handler" finding is now explicitly labeled as static
   source analysis** (`grep -rn "SIGINT\|SIGTERM\|process.on(" src` → no matches), not
   reproduced live behavior. No org was available to actually interrupt a live run of
   the upstream tool and observe the result.
6. **Chronology correction — this is the one to read carefully.** Checkpoint 3's
   `HANDOFF.md`/`REVIEW-NOTES.md` described the npm-bin symlink guard bug as if it were
   found in pre-existing code ("the original direct-execution guard compared..."). This
   was inaccurate. Checkpoint 2's actual shipped code (commit `1733b7f`) had **no
   execution guard at all** — `main()` ran unconditionally at the bottom of `cli.ts`,
   which was always correct for the installed npm bin (there was nothing to guard
   against), just not unit-testable, since importing the module for a test would also
   run `main()` against real `process.argv`. During checkpoint 3, adding
   `main(argv, validate)` for in-process CLI testing required introducing a guard so
   that importing the module in a test harness wouldn't also execute it — the first
   version of that new guard (a raw `import.meta.url` string comparison) was itself
   broken for the npm-installed-symlink case. This was caught via a real
   `npm pack` + install smoke test and fixed before commit `af8bf94` was ever created —
   that commit's diff already contains the fixed version; the broken intermediate
   version existed only in local, uncommitted edits and was never pushed. So: this was a
   bug Claude introduced as a side effect of adding testability, and fixed, within the
   same checkpoint — not a latent defect inherited from checkpoint 2 that was merely
   discovered. The commit message for `af8bf94` (already pushed, not rewritten per this
   project's no-history-rewrite policy) reads ambiguously on this point ("fix the
   direct-execution guard... the previous guard broke...") and could be misread the same
   way; this file and `HANDOFF.md` are the corrected record.
7. **Softened an absolute claim in `README.md`.** "Your own project files are never
   edited" was stated unqualified in the "How it works" section. This is misleading
   given (a) `plan`/`run` intentionally write output artifacts inside the project by
   default, and (b) the blocker above was a real, demonstrated counterexample to an
   unqualified version of that claim. Reworded to state precisely what's guaranteed
   (Apex source under package directories is never touched by the mutation/validation
   process; output writes are atomic and replace rather than follow a pre-existing
   symlink at the destination) instead of an unconditional "nothing is ever written."

## Commit this checkpoint

Starting point: `ea3958a` (checkpoint 3, on `origin/main` before this session resumed).
This checkpoint's fix, tests, and doc corrections are pushed as a single commit on top
of it (`git log` on `main` has the authoritative hash), preceded by
`gh api user --jq .login` confirming `JoshuaStorm1017` as usual.

## Known limitations (unchanged, repeated for review convenience)

- No live Salesforce org or CLI has ever been used to verify anything in this
  repository. Every "verified" claim is injected-validator or fake-subprocess-based.
- Windows support for `run` is undetermined (documented, sourced reason given in
  README, not an unverified claim either way).
- Coverage-scoped test selection and mutation grouping are not implemented; both are
  compatible with validation-only in principle but need a live org to build and verify
  correctly (corrected framing this checkpoint, see `docs/COMPARISON.md`).
- This checkpoint's fix addresses the specific symlink-following vulnerability Codex
  found in `plan.json`/report output writing and the lexical-only `--output` package-dir
  check. It does not constitute a general filesystem-security audit of this codebase;
  no claim is made that no other local-path issue exists anywhere else in it.

## Risky decisions that need Codex's judgment, not just review

1. **Scope of the symlink fix.** I fixed the two specific paths Codex identified
   (`plan.json` writing, and the `--output` package-directory-escape check) plus
   extended the same protection to `report.json`/`report.html` (which already used the
   safe pattern, now via the shared helper). I did not attempt a broader audit for
   every place this codebase touches the filesystem with a user-influenced path — for
   example, `snapshotProject`'s writes go into a freshly `mkdtemp`'d directory with a
   random name, which I judged sufficiently low-risk to leave out of scope (an attacker
   would need to predict or race a fresh random temp directory name to plant a symlink
   in it first), but that judgment wasn't re-verified with the same rigor as the fix
   above.
2. **`resolveRealPath`'s recursive-ancestor-walk approach.** For a not-yet-existing
   `--output` path, it walks up parents until it finds one that exists, resolves that,
   and appends the rest literally. This assumes nothing under the not-yet-existing
   remainder can itself be a symlink at the time of the check — true at check time by
   definition (those paths don't exist yet), but there is a theoretical TOCTOU gap
   between this check and the later `mkdir(..., { recursive: true })` inside
   `writeFileAtomic` if something else creates a symlink there in between. I judged this
   an acceptable, standard TOCTOU tradeoff (the same class of gap exists in most
   path-validation code that doesn't hold a directory file descriptor open throughout),
   not something to engineer around with `O_NOFOLLOW`-style primitives for a CLI tool
   at this stage, but that's a judgment call, not a proof of safety.
3. **Chronology correction's honesty vs. the already-pushed commit message.** I did not
   amend or rewrite commit `af8bf94`'s message (per this project's git-safety rules:
   never amend a published commit). The corrected chronology lives only in this file and
   `HANDOFF.md`, both current-state documents, not in git history itself. If Codex or
   the owner would prefer a more permanent correction (e.g., a follow-up commit whose
   message explicitly references and clarifies `af8bf94`), that's a call for them, not
   something I did unilaterally.
