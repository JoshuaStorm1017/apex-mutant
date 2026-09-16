# Apex Mutant

Open-source mutation testing for Salesforce Apex. Code coverage tells you what ran; mutation testing checks whether your tests notice changed behavior.

**Status: alpha, under active construction.** See [HANDOFF.md](HANDOFF.md) for verified progress and the next work. No live Salesforce org has been tested yet.

## Intended workflow

1. Parse Apex and generate deterministic, single-edit mutations.
2. Run the unchanged baseline through Salesforce validation with tests.
3. Validate each mutant in an isolated temporary project using `sf project deploy start --dry-run`.
4. Report killed, survived, invalid, timeout, and infrastructure errors separately.

The original workspace is never edited. No org metadata is committed by validation. Use a disposable scratch org or sandbox; this tool is not a production deployment tool.

## Development

Node 22.13+ or 24+. `npm ci`, then `npm run check`.

## License

MIT. Independent community project; not affiliated with Salesforce.
