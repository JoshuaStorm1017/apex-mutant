# Comparison: apex-mutant vs. scolladon/apex-mutation-testing

Evaluated commit: [`c3f95db`](https://github.com/scolladon/apex-mutation-testing/commit/c3f95dbe9fbfd7e4c68c1efe873996fdfe455abc) (2026-08-25), package version `1.9.1`, license MIT.

Method: cloned the repo into an isolated temporary directory (never merged into this
repository's working tree or git history), read its source and README, and ran its
documented offline unit suite there. No source from that project was copied into this
one; every claim below is a citation with a path or quote, not reused code.

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
| Mutation grouping via graph coloring reduces deploy/test-run calls | **Verified as designed**, not benchmarked here (needs an org) | `src/service/mutationGrouper.ts`, `src/service/exactColoring.ts`, `src/service/groupExecutor.ts`; README "Mutation Grouping" section describes a lower-bound clique + DSATUR + exact backtracking pipeline, with automatic per-mutant fallback "if a batched deploy or test run fails" |
| Local execution against `aer server` needs no org | **Verified as documented, with a caveat they disclose themselves** | README "Local Execution With aer": `aer` is a **separate paid product** from October Swimmer (aertest.com); `aer server` "requires an aer licence... without one the server stops after five minutes." Parity with a real org is asserted only "on one fixture," not guaranteed generally |
| Per-test coverage strategy narrows which tests run per mutant | **Verified in source** | `src/adapter/org/orgMutationTestBed.ts` selects `PerTestCoverageStrategy` or `AggregateCoverageStrategy` based on the org's `ApexSettings.IsAggregateCodeCoverageOnlyEnabled`, and `getTestMethodsPerLines` narrows tests to those covering the mutated line |
| 22 mutation operators | **Verified by file count** | 22 files under `src/mutator/`, cross-checked against the operator table in README (ArgumentPropagation, ArithmeticOperator[Deletion], BitwiseOperator, BoundaryCondition, ConstructorCall, EmptyReturn, EqualityCondition, ExperimentalSwitch, FalseReturn, Increment, InlineConstant, InvertNegatives, LogicalOperator[Deletion], MemberVariable, NakedReceiver, Negation, NonVoidMethodCall, NullReturn, RemoveConditionals, RemoveIncrements, Switch, TrueReturn, UnaryOperatorInsertion, VoidMethodCall) |

## Genuine differences (not claims, direct source reading)

### Execution model and interruption safety

Their `OrgMutationTestBed.evaluate()` (`src/adapter/org/orgMutationTestBed.ts`) deploys the
mutated class body directly into the org, runs tests, and a later `restore()` redeploys the
original. `mutationTestingService.ts` wraps the mutation loop in explicit rollback handling
(comments there: "The org holds a mutated body from the first group deploy until rollback
redeploys the original, so the restore must survive every exit of the loop") and if the
rollback itself fails, it warns: `"Rollback FAILED — '<class>' remains in a mutated state on
the target org. Redeploy the original class manually."` — an honest, well-engineered
admission that the failure mode exists.

Searching their `src/` tree for `SIGINT`/`SIGTERM`/`process.on(` returns **no matches**:
there is no signal handler, so a `Ctrl+C` (or any hard kill) during a run has no
process-level path to trigger that rollback, and can leave the org's real Apex class body
mutated until the next manual or automated redeploy.

By contrast, this repository's `runner.ts` never writes to the org or to the real project
directory at all — every mutation is applied to a throwaway temp-directory snapshot
(`snapshotProject`) that is deleted in a `finally` block regardless of success, validator
failure, or `AbortSignal` cancellation (see `test/runner.test.ts`, "aborting mid-run...
still cleans up"), and `cli.ts` explicitly wires `SIGINT`/`SIGTERM` to a graceful abort.
There is no comparable exposure here because there is nothing live to restore.

**This is the single clearest safety differentiator in either direction**, and it is a
direct consequence of validation-only `--dry-run` never being a deploy in the first place.

### Result classification and score integrity

Their README documents: `Score = (Killed + RuntimeError) / (Killed + RuntimeError +
Survived + NoCoverage) * 100`, and explicitly: *"RuntimeError... still counts as a kill in
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

### Coverage/test selection

Theirs: queries the org for which tests cover each mutated line and runs only that subset
per mutant (falling back to aggregate/all-tests mode automatically when the org has
"Store Only Aggregated Code Coverage" enabled). Ours: `runner.ts` runs the full
operator-supplied `--tests` list against every single mutant, unconditionally. This is a
genuine, verified gap — their approach is strictly cheaper per mutant when coverage data
is available, at the cost of depending on the org's coverage data being trustworthy and
current.

### Reports

Theirs uses `mutation-testing-elements` (the shared Stryker-ecosystem report web
component) — a richer, interactive, industry-recognized UI, at the cost of an external
dependency. Ours (`report.ts`) renders a single self-contained HTML file with an explicit
`Content-Security-Policy: script-src 'none'` and a footer warning that the file "contains
source snippets; keep it private" — no external assets, nothing to fetch, safe to open
from an offline/air-gapped machine. Different design goals (richness vs. zero external
surface); neither is strictly better.

### Maintenance

Theirs: published to npm as `apex-mutation-testing`, weekly-or-faster releases per
`CHANGELOG.md` (five releases from `1.7.4` to `1.9.1` in the three weeks before the
evaluated commit), a public performance-benchmark dashboard, GitHub Sponsors, and a real
issue tracker referenced throughout the changelog. Ours: a brand-new alpha with two
pre-existing commits plus this integration pass. This is not a code-quality claim — it is
a straightforward maturity/adoption gap that time, not architecture, would close.

### License

Both MIT. No attribution obligation beyond the standard MIT notice, and this evaluation
did not copy any of their source, so no attribution requirement was triggered. Do not
copy their mutator implementations verbatim into this repository even under MIT without
adding the required copyright notice to whatever file carries it.

## Recommendation: differentiate, don't duplicate

Reaching feature parity (22 operators, org-mutate-and-restore execution, coverage-scoped
test selection, graph-coloring-based grouping, a third-party local runtime integration)
would mean abandoning this project's actual selling point — that it **never touches a
real org's metadata** — in favor of re-implementing a mature, actively-maintained,
differently-architected tool from scratch. That is not a good use of effort and directly
contradicts this repository's own architecture contract
(`AGENTS.md`: *"Never add a deploy/quick-deploy fallback"*).

The justified path is to keep the validation-only safety property as the core
differentiator (it is verifiably real, per the interruption-safety analysis above) and
close the gaps that do not require compromising it:

- **Implemented now**: a small set of additional pure AST-based mutation operators
  (increment/decrement, unary negation removal, arithmetic-operator deletion — see
  `HANDOFF.md` for the exact list), because these need no org access, use the existing
  parser-visitor pattern, and directly narrow the biggest verified gap (operator count).
- **Not implemented, and why**: coverage-scoped test selection and mutation grouping both
  require live org queries (`ApexCodeCoverage`, `ApexSettings`) that cannot be exercised or
  verified without a disposable org, which this environment does not have. Recommended as
  the top priority for whoever picks this up next once org access exists — grouping in
  particular is a real performance lever we currently have zero equivalent of.
- **Deliberately not adopted**: counting `error`/`timeout` toward the score numerator. This
  repository's stricter exclusion is a considered design choice recorded in
  `docs/ARCHITECTURE.md`, not an oversight, and should stay that way for CI-gating use cases.
- **Contribution angle worth considering** (not done here, out of scope for this pass):
  their interruption-safety gap (no `SIGINT`/`SIGTERM` handler around the org rollback) is
  concrete and reproducible from public source; filing it as an upstream issue would be
  more valuable to the ecosystem than silently duplicating their org-mutate-and-restore
  design in this repository.
