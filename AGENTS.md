# Contributor and agent contract

- This repository is intentionally public. Commit only synthetic examples and product code. Never add org credentials, customer Apex, CLI auth output, or private handoff details.
- Read README.md, docs/ARCHITECTURE.md, and HANDOFF.md before continuing.
- Use npm with package-lock.json; `npm run check` is the release gate.
- Keep mutation generation parser-aware; never mutate comments, strings, annotations, test code, or query syntax accidentally.
- Never treat compilation failures, timeouts, auth failures, or missing tests as killed mutants.
- All Salesforce execution must use validation-only `--dry-run`, explicit target org, explicit test level, and isolated source copies. Never add a deploy/quick-deploy fallback.
- Keep commits small and update HANDOFF.md at each useful checkpoint. Verify the GitHub identity and inspect staged files before public pushes.
- Do not claim live-org verification without an actual, explicitly authorized disposable-org run.
