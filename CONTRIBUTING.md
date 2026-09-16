# Contributing

Thanks for considering a contribution. This project is alpha-stage and every change
should keep it that way honestly — see [HANDOFF.md](HANDOFF.md) for exactly what's
verified today and what isn't.

## Before you start

Read [AGENTS.md](AGENTS.md), [README.md](README.md), and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version:

- This repository is intentionally public. Never commit org credentials, real customer
  Apex, Salesforce CLI auth output, or anything from a private handoff.
- All Salesforce execution is validation-only (`sf project deploy start --dry-run`).
  Never add a deploy or quick-deploy fallback, and never treat a compilation failure,
  timeout, auth failure, or missing test evidence as a killed mutant.
- Mutation generation must stay parser-aware: never mutate comments, strings,
  annotations, test code, or query syntax.

## Setup

```sh
git clone https://github.com/JoshuaStorm1017/apex-mutant.git
cd apex-mutant
npm ci
npm run check
```

`npm run check` (typecheck + tests + build) must pass before you open a PR. There is no
Salesforce org in CI or in most contributors' dev environments — every test in
`test/*.test.ts` either exercises pure parsing logic or injects a fake `Validator`
(see `src/types.ts`'s `Validator` type and `test/runner.test.ts`/`test/cli.test.ts` for
examples). Never write a test that requires a real org or a real Salesforce CLI
installation; `test/salesforce.test.ts`'s pattern of a tiny fake `sf` executable on
`PATH` is the model for anything that needs to look like a real subprocess.

## Making a change

- Keep commits small and focused; update [HANDOFF.md](HANDOFF.md) at meaningful
  checkpoints so the project stays easy to pick back up.
- Add or update tests alongside any behavior change — especially anything touching
  mutation generation, project discovery, the runner's baseline/abort/cleanup
  semantics, or result classification in `salesforce.ts`.
- If you add a mutation operator, it must fit the existing parser-visitor pattern in
  `src/mutations.ts`: a single deterministic, syntax-aware edit, excluded from test
  code, comments/strings, annotations, and queries, with a test proving both what it
  mutates and what it deliberately leaves alone.
- Run `npm run check` locally before pushing.

## Reporting issues

Open a GitHub issue. Include the exact command you ran, whether you were using `plan`
or `run`, and (for `run`) whether the issue reproduces without a real org (most bugs in
this tool can be, and should be, reproduced with an injected fake validator — see
above). For a security issue, see [SECURITY.md](SECURITY.md) instead of a public issue.

## Verifying against a real org

No disposable Salesforce org has been available while building this tool so far — see
`HANDOFF.md` for the exact state of live-org verification. If you have access to a
scratch org or sandbox you're comfortable running mutation tests against, verifying the
`run` command end-to-end and reporting back (success or failure, with the exact `sf`
CLI version) is one of the most valuable contributions this project can currently use.
