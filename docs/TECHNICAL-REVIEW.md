# Technical review brief: Apex Mutant

This is a generic, tool-focused technical brief for anyone evaluating whether to pilot
this open-source CLI — a security/architecture reviewer, a platform team, a technical
review committee at any organization. It makes no claim about, and is not written for,
any specific employer, company, or named review body; nothing here reflects internal
policy of any organization other than what's stated in this public repository's own
files (`AGENTS.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`).

Covers `apex-mutant@0.1.0-alpha.2` ([release](https://github.com/JoshuaStorm1017/apex-mutant/releases/tag/v0.1.0-alpha.2)).
Every claim below is either independently verifiable from this public repository or
explicitly marked as not yet verified — nothing here is asserted without a way to check it.

## What it is, in one paragraph

A command-line tool that parses your Apex source, generates small syntactic mutations
(e.g. `<` → `<=`), and validates each one — plus an unmutated baseline — against a
Salesforce org using `sf project deploy start --dry-run`. It reports which mutants your
tests caught ("killed") and which they missed ("survived"), producing a mutation score
that measures test *effectiveness*, not just code coverage. It never deploys anything
for real: every request is validation-only, and refuses to run at all against anything
the Salesforce CLI doesn't classify as a sandbox or scratch org.

Its default operating mode is advisory: it reports a score, prioritized findings with a
suggested assertion for each surviving mutant, and a record of the safeguards it
enforced — and it does not fail anything. Gating on the score requires an explicit
`--enforce` and an explicit `--threshold`, and every report carries the checklist of
evidence a team should gather from its own runs first. `docs/REQUIREMENTS.md` maps each
requirement to the code that implements it and the test that proves it, and lists what
is still a gap.

## Why a CLI/npm package, not a managed Salesforce package

A managed package installs Apex classes *into* an org — that's the wrong shape for this
tool, for two reasons. First, mutation testing needs to generate and evaluate many
*variants* of your source outside the org (this tool's engine does that with a
JavaScript/TypeScript-based Apex parser, entirely locally); an in-org package can't
easily manufacture and discard hundreds of temporary code variants without either
polluting the org's metadata or requiring exactly the kind of deploy cycle this tool is
built to avoid running for real. Second, a managed package would need to *live* in the
org to run tests against it, which means its own code becomes part of the org's
metadata footprint and audit surface — a CLI that runs from the developer's or CI
runner's machine, using their own already-authenticated Salesforce CLI session and
credentials, never adds anything to the org at all, managed or otherwise. The tradeoff
is that a CLI must be installed per-machine/per-CI-runner rather than once per org; see
"Install / uninstall" below for exactly what that involves.

## Architecture and data flow

```
Local machine                                    Salesforce
┌─────────────────────────────┐                  ┌──────────────────┐
│ Your Apex source (on disk)  │                  │                  │
│        │                    │                  │                  │
│        ▼                    │                  │                  │
│ [parse + mutate]  (offline, │                  │                  │
│  no network — this is the   │                  │                  │
│  entire `plan` command)     │                  │                  │
│        │                    │                  │                  │
│        ▼                    │                  │                  │
│ isolated temp snapshot dir  │                  │                  │
│ (Apex-only; see below)      │                  │                  │
│        │                    │   sf CLI, using  │                  │
│        ▼                    │   your existing  │                  │
│ Salesforce CLI subprocess ──┼─────────────────▶│ target org       │
│ (`sf`, already installed &  │  auth (this tool │ (sandbox/scratch │
│  authenticated by you —     │  never sees or    │  only — enforced)│
│  this tool holds no creds)  │  stores creds)    │                  │
│        ◀────────────────────┼───────────────────│                  │
│  structured JSON result     │                  │                  │
│        │                    │                  │                  │
│        ▼                    │                  │                  │
│ report.json / report.html   │                  │                  │
│ (local disk only)           │                  │                  │
└─────────────────────────────┘                  └──────────────────┘
```

- **Local source → local mutation generation.** `plan` (and the planning phase of
  `run`) never touches the network. The parser is `@apexdevtools/apex-parser`
  (BSD-3-Clause, MIT-compatible), run entirely in-process.
- **Existing `sf` credentials → selected org only.** This tool never has its own
  Salesforce credentials, never prompts for login, and never stores or transmits an
  access token. It shells out to whatever `sf` CLI is already installed and
  authenticated on the machine, exactly as if you'd typed the command yourself, and
  only against the `--target-org` alias you explicitly pass.
- **Reports are local-only.** `report.json`/`report.html` are written to disk
  (`--output`, default `.apex-mutant/`) and never uploaded anywhere by this tool. See
  `SECURITY.md` for exactly what they contain (structured outcomes and your own source
  snippets, never raw CLI output or org identifiers).
- **Registry access happens only at install time**, exactly like any other npm
  package — resolving `@apexdevtools/apex-parser` and its own dependency
  (`antlr4`) from the npm registry (or from a downloaded release tarball, which needs no
  registry access for `apex-mutant` itself; its production dependencies are still
  resolved from the registry unless bundled/vendored, which this project does not do).
  There is no other registry or network access at any other time.
- **No product telemetry.** Verified by inspection, not just claimed: `src/` contains no
  `fetch`/`http`/`https` imports anywhere, and no analytics/tracking code. The only
  process this tool ever spawns is the user's own local `sf` CLI, with
  `SF_DISABLE_TELEMETRY=true` set on that subprocess's environment (disabling the
  Salesforce CLI's *own* telemetry for the calls this tool makes).

## Commands, exact arguments, and permissions required

| Command this tool runs | Purpose | Read-only? | Official reference |
| --- | --- | --- | --- |
| `sf project deploy start --dry-run --test-level RunSpecifiedTests --tests <name> --target-org <alias> --source-dir <dir> --wait <n> --json` | Validate the baseline or one mutant | Yes — `--dry-run` performs a validation-only deploy; nothing is saved to the org | [`sf project deploy start`](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_project_commands_unified.htm) |
| `sf org list auth --json` | Classify `--target-org` as sandbox/scratch/production before `run` proceeds | Yes — lists already-authenticated orgs from local CLI config; queries nothing new | Source-verified (see `docs/COMPARISON.md`/`REVIEW-NOTES.md` for pinned citations into `@salesforce/core` and `plugin-auth`) |
| `sf --version` | `doctor`'s CLI-presence check | Yes | — |

Required Salesforce permissions are exactly whatever your existing `sf` authentication
already grants for deploying and running tests in the target org — this tool requests
no additional scopes, API access, or connected-app permissions of its own. It cannot do
anything your authenticated `sf` session couldn't already do by hand.

## Dependencies, licenses, SBOM

Two runtime dependencies, both permissively licensed:

| Package | License | Role |
| --- | --- | --- |
| `@apexdevtools/apex-parser` | BSD-3-Clause | Apex ANTLR grammar/parser |
| `antlr4` (transitive, via the parser) | BSD-3-Clause | Parser runtime |

This project itself is MIT. A machine-readable CycloneDX SBOM and a plain-text license
inventory are generated fresh for every release by `scripts/release.mjs` and attached
to each [GitHub release](https://github.com/JoshuaStorm1017/apex-mutant/releases) — do
not rely on the table above for a specific release; use that release's own
`sbom.cyclonedx.json`/`LICENSES.txt` assets, and verify the tarball's `SHA256SUMS`
before installing.

## Install / uninstall

See README's "Install" section for exact commands. Summary: either download a release
tarball (`npm install ./apex-mutant-<version>.tgz`, verified against its `SHA256SUMS`)
or clone and build from source. Not published to the npm registry (`npm view
apex-mutant` returns `404 Not Found`, verified). To uninstall: `npm uninstall
apex-mutant` (or `-g` if installed globally), or simply delete the cloned directory if
built from source — this tool makes no system-level changes (no daemons, no
system config, no registry entries) beyond the npm package itself and whatever
`.apex-mutant/` report directories you've generated inside project folders you ran it
against.

## Platform support

| Platform | `plan` / `doctor` | `run` |
| --- | --- | --- |
| macOS | Supported | Supported (not yet verified against a real org — see below) |
| Linux | Supported | Supported (not yet verified against a real org) |
| WSL (Windows Subsystem for Linux) | Supported | Supported (reports as `linux` to Node; not separately verified) |
| Native Windows | Supported | **Explicitly refused**, with an early clear error |

Native Windows is not merely untested for `run` — it fails fast and on purpose,
because Node's `child_process.spawn` with `shell: false` (used deliberately, to avoid
shell-injection risk from org/test names) has known problems invoking the `.cmd` shim
an npm-installed CLI uses on Windows. Rather than attempt that unreliably, `run` throws
immediately with a message pointing at WSL/macOS/Linux. This has been verified by
simulating `process.platform` in tests (`test/cli.test.ts`), not by running on a real
Windows machine, since none was available while building this. `plan` and `doctor` need
no subprocess for their offline checks and are unaffected.

## API and time budget

Each `run` submits **1 baseline + up to N mutant validation-deploys** (N = the number of
mutations selected after `--include`/`--exclude`/`--operators`/`--max-mutants`
filtering — see `doctor`'s output for the exact planned count and cost estimate before
spending anything). Each validation-deploy runs `RunSpecifiedTests` against whatever
`--tests` you specified, consuming that org's ordinary deployment and test-execution
limits exactly as if you'd run `sf project deploy start --dry-run` by hand that many
times. `--wait` (default 10 minutes, max 1440) bounds how long the Salesforce CLI polls
per validation; `--timeout` (default 660 seconds, max 86400) is a hard local process
kill-switch independent of `--wait`. There is no batching or grouping yet (see
`docs/COMPARISON.md`) — every mutant is a fully separate request.

## Cancellation and the remote-job limitation

`Ctrl+C` during `run` stops the *local* process gracefully — it finishes writing the
report with whatever results completed so far (`exit 130`), and kills the local `sf`
subprocess. **It does not cancel an in-flight remote validation.** If a
`sf project deploy start --dry-run` request had already reached Salesforce when you
interrupt, that validation job may continue running or queued on the org's side even
after the local CLI process is killed — this is a `sf` CLI/platform behavior, not
something this tool's cancellation logic can reach into and stop. The code is explicit
about this rather than implying full cancellation:
`src/salesforce.ts`'s abort path returns the message *"Validation was canceled. Remote
validation may still be running."* If you cancel mid-run, check the target org's deploy
status directly if you need to confirm nothing is still in flight.

## Security posture

See [SECURITY.md](../SECURITY.md) for the full policy, reporting process, and
deliberate risk boundaries. Headline points relevant to a review:

- No credentials are ever held, stored, or transmitted by this tool itself.
- The sandbox/scratch org gate (see README's "The sandbox/scratch guard") is enforced
  in code before any mutant source is sent anywhere, with no override flag — not merely
  documented as an operator responsibility.
- Output writes (`plan.json`, `report.json`, `report.html`) are atomic and specifically
  hardened against a planted symlink at the destination path (see `HANDOFF.md` for the
  real vulnerability this closed, found and fixed during this project's own review process).
- Reports never contain raw Salesforce CLI output or org identifiers, only structured
  outcome classifications and your own source snippets — but should still be treated as
  private, the same as your source code.

## Maintenance and contact

Alpha-stage, actively developed, no SLA. Security issues: GitHub's private security
advisory flow on this repository (see `SECURITY.md`). Ordinary bugs/questions: public
GitHub issues (see `CONTRIBUTING.md`). There is no other support channel.

## Acceptance matrix: verified offline vs. pending an authorized sandbox pilot

| Capability | Verified how | Status |
| --- | --- | --- |
| Mutation generation is deterministic and parser-aware | `test/mutations.test.ts` | ✅ Verified offline |
| Original Apex source is never edited | `test/runner.test.ts`, `test/cli.test.ts` (incl. symlink regressions) | ✅ Verified offline |
| Output paths resist symlink redirection | `test/report.test.ts`, `test/cli.test.ts` | ✅ Verified offline |
| Score/exit-code math never inflates on error/timeout/malformed evidence | `test/report.test.ts`, `test/runner.test.ts` | ✅ Verified offline |
| `sf` result JSON is classified correctly (killed/survived/invalid/timeout/error) | `test/salesforce.test.ts`, incl. a real local fake-`sf` subprocess | ✅ Verified offline (fake subprocess, not a real org) |
| Sandbox/scratch org gate blocks production, with no override | `test/orgSafety.test.ts` (fake `sf org list auth` responses) | ✅ Verified offline (fake subprocess, not a real org) |
| Native Windows fails fast and clearly for `run` | `test/cli.test.ts` (simulated `process.platform`) | ✅ Verified via platform simulation, not a real Windows machine |
| Installed npm bin actually executes (symlink-safe) | `scripts/tarball-smoke.mjs`, automated in CI on every push | ✅ Verified with a real install, in CI |
| Released tarball matches its published checksum | Downloaded the actual `v0.1.0-alpha.2` release asset and re-hashed it (`REVIEW-NOTES.md`) | ✅ Verified for that specific release |
| Advisory-first exit codes: a score never gates a build unless `--enforce` and `--threshold` are both explicit | `test/report.test.ts`, `test/cli.test.ts` | ✅ Verified offline |
| Findings name a file, line, surviving change, and a concrete suggested assertion | `test/findings.test.ts`, `test/cli.test.ts` | ✅ Verified offline |
| Inconclusive mutants are reported separately and never presented as test gaps | `test/findings.test.ts`, `test/report.test.ts` | ✅ Verified offline |
| The report records the safeguards actually enforced (validator, org classification, snapshot isolation) and fails closed on anything it cannot attest | `test/runner.test.ts`, `test/cli.test.ts` | ✅ Verified offline |
| Local Apex source is re-read after every run and proven byte-for-byte unchanged | `test/runner.test.ts` (unchanged, changed, and unverifiable cases) | ✅ Verified offline |
| Exports (CSV/SARIF/Markdown) are well-formed, carry caller-supplied work items, and cannot execute in the tools that open them | `test/exports.test.ts`, `test/cli.test.ts` | ✅ Verified offline |
| Equivalent mutants can be excluded, only with a stated reason, and never silently | `test/suppressions.test.ts`, `test/cli.test.ts` | ✅ Verified offline |
| Two runs over unchanged source produce identical mutants, outcomes, and findings | `test/runner.test.ts` "two runs over unchanged source…" | ✅ Verified offline (tool-side determinism only; says nothing about a real org) |
| Full-run wall-clock runtime, and stability of outcomes against a real org | — | ⏳ **Pending an authorized sandbox pilot** (readiness items 1 and 2; see `docs/REQUIREMENTS.md` G2/G3) |
| `sf project deploy start --dry-run`'s actual JSON contract against a live org | — | ⏳ **Pending an authorized sandbox pilot** — no Salesforce org has been available during development |
| The sandbox/scratch classification against a real authenticated org | — | ⏳ **Pending an authorized sandbox pilot** |
| `run` end-to-end against a real org (baseline gate, mutant sequencing, report accuracy) | — | ⏳ **Pending an authorized sandbox pilot** |

## Synthetic pilot recipe

This exact recipe is runnable today, entirely offline, against the fixture already
checked into this repository (`examples/basic`) — a small `DiscountService` class with
a test suite that includes one **deliberately weak boundary test** (see
`DiscountServiceTest.cls`'s comment: `checksEligibility` tests `99` and `101` but not
the boundary at exactly `100`). Running this with a real, authorized sandbox/scratch
org and `--target-org`/`--tests` filled in is the recommended first pilot:

```sh
node dist/cli.js doctor --project examples/basic --target-org <your-scratch-org>
node dist/cli.js run --project examples/basic \
  --target-org <your-scratch-org> \
  --tests DiscountServiceTest
```

**Objective success criteria** (each independently checkable from the resulting
`report.json`, not from a subjective read of the HTML):

1. **The unchanged baseline passes.** `report.baseline.outcome === "survived"` with
   `testsRun > 0` — if this isn't true, `run` stops immediately and mutants are never
   submitted; that itself is correct behavior, not a failure of the tool.
2. **Known strong tests kill the mutants they should.** Verified by logic simulation
   (not yet against a real org — see acceptance matrix above) that 3 of the 5 mutants
   this fixture generates are killed: the `&&`→`||`, `>=`→`>`, and `*`→`/` mutations in
   `DiscountService.price` are each caught by `discountsMembers`'s existing assertions.
3. **The deliberately weak boundary test yields a survivor.** The `>=`→`>` mutation in
   `DiscountService.eligible` should survive — `checksEligibility` never calls
   `eligible(100)`, so neither the original nor the mutated boundary is ever
   distinguished. (A second mutant — the `<`→`<=` boundary in `price`'s negative-amount
   check — also survives for the same structural reason: no test calls `price(0, ...)`.
   Expect **2 survivors out of 5 mutants, a 60% score**, not zero survivors — a real
   pilot finding 0% survived on the first try on unfamiliar code should be treated with
   suspicion, not celebrated.)
4. **Org metadata remains unchanged.** Confirm via `sf org display --target-org
   <alias>` (or the Setup UI) before and after that `DiscountService`'s deployed Apex
   body is identical — every request was `--dry-run`, so this should trivially hold, but
   checking it directly on a real org is exactly the kind of claim this document
   declines to make without evidence, per the acceptance matrix above.
5. **No-test/auth/compile/timeout evidence cannot inflate the score.** Confirm
   `report.json`'s `summary` never counts `invalid`/`timeout`/`error` outcomes toward
   either `killed` or `survived`, and that `reportExitCode` is `2` (not `0` or `1`) if
   any such outcome appears — verified offline today (`test/report.test.ts`), and this
   pilot is the first chance to confirm it holds against real `sf` CLI output too.

If your pilot's actual results differ from steps 2–3 above (a real org's `sf`
version, API version, or Apex compiler behaving even slightly differently than assumed
could change which mutants survive), that's a valuable, expected finding — update
`HANDOFF.md` with what actually happened, since nothing above has been claimed as
verified against a live org until someone does exactly that.
