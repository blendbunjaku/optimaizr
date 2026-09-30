# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

optimAIzr is a local CLI that finds wasted tokens in Claude Code, Codex and your
own API calls, shows what each fix would save, and checks it on your own
traffic before you switch. No account, no upload, no telemetry. It reads token
counts, never your prompts.

First presented on September 13, 2026, and open source since September 30,
2026.

```bash
npm i -g optimaizr
optimaizr profile
```

Or try it once without installing: `npx optimaizr profile`.

## What it does

### See where your tokens go

`optimaizr profile` reads the sessions already on your machine and puts spend,
waste and the biggest fix on one screen.

```
  Spend                     $476.70  $452.56/month at the last 30 days' rate
  Calls                       4,062
  Tokens                     743.4M  739.7M in / 3.7M out

  Flagged calls                 931  22.9% of calls
  Potential savings       $44.59/mo  $542.48/year

  ! Model mismatch

    17% of your requests use a model whose capabilities exceed the
    detected workload requirements.
    671 calls affected.
```

### Find out why

`optimaizr why` breaks spend down by provider, model, project and kind of work,
each level as a share of the one above.

```
  $132.47 total  across 1,807 requests

    anthropic                         $132.47  100% 1807 calls
      -> sonnet-5                         $99.47   75% 1640 calls
        -> kopshti-back                   $93.34   94% 1541 calls
          -> Mechanical                   $36.11   39% 746 calls
          -> Reasoning                    $27.52   29% 335 calls
          -> Generation                   $15.22   16% 141 calls
```

### Catch waste while you work

`optimaizr live` runs beside your agent and raises a fix the moment a pattern
shows up. Press **Y** and your app switches from its next request, or Claude
Code from its next session.

```
  ⚡ optimAIzr

  This task looks suitable for a cheaper model.

  Current:       Sonnet 5
  Suggested:     Haiku 4.5
  Observed cost: $0.202 / 26 calls

  [Y] Apply optimization
  [N] Continue
  [D] Why?
```

### Know what a fix is worth

Every finding comes with its own arithmetic: what the traffic costs now, what it
would cost after, and how far to trust the figure. `--why` prints the full
calculation and every assumption.

```
MEDIUM  441 mechanical calls ran on an over-specified model
        $5.76/mo est.  |  $70.12/yr  |  needs verification  |  model-selection

        now    $14.07  ->  after     $6.75  (441 calls, 12% of spend)
        confidence medium   quality impact medium   basis estimated
```

### Prove it before you switch

`optimaizr verify` replays your own recorded requests on the cheaper option and
scores the answers against your quality bar, so you never trade cost for worse
output.

```
   PASS   40 samples replayed

  cost/call   $0.0121 -> $0.0034
  projected   $61.40/mo saved
  this check cost you $0.38

  Quality checks
    ok   no-refusal               candidate 40/40, baseline 40/40
    ok   tool-name-matches        candidate 39/40, baseline 39/40
```

### Stay under your limits

On Claude Pro, Max or Team, `--plan pro` shows your 5-hour sessions and how much
of each goes on waste. On ChatGPT plans it reads OpenAI's own meter from Codex.
On a company budget, `--budget 300` names the day the money runs out.

```
  ChatGPT Plus            $20.00/mo  what you pay
  API-equivalent         $117.72/mo  5.9x what you pay
  5-hour window                 82%  used · resets 01:49 · a full window ~$4.76
  Weekly window                 38%  used · resets Sep 25, 22:49
  Waste                          9%  fix it and you'd hit the limits ~10% later
```

## Works with

| Source                     | Setup                                       |
| -------------------------- | ------------------------------------------- |
| Claude Code                | None. Reads `~/.claude/projects`.           |
| Codex                      | None. Reads `~/.codex/sessions`.            |
| Your Anthropic/OpenAI app  | One line: `optimaizr.wrap(new Anthropic())` |
| A usage export (CSV, JSON) | `optimaizr import usage.csv`                |

13 detectors cover oversized models, cache misses, bloated prompts, repeated
file reads, retry loops, runaway reasoning, cost spikes and more.

## Commands

| Command                     | What it answers                              |
| --------------------------- | -------------------------------------------- |
| `optimaizr profile`         | Where am I wasting the most?                 |
| `optimaizr why`             | Where does the money go?                     |
| `optimaizr live`            | What is wasting tokens right now?            |
| `optimaizr recommend`       | What can I change, ranked by saving?         |
| `optimaizr simulate <rule>` | What would the change save?                  |
| `optimaizr verify <rule>`   | Does the output still hold up on my traffic? |
| `optimaizr apply <rule>`    | What exactly do I change?                    |
| `optimaizr report`          | A shareable HTML report                      |
| `optimaizr card`            | Your last 30 days as an image to post        |

Run `optimaizr --help` for everything.

## Privacy

Everything runs on your machine and stays in `~/.optimaizr/`. The only network
calls are `verify` (to your own provider, with your own key) and the optional
Jev second opinion. [SECURITY.md](SECURITY.md) lists every file read and
written.

## Documentation

- [Package README](apps/cli/README.md): the full usage guide
- [CLI reference](docs/CLI.md): every command, flag and figure explained
- [Changelog](CHANGELOG.md)
- [optimaizr.com/docs](https://www.optimaizr.com/docs)

## Development

| Path             | Contents                                                        |
| ---------------- | --------------------------------------------------------------- |
| `apps/cli`       | The `optimaizr` command, published to npm                       |
| `packages/core`  | The analysis engine: pricing, ingestion, rules, reports         |
| `packages/local` | The Node host: `wrap()`, the local ledger, live tailing, replay |

```bash
npm install && npm run build && npm test
```

Requires Node 20.11+. See [CONTRIBUTING](docs/CONTRIBUTING.md).

optimAIzr Pro, the hosted product coming to
[optimaizr.com](https://www.optimaizr.com), is separate from this repository.

## License

[MIT](LICENSE)
