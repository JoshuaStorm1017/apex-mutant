# Security Policy

## Scope

Apex Mutant is a local CLI. It:

- Reads Apex source from an SFDX project on disk.
- Never edits your original project files — mutations are only ever applied to a
  throwaway temporary copy that is deleted when the run ends.
- Only ever calls `sf project deploy start --dry-run`. It never deploys, never applies
  a quick-deploy fallback, and never holds or transmits credentials itself (it relies
  entirely on your already-authenticated Salesforce CLI).
- Writes reports (`report.json`, `report.html`) that can contain your source snippets.
  These are written locally, with `0o600` permissions where the platform honors them,
  and are never uploaded anywhere by this tool.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a security vulnerability. Instead,
open a private security advisory via GitHub's "Report a vulnerability" flow on this
repository (Security tab → "Report a vulnerability"). Include:

- The exact command and flags you ran.
- What you expected vs. what happened.
- Whether it requires a real Salesforce org to reproduce, or reproduces with an
  injected fake validator / a local fake `sf` executable (see `test/salesforce.test.ts`
  for the pattern) — the latter is much easier for us to verify quickly.

We'll acknowledge reports as promptly as we can. This is a volunteer-maintained,
alpha-stage open-source project with no SLA, but security reports get priority over
ordinary bugs.

## Known, deliberate risk boundaries

These are documented tradeoffs, not vulnerabilities to report:

- `run` requires a target org and will consume that org's API/test-run limits — one
  validation-deploy and one test run per mutant, plus one baseline. Always point this
  at a disposable scratch org or sandbox, never production.
- Mutants are deliberately broken code, generated and validated locally, and are never
  deployed for real — but a mutant's test failure output could theoretically surface
  something sensitive your own tests print. Reports never include raw Salesforce CLI
  output or org identifiers, only structured outcome classifications, but treat
  `report.html`/`report.json` as private in the same way you'd treat your own source.
- `.forceignore` is intentionally not applied when building the isolated snapshot used
  for validation (see README's "Apex-only snapshots" section) — this is a deliberate
  design choice for a validation-only tool, not an oversight.
