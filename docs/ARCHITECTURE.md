# Architecture and acceptance contract

Node/TypeScript CLI, with the BSD-licensed apex-dev-tools ANTLR parser. Modules: mutation engine, project discovery/copy, Salesforce subprocess adapter, sequential runner, JSON/HTML reporters, CLI. Shared public contracts live in src/types.ts.

The engine exports `generateMutations(source, file): Mutation[]` and `applyMutation(source, mutation): string`. Offsets are zero-based JavaScript string offsets, end-exclusive; line and column are one-based. IDs are content-derived and deterministic.

The Salesforce adapter exports `validateWithSalesforce(options): Promise<ExecutionResult>`. It runs `sf project deploy start --dry-run --test-level RunSpecifiedTests --tests ... --target-org ... --source-dir ... --wait ... --json`. It must fail closed on missing/malformed JSON or zero executed tests. A test failure is killed only when test result evidence exists and compilation passed. Compile failures are invalid; operational failures are error. Timeouts are never killed. No raw CLI output or org identifiers are persisted in reports.

Project handling reads SFDX packageDirectories, refuses symlinks/path escapes, copies only package source plus the project configuration into a private temporary directory, and excludes auth/cache files. Each mutation starts from the same pristine snapshot. The runner validates a baseline before running mutants, writes incremental results, and cleans up on ordinary failures. There are no direct credentials or Salesforce API clients.

Score = killed / (killed + survived). Invalid/timeouts/errors are excluded and reported visibly; incomplete execution must fail CI independently of score. No valid mutants means score unavailable, never 100 percent. Resume/caching and coverage-based selection are later work; correctness comes first.

Acceptance: deterministic syntax-aware edits; preserved original workspace; strict baseline gate; exact dry-run subprocess contract; distinct classification for test/compile/auth/timeout outcomes; offline end-to-end tests; useful JSON and HTML reports; clean npm package; public CI and handoff. Live-org validation remains a separate gate until a disposable org is provided.
