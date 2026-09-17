# Apex Mutant

Open-source mutation testing for Salesforce Apex. Code coverage tells you what ran;
mutation testing checks whether your tests would *notice* if the behavior changed.

**Status: alpha, under active construction.** No live Salesforce org has been tested
yet — everything described as "verified" in this README has been verified with an
injected fake validator or a real local `sf` subprocess fixture, never a real org. See
[HANDOFF.md](HANDOFF.md) for exact verified state and [docs/COMPARISON.md](docs/COMPARISON.md)
for how this compares to the more mature `apex-mutation-testing` sf plugin.

## How it works

1. Parse Apex with an AST-aware engine and generate deterministic, single-edit mutations.
2. Run the unchanged baseline through Salesforce validation with your tests (`sf project
   deploy start --dry-run`).
3. If the baseline passes, validate each mutant the same way, one at a time, in an
   isolated temporary copy of your source. If the baseline fails, stop — nothing else
   is submitted.
4. Report killed, survived, invalid, timeout, and infrastructure-error mutants
   separately, as JSON and as a self-contained HTML file — plus, for each surviving
   mutant, a located finding with a concrete suggested assertion, and optional
   CSV/SARIF/Markdown exports for whatever tracks your work.

Reporting is **advisory by default**: the mutation score is reported, and it never
changes the exit code unless you explicitly opt into gating (see
[Advisory by default](#advisory-by-default-and-what-to-prove-before-enforcing)).

Every Salesforce request — baseline and mutants — is `sf project deploy start --dry-run`.
**Nothing is ever deployed; your org's real metadata is never changed by this tool.**
Your Apex source is never edited either — every mutation is applied only to a throwaway
temporary copy that is deleted when the run ends (success, failure, or cancellation),
never to the files under your package directories.

That's a narrower claim than "this tool never writes into your project," and
deliberately so: `plan` and `run` both write output artifacts (`plan.json`, `report.json`,
`report.html`) into `--output`, which defaults to `.apex-mutant/` **inside** your
project. Those writes are atomic — each one lands in a fresh temp file first, then an
OS-level rename swaps it into place, which replaces a pre-existing symlink at the
destination rather than following it through to whatever it points at — specifically so
that a leftover or planted symlink at an output path can't redirect the write into your
source. That mechanism (and the report it fixed a real, demonstrated bug in) is
described in `HANDOFF.md`; the guarantee here is "this specific defense exists," not
"nothing outside package directories can ever be written."

## Install

**Not published to the npm registry.** There are two supported ways to get it:

**From a GitHub release** (recommended for trying it out): download the `.tgz` from the
[Releases page](https://github.com/JoshuaStorm1017/apex-mutant/releases) — every release
also carries a `SHA256SUMS` file, a CycloneDX `sbom.cyclonedx.json`, and a plain-text
`LICENSES.txt` for its exact contents — then:

```sh
sha256sum -c SHA256SUMS   # verify the tarball you downloaded matches the release
npm install -g ./apex-mutant-<version>.tgz   # or without -g, into any project
apex-mutant --help
```

**From source** (for development or to build a version not yet released):

```sh
git clone https://github.com/JoshuaStorm1017/apex-mutant.git
cd apex-mutant
npm ci
npm run build
node dist/cli.js --help
```

Requires Node 22.13+ or 24+ (see `engines` in `package.json`). `npx tsx src/cli.ts ...`
also works directly against source during development, without a build step.

## Quickstart: plan (fully offline, no Salesforce CLI required)

```sh
node dist/cli.js plan --project examples/basic
```

This parses `examples/basic` (a synthetic SFDX project checked into this repo) and
prints every mutation it would generate — no network access, no Salesforce CLI, no
org, nothing sent anywhere. It also writes `.apex-mutant/plan.json` next to the
project so you can inspect the exact mutation set before spending anything on `run`.
Expect 5 mutations from that fixture today; add `--json` to get the same plan as JSON
on stdout, or `--include`/`--exclude`/`--operators`/`--max-mutants` to narrow it.

## Quickstart: run (requires a real, disposable Salesforce org)

```sh
node dist/cli.js run --target-org my-scratch-org --tests DiscountServiceTest \
  --project examples/basic
```

That is an advisory run: it reports the score, the findings, and the safeguards it
enforced, and exits `0` whatever the score is. Add `--export all --work-item ABC-123` for
portable artifacts stamped with your own identifier, and `--enforce --threshold 80` only
once you have the evidence listed under
[Advisory by default](#advisory-by-default-and-what-to-prove-before-enforcing).

### Prerequisites

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`)
  installed and authenticated, with `--target-org` resolvable to that authenticated org.
- **A disposable scratch org or sandbox.** This is not a production tool. Nothing is
  ever deployed for real, but every mutant still consumes a validation-deploy and a
  test run against your org's API limits, and mutants are deliberately broken code —
  don't point this at anything you'd mind seeing broken code validated against.
- Every non-Apex dependency (objects, fields, permission sets, flows, etc.) your test
  classes need must **already exist in the target org**. This tool only ever snapshots
  Apex classes and triggers (see "Apex-only snapshots" below) — it never deploys the
  rest of your metadata for you.
- Your baseline (unmutated code) must actually pass the given tests. If it doesn't,
  `run` reports the baseline failure and stops before spending anything on mutants.

### The sandbox/scratch guard

Before sending any mutant source to `--target-org`, `run` calls `sf org list auth
--json` (read-only — it only lists already-authenticated orgs, it never queries or
changes one) and checks that org's `isSandbox`/`isScratchOrg` fields, which the
Salesforce CLI itself computes and caches at auth time. If the org isn't classified as a
sandbox or a scratch org — including if it can't be classified at all (not found, an
auth error, missing/malformed evidence, a timeout) — `run` refuses to start. **There is
no override flag.** This is enforced in code, not just a warning in this README.

This has been verified with injected fake `sf` responses covering production, sandbox,
scratch, missing-org, and malformed-evidence cases (`test/orgSafety.test.ts`) — it has
**not** been verified against a real org, since none is available in this project's
development environment. If you hit a false "unknown" classification against a real org
you believe is a sandbox or scratch org, please open an issue with the (redacted, if
needed) `sf org list auth --json` output for that org.

## Quickstart: doctor (fully offline by default)

```sh
node dist/cli.js doctor --project examples/basic
```

Diagnoses your environment before you spend anything on `run`: Node version and
platform, whether the project is valid, how many mutations your current filters would
target vs. how many Apex files the snapshot actually includes (see "Apex-only
snapshots" below — filtering narrows what's *tested*, not what leaves your machine),
and whether the Salesforce CLI is on `PATH`. Add `--target-org <alias>` for one extra,
read-only check: the same sandbox/scratch classification `run` enforces, reported here
without blocking anything. Add `--json` for machine-readable output. Exits `1` if it
found something `plan`/`run` would actually reject; `0` otherwise.

## CLI reference

```
apex-mutant plan [options]
apex-mutant doctor [options]
apex-mutant run --target-org <alias> --tests <TestClass> [options]
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--project <dir>` | both | SFDX project root (default: current directory) |
| `--include <path>` | both | Exact project-relative file or directory; repeatable |
| `--exclude <path>` | both | Exclude mutation targets; repeatable |
| `--operators <names>` | both | Comma-separated operator IDs (see table below) |
| `--max-mutants <count>` | both | Deterministic subset — the first N mutants generated |
| `--output <dir>` | both | Report/plan directory (default: `.apex-mutant`); must be outside every package directory |
| `--json` | both | Print the plan or completed report as JSON |
| `--target-org <alias>` | run | Explicit, authenticated Salesforce org alias |
| `--tests <names>` | run | Test class names, comma-separated or repeatable |
| `--wait <minutes>` | run | Salesforce CLI `--wait` per validation (default 10) |
| `--timeout <seconds>` | run | Hard local process timeout per validation (default 660) |
| `--enforce` | run | Opt in to gating on the score; requires `--threshold`. Off by default |
| `--threshold <percent>` | run | Score to gate on; only meaningful together with `--enforce` |
| `--export <formats>` | run | Also write `csv`, `sarif`, `md` (comma-separated, or `all`) |
| `--work-item <id>` | run | Identifier recorded in the report and every export; repeatable |

### Mutation operators

| Operator ID | Example |
| --- | --- |
| `conditional-boundary` | `<` → `<=`, `>` → `>=`, and `<=`/`>=` → drop the `=` |
| `equality-negation` | `==` → `!=`, `!=` → `==`, `===` → `!==`, `!==` → `===`, `<>` → `==` |
| `logical-connector` | `&&` → `\|\|`, `\|\|` → `&&` |
| `boolean-literal` | `true` → `false`, `false` → `true` |
| `negation-removal` | `!condition` → `condition` |
| `increment-decrement` | `i++` → `i--`, `i--` → `i++`, `++i` → `--i`, `--i` → `++i` |
| `unary-negation-removal` | `-x` → `x` (unary minus only; unary `+x` is left alone) |
| `arithmetic` | `*` → `/`, `/` → `*`, binary `-` → `+` |

Deliberately **not** mutated in this version: string concatenation (`+` on strings is
ambiguous with numeric `+`, and it's excluded rather than guessed at), compound
assignment (`+=`, `-=`, ...), comments, string/char literals, annotation values, and
anything inside a SOQL/SOSL query (including bind expressions) — mutating query syntax
risks generating something that looks like a query but isn't, which is out of scope for
this tool's parser-aware guarantee. Entire test classes and any method or class
annotated `@IsTest`/`testMethod`/`@TestSetup` are skipped outright, case-insensitively.
See [docs/COMPARISON.md](docs/COMPARISON.md) for operators a more mature tool supports
that this one doesn't yet, and why they weren't ported over uncritically.

## Mutation score, results, and exit codes

```
score = killed / (killed + survived) * 100
```

`invalid` (mutant didn't compile), `timeout`, and `error` (infrastructure/auth/malformed
evidence) mutants are **excluded from the denominator entirely** — they are reported
visibly in the JSON/HTML output, but never counted as either a kill or a survival, and
never silently inflate the score. If there are zero scored (`killed` + `survived`)
mutants, the score is unavailable (`null`), never reported as 0% or 100%.

Exit codes from `run`:

| Code | Meaning |
| --- | --- |
| `0` | The run produced a readable result (advisory mode always ends here when the run completed) |
| `1` | **Only with `--enforce`:** the run completed and the score is below `--threshold` |
| `2` | The run produced no readable result: baseline failure, incomplete run, any unresolved `error`/`timeout`, or no score available |
| `130` | Canceled (`Ctrl+C`); already-completed results are preserved in the report |

Exit code `2` is not a quality gate and is not suppressed in advisory mode: it means the
tool produced no evidence at all, which is a different thing from tests scoring badly.

`plan` exits `2` if the filters you gave produced zero mutations, so you notice an
empty selection instead of silently doing nothing.

## Advisory by default, and what to prove before enforcing

A mutation score is evidence about your tests, not a verdict on a build. `run` therefore
starts in **advisory mode**: the score is reported everywhere and gates nothing.

```bash
apex-mutant run --target-org my-scratch --tests DiscountServiceTest     # advisory
apex-mutant run --target-org my-scratch --tests DiscountServiceTest \
  --enforce --threshold 80                                             # opt-in gate
```

Both halves of the gate must be explicit. `--threshold` without `--enforce` is rejected
(it would silently do nothing) and `--enforce` without `--threshold` is rejected (it
would invent a number nobody chose). Machine-readable output follows the same rule: SARIF
results are emitted at level `note` in advisory mode, at most `warning` under `--enforce`,
and **never** at `error`.

Every report restates what mutation testing does and does not cover, and carries this
checklist of evidence to gather from your own runs before wiring a score into CI:

1. **Runtime** — a full run finishes inside the time your pipeline can afford, measured on your own codebase.
2. **Stability** — repeated runs on unchanged source produce the same outcomes.
3. **Scope** — the mutants and tests a run covers are the ones you intend to gate on.
4. **Restoration safety** — every run happens in a disposable or provably restored org, with evidence retained.
5. **Equivalent mutants** — you have a way to record and exclude mutants no test could ever kill.
6. **False positives** — inconclusive outcomes (`invalid`, `timeout`, `error`) are understood and don't silently move the score.

apex-mutant cannot supply those for you, which is exactly why it ships the checklist
instead of a default threshold.

## Findings: what to do about a surviving mutant

A score on its own is not an action. Every report (HTML, `report.json`, and every export)
turns the run into prioritized findings:

- **Test gaps** — one per surviving mutant, with its file, line, column, the exact change
  that survived, how many test methods ran against it, and a suggested assertion specific
  to the operator class. Operators whose survivors are more often behaviorally equivalent
  (boundary and arithmetic changes) are marked `equivalenceRisk: moderate` and their
  suggested action says to record an equivalent mutant rather than invent a test. That is
  a heuristic about the operator, not a proof about your line — apex-mutant does no
  semantic analysis.
- **Unproven mutants** — `invalid`, `timeout`, and `error` mutants, reported separately and
  ranked below gaps, because they prove nothing about test quality in either direction.
- **Run quality** — a failed baseline or a run that stopped short, so a partial result is
  never read as a clean one.
- **Hotspots** — files ranked by surviving mutants and weakest per-file score: where the
  assertion debt actually concentrates.

## Execution safeguards recorded in every report

The report records what apex-mutant can actually attest about the run, rather than
repeating the guarantees in this README:

| Field | What it records |
| --- | --- |
| `safeguards.validator` | Which validator ran, by name |
| `safeguards.validationOnly` | `true` only for the built-in `sf project deploy start --dry-run` path. A caller-supplied validator (library API) is recorded as un-attested, never assumed safe |
| `safeguards.orgCheck` | The `sf org list auth` classification that was enforced before anything was sent |
| `safeguards.snapshotIsolated` | Mutants were applied only inside the temporary snapshot copy |
| `safeguards.sourceIntegrity` | Every project file re-read after the run and compared byte-for-byte with what was read before it. `verified: false` means the check could not be completed — never that the source is unchanged |

## Portable exports and work-item traceability

`--export` writes tool-agnostic artifacts next to `report.json`/`report.html`, with the
same symlink-safe atomic write:

| Format | File | Use |
| --- | --- | --- |
| `csv` | `findings.csv` | One row per finding, with run metadata on every row. Values starting with `=`, `+`, `-`, or `@` are prefixed with `'` so a spreadsheet can't evaluate a source snippet as a formula |
| `sarif` | `report.sarif` | SARIF 2.1.0 for any tool that ingests static-analysis results |
| `md` | `summary.md` | A paste-ready summary: mode, safeguards, findings with suggested actions, hotspots, readiness checklist |

`--work-item ABC-123` (repeatable) stamps your own identifiers into the report and every
export, so a run can be attached to whatever tracks your work. apex-mutant never contacts
any such system; the identifiers are recorded and echoed, nothing more. They're validated
up front (letters, digits, `.`, `_`, `-`, `/`, 1–64 characters) rather than sanitized
afterwards.

`report.json` is `schemaVersion: 2` and carries `tool`, `policy`, `traceability`, and
`safeguards` alongside the results, plus derived `summary`, `findings`, `hotspots`, and
the readiness checklist.

## Report privacy

`run` writes `report.json` and `report.html` into `--output` (default `.apex-mutant/`,
git-ignored) after every single mutant, so a killed process still leaves a readable
partial report. Requested exports (`findings.csv`, `report.sarif`, `summary.md`) are
written once at the end of the run, including when the baseline never passed — a failed
run is reportable too. They contain the same source snippets and are equally private. `report.html` is a single self-contained file: no external scripts, no
CDN assets, and an explicit `Content-Security-Policy: script-src 'none'` — it never
phones home and works fully offline. It does contain your source snippets (the original
and mutated lines) and Salesforce CLI outcome classifications, never raw CLI output or
org identifiers — **treat it as private**, the same as you'd treat your source code.

## Apex-only snapshots

Every validation — baseline and every mutant — runs against an isolated temporary copy
containing **only** your Apex classes/triggers (`.cls`/`.trigger` plus their
`-meta.xml` companions) and a minimal `sfdx-project.json` (your `packageDirectories`,
plus `namespace`/`sourceApiVersion` if you set them). Nothing else is copied: no
auth files, no arbitrary config, no other metadata types. `.forceignore` is
**intentionally not applied** — this isn't a deploy of your whole project, so ignoring
files that would otherwise be deployed doesn't apply here; every Apex file discovered
under your `packageDirectories` is snapshotted regardless of `.forceignore`. This means
every other metadata dependency your tests need (custom objects, fields, permission
sets, flows, static resources, etc.) must **already exist in the target org** — this
tool never deploys them for you, by design.

## Known alpha limitations

- **No live-org validation yet.** Every offline claim above (parsing, snapshotting,
  scoring, report rendering, CLI behavior, and the missing-`sf`-CLI fail-closed path)
  is covered by tests with an injected validator or a real local `sf`-shaped subprocess
  fixture. The actual `sf project deploy start --dry-run` contract against a real org
  has not been exercised. Treat `run` as unverified against a real org until someone
  does that with an actual disposable org and updates `HANDOFF.md`.
- **Native Windows is explicitly unsupported for `run`, on purpose.** `validateWithSalesforce`
  spawns `sf` with `shell: false` (deliberately, to avoid shell-injection risk from
  target-org/test names); on Windows an npm-installed CLI is typically a `.cmd` shim,
  and Node's `child_process.spawn` has known problems invoking `.cmd`/`.bat` files
  without `shell: true`. Rather than attempt that unreliably, `run` fails immediately
  with a clear error on native Windows (`process.platform === 'win32'`) pointing at
  WSL, macOS, or Linux instead. `plan` and `doctor` (pure parsing/diagnostics, no
  subprocess needed for their offline checks) still work natively on Windows — verified
  by simulating `process.platform` in tests, not by running on real Windows, since none
  is available here. Filesystem symlink handling in project discovery is also untested
  on real Windows and its tests are skipped there. If you run this from WSL and hit an
  issue, please open one with what you found.
- **Sequential only, no grouping, no coverage-based test selection.** Every mutant is
  validated one at a time against the full `--tests` list you gave, regardless of
  which lines those tests actually cover. See
  [docs/COMPARISON.md](docs/COMPARISON.md) for what a coverage-aware, grouped
  alternative looks like and why this tool doesn't have it yet (it needs live org
  queries this environment couldn't verify).
- **8 mutation operators**, not a large or configurable set. See the operator table
  above for exactly what's covered.
- Not published to the npm registry. Install from a GitHub release tarball or from
  source (see "Install" above).

## Development

```sh
npm ci
npm run check             # typecheck + unit/integration tests + build
npm run demo              # offline plan against examples/basic
node scripts/tarball-smoke.mjs   # real npm pack + install + installed-bin smoke test
npm run release:prepare   # builds release/: tarball, SHA256SUMS, SBOM, license inventory
```

`npm run check` is the release gate — it must pass before any change is pushed.
CI runs both `npm run check` and `scripts/tarball-smoke.mjs` on every push; the release
workflow (`.github/workflows/release.yml`, manually triggered) runs
`scripts/release.mjs` and attaches its output to a GitHub prerelease.
See [AGENTS.md](AGENTS.md) for the full contributor/agent contract,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries and the acceptance
contract, [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose a change,
[SECURITY.md](SECURITY.md) for how to report a vulnerability, and
[docs/TECHNICAL-REVIEW.md](docs/TECHNICAL-REVIEW.md) for a committee-ready brief
(architecture/data flow, dependencies, platform support, acceptance matrix, and a
runnable synthetic pilot recipe) if you're evaluating this for internal use.

## License

MIT. Independent community project; not affiliated with Salesforce.
