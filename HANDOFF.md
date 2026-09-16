# Claude / next-agent handoff

## Checkpoint 2: working engine, CLI, adapter, and reports

Public open-source Apex mutation testing CLI, MIT license. Owner requested frequent GitHub checkpoints and explicitly requested delegation to Claude to conserve Codex credits. Claude is taking ownership of the remaining integration, verification, and documentation after this checkpoint.

Architecture and interfaces are in docs/ARCHITECTURE.md and src/types.ts. Build from the isolated repository only. No org or credentials are included. Salesforce CLI is not installed on the initial development host; live-org acceptance is NOT verified.

## Verified now

- `npm run check`: typecheck, 13 focused engine/adapter tests, and build pass.
- AST-aware engine handles boundary/equality/boolean/logical/negation/arithmetic mutations; excludes test code, strings/comments, annotations and queries. Unicode and stale-plan tests pass.
- Salesforce adapter is covered with structured result fixtures and an actual fake subprocess. No Salesforce CLI or org exists on this host; owner confirmed this is expected and asked us to do the best possible offline.
- Root implemented project discovery, Apex-only private snapshots, sequential baseline-gated runner, incremental JSON/HTML reports, CLI, a synthetic SFDX example, and Node 22/24 CI. THESE ROOT MODULES STILL NEED INTEGRATION TESTS AND REVIEW.

## Claude work order (next)

1. Read the repository, review root modules, and add meaningful tests in test/project.test.ts, test/runner.test.ts, test/report.test.ts, and test/cli.test.ts. Use injected validators and temporary fixtures; never connect to a real org.
2. Prove baseline failures stop mutations; workspace unchanged on success/failure/abort; snapshot cleanup; source/config allowlist and symlink/path escape rejection; deterministic include/exclude/limits; score denominator and CI exit codes; escaped HTML; incremental failure reports; CLI offline plan and missing-sf failure.
3. Fix issues you find. Important areas: output paths/symlinks must not overwrite source; source files must not be reread from changing originals; clear report on unexpected runner failure; package directories may have no Apex; SF result classification must never inflate score. Check Windows support and document if unsupported rather than claiming it.
4. Expand README with runnable clone/install/build/plan/run examples, operator table, alpha limitations, results/exit codes, org prerequisites, scoring, report privacy and exact offline/live distinction. Explain Apex-only snapshots: other metadata dependencies already in org; .forceignore is intentionally not applied. Add CONTRIBUTING.md, SECURITY.md, and a short changelog if useful.
5. Run npm run check, npm run demo, npm pack --dry-run, inspect package contents, and inspect public GitHub CI. Test installed tarball invocation in an isolated temporary dir if feasible. Never publish npm or create real org resources.
6. Update this handoff with evidence and next priorities, inspect all staged files for secrets/private data, verify GitHub identity JoshuaStorm1017 before each push, and push frequent working commits to main. Public publication and continued pushes were explicitly authorized. Existing local git authorship uses GitHub noreply for privacy.

## Original work plan

1. Parser-based mutation engine with focused tests.
2. Validation-only Salesforce adapter with outcome classification and subprocess tests.
3. Project discovery, isolated runner, CLI, incremental JSON and standalone HTML reports.
4. Synthetic SFDX sample, integration tests, public CI, package verification, updated documentation.

## Delivery ledger

Product outcome: a developer can identify surviving Apex mutants without changing source or deploying org metadata.
Analysis: acceptance criteria are recorded in docs/ARCHITECTURE.md.
Architecture: Node/TypeScript, parser-aware mutation generation, validation-only sequential execution.
Development: branch main; lanes are engine, Salesforce adapter, and root integration.
Review/testing: engine/adapter focused checks passed; integration review assigned to Claude. External AgentOps recording was attempted but unavailable; this repository carries the public, non-sensitive continuation ledger.
