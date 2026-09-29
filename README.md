# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Find where your LLM spend is wasted, then verify and apply the savings.**

optimAIzr is an open-source CLI that reads the token usage your coding agents
and apps already record, shows where the money goes, and proposes changes with
the arithmetic behind each one. Then it checks each change against your own
traffic before you make it.

It runs entirely on your machine: no account, no upload, no telemetry. It reads
token counts, never your prompts.

```bash
npx optimaizr profile
```

```
  AI usage

  Spend                     $476.70  $452.56/month at the last 30 days' rate
  Calls                       4,062
  Tokens                     743.4M  739.7M in / 3.7M out

  Optimization

  Flagged calls                 931  22.9% of calls
  Potential savings       $44.59/mo  $542.48/year

  Biggest opportunity

  ! Model mismatch

    17% of your requests use a model whose capabilities exceed the
    detected workload requirements.
    671 calls affected.
```

## Features

- **Zero setup for coding agents.** Reads Claude Code and Codex sessions
  straight from disk.
- **One line for your app.** `optimaizr.wrap(new Anthropic())` or
  `optimaizr.wrap(new OpenAI())` records every call's usage locally.
- **13 waste detectors.** Oversized models, cache misses, bloated prompts,
  repeated file reads, retry loops, runaway reasoning, cost spikes and more.
- **Numbers you can check.** Every figure is labelled measured, inferred or
  estimated, and `--why` shows the calculation.
- **Verify before you switch.** `optimaizr verify` replays your own traffic on
  the cheaper option and scores the output against your quality bar.
- **Live mode.** `optimaizr live` flags waste while your agent runs and can
  apply a model switch with one key.
- **Plans and budgets.** 5-hour sessions on Claude Pro, Max and Team, OpenAI's
  own meter on ChatGPT plans, and the day a monthly budget runs out.

See the [package README](apps/cli/README.md) for usage, or the
[CLI reference](docs/CLI.md) for every command and number.

## Repository

| Path             | Contents                                                        |
| ---------------- | --------------------------------------------------------------- |
| `apps/cli`       | The `optimaizr` command, published to npm                       |
| `packages/core`  | The analysis engine: pricing, ingestion, rules, reports         |
| `packages/local` | The Node host: `wrap()`, the local ledger, live tailing, replay |

```bash
npm install
npm run build
npm test
```

Requires Node 20.11+. See [CONTRIBUTING](docs/CONTRIBUTING.md) for how the code
is organised and what a pull request needs.

## Documentation

- [Package README](apps/cli/README.md): install and usage
- [CLI reference](docs/CLI.md): every command, flag and figure explained
- [Changelog](CHANGELOG.md)
- [Security and data handling](SECURITY.md): what is read, written and sent,
  and how to report a vulnerability
- [optimaizr.com/docs](https://www.optimaizr.com/docs)

optimAIzr Pro, the hosted product coming to
[optimaizr.com](https://www.optimaizr.com), is separate from this repository.

## License

[MIT](LICENSE)
