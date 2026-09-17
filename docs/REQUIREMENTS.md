# Requirements traceability and open gaps

This document exists to answer one question for a reviewer: *for each requirement this
tool claims to meet, where is it implemented and which test proves it?* Requirements are
written generically — they are engineering criteria for an Apex mutation-testing tool,
not any organization's internal policy.

Status values are deliberately strict:

- **Implemented** — in the product and covered by an automated test that fails if the
  behavior regresses.
- **Partial** — the mechanism exists but does not fully satisfy the requirement; the gap
  is stated.
- **Gap** — not implemented; a proposed acceptance test is given below.
- **Pending pilot** — cannot be satisfied without a live, authorized Salesforce org. No
  org has ever been available to this repository (see `HANDOFF.md`).

## P1 — required before this tool's output can be trusted as evidence

| # | Requirement | Status | Implementation | Acceptance test |
| --- | --- | --- | --- | --- |
| 1 | The first operating mode is baseline + advisory reporting: a mutation score never fails a build on its own | Implemented | `reportExitCode` in `src/report.ts`; `ADVISORY_POLICY` in `src/types.ts`; default policy in `src/runner.ts` | `test/report.test.ts` "reportExitCode: 2 when the run produced no readable result; the score only gates the exit code in enforce mode"; `test/cli.test.ts` "the score only gates the exit code under `--enforce`…" |
| 2 | Enforcement is explicit on both halves: no implied threshold, no silently inert threshold | Implemented | `--enforce`/`--threshold` handling in `src/cli.ts`; `assertPolicy` in `src/runner.ts` | `test/cli.test.ts` (rejects `--threshold` alone and `--enforce` alone); `test/runner.test.ts` "rejects an invalid policy or work item before doing any work" |
| 3 | Machine-readable output cannot fail a pipeline by itself | Implemented | `sarifLevel` in `src/exports.ts` — never `error`, only `note` in advisory mode | `test/exports.test.ts` "SARIF … never emits an error level" and the `--enforce` warning case |
| 4 | Mutant source is only ever sent to a disposable org (sandbox/scratch), with no override | Implemented | `src/orgSafety.ts`; enforced in `src/cli.ts` before any snapshot is sent | `test/orgSafety.test.ts` (production, sandbox, scratch, missing, malformed, timeout) |
| 5 | Execution is validation-only; nothing is deployed | Implemented (offline evidence) | `validateWithSalesforce` in `src/salesforce.ts` (`--dry-run`, no deploy path exists) | `test/salesforce.test.ts`, including a real local fake-`sf` subprocess asserting the exact argv |
| 6 | The run records the safeguards it actually enforced, rather than restating documentation | Implemented | `RunSafeguards` in `src/types.ts`; populated in `src/runner.ts`; rendered by `src/report.ts` and `src/exports.ts` | `test/runner.test.ts` "records advisory mode, traceability, and un-attested validator evidence"; `test/cli.test.ts` "records the org classification it enforced…" |
| 7 | A claim the tool cannot verify is never asserted (fail closed) | Implemented | `validationOnly` defaults to `false` for caller-supplied validators (`src/runner.ts`); `verifySourceIntegrity` returns `verified: false` rather than `unchanged: true` when it cannot check (`src/project.ts`) | `test/runner.test.ts` "source integrity is verified against the real project files and reported as unproven when it cannot be" |
| 8 | Local source is provably unchanged after a run | Implemented | `verifySourceIntegrity` in `src/project.ts`, called at the end of every run | `test/runner.test.ts` (unchanged case, and a case where a file *is* changed mid-run and the report says so) |
| 9 | Results drive specific test improvements, not just a score | Implemented | `src/findings.ts` — per-operator behavior explanation and suggested assertion, per-location | `test/findings.test.ts` "a surviving mutant becomes a located, actionable test-gap finding"; `test/cli.test.ts` "run prints the advisory notice and the highest-priority findings…" |
| 10 | Mutants that prove nothing (invalid/timeout/error) are never presented as test gaps | Implemented | `buildFindings` separates `unproven-mutant` and `run-quality` categories (`src/findings.ts`); the score already excludes them (`summarize` in `src/report.ts`) | `test/findings.test.ts` "mutants with no test evidence are separated from real gaps"; `test/report.test.ts` summarize/exit-code cases |
| 11 | Results are exportable and traceable to a work item | Implemented | `src/exports.ts` (`csv`, `sarif`, `md`); `--work-item` in `src/cli.ts`; `Traceability` in `src/types.ts` | `test/exports.test.ts` (all formats); `test/cli.test.ts` "`--export` and `--work-item` produce portable artifacts carrying the work item" |
| 12 | Exports cannot execute in the tools that open them | Implemented | `csvCell` formula-injection defusal and strict work-item validation in `src/exports.ts`; existing HTML escaping + CSP in `src/report.ts` | `test/exports.test.ts` (formula injection, embedded quotes/newlines, invalid work items); `test/report.test.ts` (HTML escaping) |
| 13 | The report states what mutation testing does **not** cover | Implemented | `SCOPE_STATEMENT` in `src/policy.ts`, rendered in HTML and Markdown | `test/report.test.ts` "renderHtml states the operating mode, the scope of the evidence, and the enforcement-readiness checklist"; `test/exports.test.ts` (Markdown export contents) |
| 14 | The evidence required before enforcing a score in CI is stated, not assumed | Implemented | `ENFORCEMENT_READINESS` in `src/policy.ts`, rendered in HTML, Markdown, and `report.json` | `test/report.test.ts` (checklist items in the HTML); `test/exports.test.ts` (checklist in Markdown); `test/cli.test.ts` (present in a real run's report) |
| 15 | Known-equivalent mutants can be recorded and excluded | **Gap** | Heuristic only today: `equivalenceRisk` per operator class in `src/findings.ts`. There is no suppression file, so an equivalent mutant re-appears in every run and permanently caps the score | Proposed below (G1) |
| 16 | Runtime of a full run on a real codebase is known | **Pending pilot** | `durationMs` per result is recorded (`src/salesforce.ts`); `doctor` estimates the number of validations | Proposed below (G2) — needs a live org |
| 17 | Run-to-run stability (same source ⇒ same outcomes) is demonstrated | **Gap** (offline) / **Pending pilot** (live) | Mutation generation is deterministic (content-derived IDs, `src/mutations.ts`); end-to-end stability across repeated runs is untested | Proposed below (G3) |
| 18 | The live `sf project deploy start --dry-run` JSON contract is verified against a real org | **Pending pilot** | `parseSalesforceResult` in `src/salesforce.ts` | `docs/TECHNICAL-REVIEW.md`'s synthetic pilot recipe, unchanged |

## P2 — improves cost, scope control, and adoption

| # | Requirement | Status | Implementation | Acceptance test |
| --- | --- | --- | --- | --- |
| 19 | Run cost is bounded and predictable before starting | Implemented | `--max-mutants`, `--include`/`--exclude`/`--operators` (`src/project.ts`); `doctor`'s estimated run cost (`src/cli.ts`) | `test/project.test.ts`, `test/cli.test.ts` (doctor output) |
| 20 | An interrupted run leaves usable results | Implemented | Incremental `writeReport` after every mutant; `SIGINT`/`SIGTERM` handling and exit code 130 (`src/runner.ts`, `src/cli.ts`) | `test/runner.test.ts` (abort cases), `test/cli.test.ts` |
| 21 | An interrupted run can resume without re-validating finished mutants | **Gap** | Not implemented | Proposed below (G4) |
| 22 | Test selection is scoped by coverage rather than caller-specified classes | **Gap** / **Pending pilot** | Not implemented; needs org coverage data (see `docs/COMPARISON.md`) | Proposed below (G5) |
| 23 | Mutants can be grouped to reduce validation count | **Gap** / **Pending pilot** | Not implemented; deliberately deferred until a live baseline exists to measure against | — (depends on G2's measurements) |
| 24 | Native Windows is either supported or refused clearly | Implemented (simulated) | Early refusal for `run` in `src/cli.ts`; `plan`/`doctor` unaffected | `test/cli.test.ts` with a simulated `process.platform`; a real Windows run remains unverified |

## Open gaps, with the acceptance test each one needs

**G1 — equivalent-mutant suppression.** Add a project-local suppression list (mutation ID
plus a required human-supplied reason), applied when findings are derived and reported
as a distinct `suppressed` count so the score's denominator change is visible rather than
silent. *Acceptance test:* a run whose suppression file names a surviving mutant reports
that mutant as suppressed with its reason, excludes it from the score's denominator,
still lists it in the report, and rejects a suppression entry with no reason or an ID
that matches nothing in the current plan (a stale suppression must not silently pass).

**G2 — runtime and cost measurement.** *Acceptance test (needs a live org):* a full run on
a known project records per-mutant `durationMs` and a total wall-clock figure in the
report, and the figures are reproduced within a stated tolerance on a second run. This is
the evidence item "Runtime" in the readiness checklist.

**G3 — stability across repeated runs.** *Acceptance test (offline part):* two runs over
the same project with the same injected validator produce identical mutation IDs,
identical outcome sequences, and identical findings, differing only in `runId` and
timestamps. *Acceptance test (live part):* the same two-run comparison against a real org,
with any differing mutant identified explicitly rather than averaged away.

**G4 — resumable runs.** *Acceptance test:* a run interrupted after N mutants, restarted
with `--resume`, re-validates only the remaining mutants, refuses to resume when the
source has changed since the interrupted run (the mutation IDs are content-derived, so
this is detectable), and produces a report identical to an uninterrupted run.

**G5 — coverage-scoped test selection.** *Acceptance test (needs a live org):* for a mutant
in a class covered by a known subset of tests, the run selects that subset, reports which
tests it selected and why, and falls back to the caller-specified tests — loudly — when
coverage data is unavailable or stale.

## How to keep this document honest

Every row above names a file and a test. If you change behavior, change the row. If a row
has no test, it is a gap, not an implementation — say so here before saying otherwise
anywhere else.
