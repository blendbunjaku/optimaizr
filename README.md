# optimAIzr

**Find where your LLM spend is wasted, then verify and apply the savings.**

optimAIzr reads the token usage your coding agents and apps already record,
shows where the money goes, and proposes changes with the arithmetic behind
them. It runs 100% locally: no account, no upload, no telemetry, and it reads
token counts, never your prompts.

```bash
npx optimaizr profile
```

```
  Spend                     $476.70  $452.56/month at the last 30 days' rate
  Calls                       4,062

  Flagged calls                 931  22.9% of calls
  Potential savings       $44.59/mo  $542.48/year

  ! Model mismatch

    17% of your requests use a model whose capabilities exceed the
    detected workload requirements.
    671 calls affected.
```

## What it reads

- **Claude Code** and **Codex** transcripts on your machine, with no setup.
- **Your own app**, through one line: `optimaizr.wrap(new Anthropic())` or
  `optimaizr.wrap(new OpenAI())`.
- **Usage exports** (CSV or JSON) via `optimaizr import`.

On Claude Pro, Max or Team (`--plan pro`) it shows your 5-hour sessions and how
much of each goes on waste. On ChatGPT plans it reads OpenAI's own limit meter
from Codex.

## The loop

| Command                     | What it answers                              |
| --------------------------- | -------------------------------------------- |
| `optimaizr profile`         | Where am I wasting the most?                 |
| `optimaizr why`             | Where does the money actually go?            |
| `optimaizr simulate <rule>` | What would the change save?                  |
| `optimaizr verify <rule>`   | Does the output still hold up on my traffic? |
| `optimaizr apply <rule>`    | What exactly do I change?                    |
| `optimaizr live`            | What's wasteful right now, as I work?        |

`optimaizr --help` lists every command.

## Documentation

- [Usage guide](apps/cli/README.md): the README published to npm
- [CLI reference](docs/CLI.md): every command, flag and number explained
- [Security and data handling](SECURITY.md): exactly what is read, written and sent
- [Contributing](docs/CONTRIBUTING.md)

## This repository

This is the open-source CLI and the engine behind it. optimAIzr Pro, the hosted
product coming to [optimaizr.com](https://www.optimaizr.com), is separate.

| Path             | What                                             |
| ---------------- | ------------------------------------------------ |
| `apps/cli`       | The `optimaizr` command, published to npm        |
| `packages/core`  | The analysis engine: pricing, rules, reports     |
| `packages/local` | `wrap()`, the local ledger, live tailing, replay |

## License

[MIT](LICENSE)
