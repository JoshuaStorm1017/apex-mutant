# Claude / next-agent handoff

## Checkpoint 1: foundation

Public open-source Apex mutation testing CLI, MIT license. Implementation in progress. Owner requested frequent GitHub checkpoints so another agent can continue when credits end.

Architecture and interfaces are in docs/ARCHITECTURE.md and src/types.ts. Build from the isolated repository only. No org or credentials are included. Salesforce CLI is not installed on the initial development host; live-org acceptance is NOT verified.

## Work plan

1. Parser-based mutation engine with focused tests.
2. Validation-only Salesforce adapter with outcome classification and subprocess tests.
3. Project discovery, isolated runner, CLI, incremental JSON and standalone HTML reports.
4. Synthetic SFDX sample, integration tests, public CI, package verification, updated documentation.

## Delivery ledger

Product outcome: a developer can identify surviving Apex mutants without changing source or deploying org metadata.
Analysis: acceptance criteria are recorded in docs/ARCHITECTURE.md.
Architecture: Node/TypeScript, parser-aware mutation generation, validation-only sequential execution.
Development: branch main; lanes are engine, Salesforce adapter, and root integration.
Review/testing: pending implementation. External AgentOps recording was attempted but unavailable; this repository carries the public, non-sensitive continuation ledger.
