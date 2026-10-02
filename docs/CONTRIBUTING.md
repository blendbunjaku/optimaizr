# Contributing

Thanks for looking. Bug reports with a reproduction are the most useful thing
you can send; for a wrong number, include the `optimaizr feedback` line and the
figure you expected.

## Setup

Requires **Node 20.11+** (`nvm use` reads `.nvmrc`).

```bash
npm install
npm run build
npm test
```

`npm test` builds `packages/core` and `packages/local` first, because the CLI's
tests import their compiled output. To try your changes on real data, run the
built CLI directly: `node apps/cli/dist/cli.js profile`.

## Layout

| Path             | What                                                            |
| ---------------- | --------------------------------------------------------------- |
| `apps/cli`       | The `optimaizr` command and the npm package                     |
| `packages/core`  | The analysis engine: pricing, ingestion, rules, reports         |
| `packages/local` | The Node host: `wrap()`, the local ledger, live tailing, replay |
| `mods/optimaizr` | The Claude Code mod, a plugin Claude Code loads as it is        |

One rule shapes the code: **`packages/core` may not import a host.** No
filesystem, network or `process.env`. If core needs to persist something, the
host injects a store (see `DecisionStore`).

Neither package is published on its own. `apps/cli/scripts/bundle.mjs` bundles
both into the CLI, so the npm package has no runtime dependencies.

## Common changes

- **A price or a new model:** add or edit an entry in
  `packages/core/src/pricing.ts`, with the date the rate took effect, and add a
  test in `apps/cli/test/catalogue.test.mjs` if the model id could be mistaken
  for another one. For a Claude model, also run `npm run mod:prices` in
  `apps/cli`, so the mod prices savings at the same rates (a test fails until
  you do).
- **A new waste rule:** write a function in `packages/core/src/analyze/rules.ts`
  that returns at most one finding through `build()`, add it to `RULES`, and
  test it against a small hand-built dataset. Say how the figure was derived
  (`measured`, `inferred` or `estimated`) and list every assumption.
- **A new provider:** add its models to the catalogue and an adapter in
  `packages/local/src/providers`. The analysis should not need to change.
- **The Claude Code mod:** it has no build step. Run Claude Code with
  `claude --plugin-dir mods/optimaizr` and it reloads on save. Keep anything
  that doesn't need `$` in `hooks/meter.ts`, run `claude plugin validate
mods/optimaizr` and `claude plugin test mods/optimaizr`, and bump the
  version in its `plugin.json`, `.claude-plugin/marketplace.json` and
  `register.tsx` together, or installed copies won't update.

## Before opening a pull request

```bash
npm run typecheck && npm run lint && npm run format:check && npm run build && npm test
```

CI runs the same, then installs the packed tarball outside the repo and runs
it. Typecheck alone is not enough: `tsc` passes on a missing side-effect import,
so only running the built CLI catches it.

## Tests

Anything that decides a dollar figure or handles user data needs a test, and a
bug fix needs a test that fails without the fix. Check that it does before you
push: a regression test that passes against the bug proves nothing.

## Style

- Comments explain what the code can't: a vendor quirk, a unit, why the obvious
  approach is wrong. Keep them to a few lines.
- Every figure the CLI prints must be traceable. If a number is estimated, the
  output says so.
- Terminal output uses plain punctuation (no em dashes) so it survives any
  terminal and copy-paste.

## Writing the name

`optimaizr` for anything a machine parses (the package, the command, paths,
`~/.optimaizr`). optimAIzr for anything a person reads (headings, docs,
report titles, output text). npm rejects uppercase package names, so the
command could not be spelled the other way.

## Security

Never commit a secret. If you find a way for optimAIzr to leak prompts,
credentials or usage data off the machine, report it privately as described in
[SECURITY.md](../SECURITY.md).
