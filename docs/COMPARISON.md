# Comparison: apex-mutant vs. scolladon/apex-mutation-testing

Evaluated commit: [`c3f95db`](https://github.com/scolladon/apex-mutation-testing/commit/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc) (2026-08-25), package version `1.9.1`, license MIT. Every source link below is pinned to that exact commit, so it still points at the code actually read even after their `main` branch moves on.

Method: cloned the repo into an isolated temporary directory (never merged into this
repository's working tree or git history), read its source and README, and ran its
documented offline unit suite there. No source from that project was copied into this
one; every claim below is a citation with a permalink or quote, not reused code.

```
npm ci --ignore-scripts && npm run compile
npx vitest run --config vitest.config.ts
# → Test Files  103 passed (103); Tests  2136 passed (2136)
```

That confirms the project has a large, fully offline, passing unit suite (no real org
needed to verify most of its logic) — a genuine maturity signal independent of anything
that requires an org.

## What it is

An `sf` CLI plugin (`sf apex mutation test run`) that mutates a **live Apex class body in
the target org** via the Tooling API, runs tests, then restores the original body. This
repository (`apex-mutant`) is a standalone CLI that only ever calls
`sf project deploy start --dry-run`; it never edits an org's real metadata. That single
architectural choice — org-mutate-and-restore vs. validation-only dry-run — explains most
of the differences below and is not a bug on either side; it is a different bet on the
safety/speed tradeoff.

## Verified vs. claimed

| Claim (their README) | Verified? | Evidence |
| --- | --- | --- |
| Mutation grouping via graph coloring reduces deploy/test-run calls | **Verified as designed**, not benchmarked here (needs an org) | [`src/service/mutationGrouper.ts`](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/service/mutationGrouper.ts), [`exactColoring.ts`](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/service/exactColoring.ts), [`groupExecutor.ts`](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/service/groupExecutor.ts); [README "Mutation Grouping"](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/README.md#L369) describes a lower-bound clique + DSATUR + exact backtracking pipeline, with automatic per-mutant fallback "if a batched deploy or test run fails" |
| Local execution against `aer server` needs no org | **Verified as documented, with a caveat they disclose themselves** | [README "Local Execution With aer"](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/README.md#L183): `aer` is a **separate paid product** from October Swimmer (aertest.com); [line 237](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/README.md#L237) says `aer server` "requires an aer licence... without one the server stops after five minutes." Parity with a real org is asserted only "on one fixture," not guaranteed generally |
| Per-test coverage strategy narrows which tests run per mutant | **Verified in source** | [`orgMutationTestBed.ts` lines 50–52](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/adapter/org/orgMutationTestBed.ts#L50-L52) selects `PerTestCoverageStrategy` or `AggregateCoverageStrategy` based on the org's `ApexSettings.IsAggregateCodeCoverageOnlyEnabled` |
| "22 mutation operators" (their README's flag-name count is not stated as a total; this was *my* earlier claim in this document, and it was wrong) | **Corrected: 26, not 22** | [`src/mutator/`](https://github.com/scolladon/apex-mutation-testing/tree/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/mutator) has 30 `.ts` files; 4 are shared helpers, not operators (`astUtils.ts`, `baseListener.ts`, `baseReturnMutator.ts`, `mutationListener.ts`), leaving 26 operator implementations. Cross-checked directly against the [operator table](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/README.md#L417) in their README, which has exactly 26 rows (`grep -c '^| \*\*' README.md` → 26). The original version of this document said 22 and listed all 26 names underneath it — an internal inconsistency a reader should have caught immediately; corrected here. |

## Genuine differences (not claims, direct source reading)

### Execution model and interruption safety

Their [`OrgMutationTestBed.evaluate()`](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/adapter/org/orgMutationTestBed.ts#L61-L82) deploys the
mutated class body directly into the org, runs tests, and a later `restore()` redeploys the
original. [`mutationTestingService.ts` line 821](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/service/mutationTestingService.ts#L821) wraps the mutation loop in explicit rollback handling
("the restore must survive every exit of the loop") and if the
rollback itself fails, [it warns](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/src/service/mutationTestingService.ts#L911): `"Rollback FAILED — '<class>' remains in a mutated state on
the target org. Redeploy the original class manually."` — an honest, well-engineered
admission that the failure mode exists.

**Static-analysis finding, not a reproduced live behavior:** searching their `src/` tree for
`SIGINT`/`SIGTERM`/`process.on(` returns zero matches (`grep -rn "SIGINT\|SIGTERM\|process.on("
src`, exit code 1). No Salesforce org was available to actually run their plugin, hit
`Ctrl+C` mid-run, and observe the org's resulting state — this is an inference from the
*absence* of a pattern in their source, not something reproduced end-to-end. Taken at face
value, it means there is no process-level signal handler positioned to trigger the rollback
path above on an interrupt, so a `Ctrl+C` (or any hard kill) during a run has no code path in
this codebase that would run it. Whether some other layer (a wrapping shell, an oclif
lifecycle hook not visible from a plain grep, etc.) mitigates this in practice was not
checked and is not claimed here either way.

By contrast, this repository's `runner.ts` never writes to the org, and applies every
mutation only to a throwaway temp-directory snapshot (`snapshotProject`) that is deleted in
a `finally` block regardless of success, validator failure, or `AbortSignal` cancellation
(see `test/runner.test.ts`, "aborting mid-run... still cleans up"), and `cli.ts` explicitly
wires `SIGINT`/`SIGTERM` to a graceful abort. There is no comparable *org-state* exposure
here, because there is no live org state to restore in the first place — see the note below
on this repository's own output-path safety history before treating that as an unqualified
"we're safer" claim.

**This is the clearest safety differentiator on the org-state axis specifically**, and it is
a direct consequence of validation-only `--dry-run` never being a deploy in the first place.
It says nothing about local-filesystem safety in either tool, which is a separate concern —
see `HANDOFF.md`/`REVIEW-NOTES.md` for a local output-path vulnerability found and fixed in
*this* repository during the same review pass that produced this document, and note that no
equivalent audit of their local file-handling was performed here.

### Result classification and score integrity

Their README documents: [`Score = (Killed + RuntimeError) / (Killed + RuntimeError +
Survived + NoCoverage) * 100`](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/README.md#L495), and explicitly at
[line 480](https://github.com/scolladon/apex-mutation-testing/blob/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc/README.md#L480): *"RuntimeError... still counts as a kill in
the score."* A `RuntimeError` is any org/network/auth failure the plugin cannot attribute to
a compile error. Concretely: a flaky org connection or an expired session during a run
can silently **raise** the reported mutation score, because errors count toward the
numerator as if a test had caught the mutation.

This repository's `docs/ARCHITECTURE.md` states the opposite contract: *"Invalid/timeouts/errors
are excluded and reported visibly; incomplete execution must fail CI independently of
score... No valid mutants means score unavailable, never 100 percent."* `report.ts`'s
`summarize()` and `reportExitCode()` enforce this: `error` and `timeout` outcomes are
excluded from the score denominator entirely and independently force a non-zero exit code
(see `test/report.test.ts`).

Neither behavior is "wrong" in isolation — theirs optimizes for not stalling a report on
infrastructure noise; ours optimizes for a CI gate that can never be tricked by a flaky
org — but the difference is real, is not disclosed as a tradeoff in their README, and is
worth knowing before wiring either tool into a merge gate.

### Coverage/test selection and mutation grouping — compatible with validation-only, not implemented here

Theirs: queries the org for which tests cover each mutated line and runs only that subset
per mutant, and (optionally) batches independent mutations into a single deploy+test-run
via the graph-coloring pipeline cited above. Ours: `runner.ts` runs the full
operator-supplied `--tests` list against every single mutant, unconditionally, one mutant
per `--dry-run` deploy.

**Neither of these requires abandoning a validation-only architecture.** Reading which tests
cover a line, and submitting one `--dry-run` deploy containing several independent mutated
files instead of one, are both things a dry-run-only tool could do — they need a live org to
*query* (coverage data) or to *verify against* (that a batched dry-run deploy still classifies
correctly), which this environment does not have, not a change from validation-only to
deploy-and-restore. This document's earlier draft implied otherwise by discussing them in the
same "reaching feature parity" paragraph as their org-mutate-and-restore execution model and
their paid third-party local-runtime integration — those two *do* require a different
execution model or a dependency this project doesn't want; coverage selection and grouping do
not. See "Recommendation" below for the corrected framing.

### Reports

Theirs uses `mutation-testing-elements` (the shared Stryker-ecosystem report web
component) — a richer, interactive, industry-recognized UI, at the cost of an external
dependency. Ours (`report.ts`) renders a single self-contained HTML file with an explicit
`Content-Security-Policy: script-src 'none'` — no external assets, nothing to fetch, safe to
open from an offline/air-gapped machine. Different design goals (richness vs. zero external
surface); neither is strictly better.

### Maintenance

Theirs: published to npm as `apex-mutation-testing`, weekly-or-faster releases per
`CHANGELOG.md` (five releases from `1.7.4` to `1.9.1` in the three weeks before the
evaluated commit), a public performance-benchmark dashboard, GitHub Sponsors, and a real
issue tracker referenced throughout the changelog. Ours: a brand-new alpha. This is not a
code-quality claim — it is a straightforward maturity/adoption gap that time, not
architecture, would close.

### License

Both MIT. No attribution obligation beyond the standard MIT notice, and this evaluation
did not copy any of their source, so no attribution requirement was triggered. Do not
copy their mutator implementations verbatim into this repository even under MIT without
adding the required copyright notice to whatever file carries it.

## Recommendation: differentiate, don't duplicate

Reaching feature parity on the parts that genuinely require abandoning validation-only —
org-mutate-and-restore execution, and a paid third-party local-runtime integration — would
mean giving up this project's actual selling point: that it **never deploys to a real org**.
That is not a good use of effort and directly contradicts this repository's own architecture
contract (`AGENTS.md`: *"Never add a deploy/quick-deploy fallback"*).

Coverage-scoped test selection, mutation grouping, and a larger operator set are a different
category: all three are **architecturally compatible** with validation-only `--dry-run`, as
explained above. They are not implemented here because they either need org access to verify
safely (coverage/grouping) or were simply not attempted yet (more operators), not because the
architecture rules them out.

- **Implemented now**: two additional pure AST-based mutation operators
  (`increment-decrement`, `unary-negation-removal` — see `HANDOFF.md`), because these need no
  org access, use the existing single-token parser-visitor pattern, and directly narrow the
  operator-count gap. Note: an earlier draft of this document also listed
  "arithmetic-operator deletion" as implemented here — it was not; that operator (removing an
  arithmetic operator and keeping one operand, e.g. `a + b` → `a`) needs a multi-token span
  edit that the current `add()` helper doesn't support, and was correctly deferred, just
  incorrectly described as done.
- **Not implemented, but compatible with validation-only and worth building next**:
  coverage-scoped test selection and mutation grouping. Both need a live org to implement
  and verify correctly (coverage queries; confirming a batched dry-run deploy still
  classifies mutants correctly) — recommended as the top priority once org access exists.
  Grouping in particular is a real performance lever this project currently has zero
  equivalent of, and nothing about it requires deploying mutated code for real.
- **Deliberately not adopted**: counting `error`/`timeout` toward the score numerator. This
  repository's stricter exclusion is a considered design choice recorded in
  `docs/ARCHITECTURE.md`, not an oversight, and should stay that way for CI-gating use cases.
- **Contribution angle worth considering** (not done here, out of scope for this pass): the
  interruption-safety observation above (no `SIGINT`/`SIGTERM` handler found around their org
  rollback) is concrete, sourced, and reproducible by anyone from public source — but it was
  never verified against a live run, only inferred from a grep. Confirming it end-to-end
  before filing it upstream would be the responsible next step, and would be more valuable to
  the ecosystem than silently duplicating their org-mutate-and-restore design in this
  repository.
