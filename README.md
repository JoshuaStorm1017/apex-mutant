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
   separately, as JSON and as a self-contained HTML file.

Every Salesforce request — baseline and mutants — is `sf project deploy start --dry-run`.
**Nothing is ever deployed. Your org's real metadata is never changed by this tool,**
and your own project files are never edited; mutations are only ever applied to a
throwaway temporary copy that is deleted when the run ends (success, failure, or
cancellation).

## Install

Not published to npm yet. Clone and build from source:

```sh
git clone https://github.com/JoshuaStorm1017/apex-mutant.git
cd apex-mutant
npm ci
npm run build
```

Requires Node 22.13+ or 24+ (see `engines` in `package.json`). Run the CLI from the
built output, or via `npx tsx src/cli.ts ...` during development:

```sh
node dist/cli.js --help
```

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

## CLI reference

```
apex-mutant plan [options]
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
| `--threshold <percent>` | run | Fail (exit 1) below this mutation score (default 0) |

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
| `0` | Run completed and the score met `--threshold` |
| `1` | Run completed but the score is below `--threshold` |
| `2` | Incomplete run, baseline failure, any unresolved `error`/`timeout`, or no score available |
| `130` | Canceled (`Ctrl+C`); already-completed results are preserved in the report |

`plan` exits `2` if the filters you gave produced zero mutations, so you notice an
empty selection instead of silently doing nothing.

## Report privacy

`run` writes `report.json` and `report.html` into `--output` (default `.apex-mutant/`,
git-ignored) after every single mutant, so a killed process still leaves a readable
partial report. `report.html` is a single self-contained file: no external scripts, no
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
- **Windows is untested and the `run` command may not work there.** `validateWithSalesforce`
  spawns `sf` with `shell: false` (deliberately, to avoid shell-injection risk from
  target-org/test names). On Windows, a CLI installed via npm is typically a `.cmd`
  shim, and Node's `child_process.spawn` has known problems invoking `.cmd`/`.bat`
  files without `shell: true`. `plan` (pure parsing, no subprocess) should work
  fine on Windows; `run` might not. Filesystem symlink handling in project discovery is
  also untested on Windows and its tests are skipped there. If you verify `run` on
  Windows (or find it broken), please open an issue with what you found.
- **Sequential only, no grouping, no coverage-based test selection.** Every mutant is
  validated one at a time against the full `--tests` list you gave, regardless of
  which lines those tests actually cover. See
  [docs/COMPARISON.md](docs/COMPARISON.md) for what a coverage-aware, grouped
  alternative looks like and why this tool doesn't have it yet (it needs live org
  queries this environment couldn't verify).
- **8 mutation operators**, not a large or configurable set. See the operator table
  above for exactly what's covered.
- Not published to npm. Install from source only (see "Install" above).

## Development

```sh
npm ci
npm run check     # typecheck + unit/integration tests + build
npm run demo      # offline plan against examples/basic
```

`npm run check` is the release gate — it must pass before any change is pushed.
See [AGENTS.md](AGENTS.md) for the full contributor/agent contract,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries and the acceptance
contract, [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose a change, and
[SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

MIT. Independent community project; not affiliated with Salesforce.
