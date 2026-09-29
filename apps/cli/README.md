# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/optimaizr)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Find where your LLM spend is wasted, then verify and apply the savings.**

optimAIzr reads the token usage your coding agents and apps already record,
shows where the money goes, and proposes changes with the arithmetic behind
each one. It runs entirely on your machine: no account, no upload, no
telemetry, and it reads token counts, never your prompts.

Built for Claude Code and Codex users, whether you pay per token, work within a
monthly budget, or are on a Claude or ChatGPT plan and keep hitting the 5-hour
limit.

## Quick start

```bash
npx optimaizr profile --plan pro
```

```
  optimAIzr | profile
  2026-04-08 to 2026-09-22  (167.1 days)

  AI usage

  Spend                     $476.70  $452.56/month at the last 30 days' rate
  Calls                       4,062
  Tokens                     743.4M  739.7M in / 3.7M out

  Plan

  Claude Pro              $20.00/mo  what you pay
  API-equivalent         $452.56/mo  23x what you pay
  5-hour sessions                18  in the last 30 days
  Waste per session             10%  fix it and you'd hit the limit ~11% later
  This session               $35.97  since 20:00, resets 01:00

  Optimization

  Flagged calls                 931  22.9% of calls
  Potential savings       $44.59/mo  $542.48/year

  Biggest opportunity

  ! Model mismatch

    17% of your requests use a model whose capabilities exceed the
    detected workload requirements.
    671 calls affected.

  Next step
    optimaizr simulate model-fit
```

Paying per token? Leave out `--plan` and the dollars are your real bill.

## What it reads

| Source                     | Setup                              |
| -------------------------- | ---------------------------------- |
| Claude Code                | None. Reads `~/.claude/projects`.  |
| Codex                      | None. Reads `~/.codex/sessions`.   |
| Your Anthropic/OpenAI app  | One line: `optimaizr.wrap(client)` |
| A usage export (CSV, JSON) | `optimaizr import usage.csv`       |

Anthropic and OpenAI usage land in one schema, so a Claude call and a GPT call
are compared on the same axis.

## Commands

| Command                     | What it answers                              |
| --------------------------- | -------------------------------------------- |
| `optimaizr profile`         | Where am I wasting the most?                 |
| `optimaizr live`            | What is wasting money right now?             |
| `optimaizr why`             | Where does the money go, level by level?     |
| `optimaizr recommend`       | What can I change, ranked by saving?         |
| `optimaizr simulate <rule>` | What would the change save?                  |
| `optimaizr verify <rule>`   | Does the output still hold up on my traffic? |
| `optimaizr apply <rule>`    | What exactly do I change?                    |
| `optimaizr report`          | A shareable HTML report                      |
| `optimaizr card`            | Your last 30 days as an image to post        |

Also `audit`, `tokens`, `guide` (which model for which job), `limit`, `import`,
`undo`, `providers` and `privacy`. Run `optimaizr --help` for everything.

Every figure is labelled _measured_, _inferred_ or _estimated_, and `--why`
prints the calculation and assumptions behind it.

## What it catches

13 detectors, each reporting its own evidence and confidence:

| Area            | Detects                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| Model choice    | Mechanical calls on an expensive model; reasoning spent on trivial output |
| Caching         | Low cache hit rate; the same large context re-sent across sessions        |
| Context         | Bloated system prompts, oversized inputs and outputs, huge tool results   |
| Agent behaviour | Repeated file reads, retry loops on the same failing call                 |
| Spend patterns  | Cost spikes, spend concentrated in a few sessions, price changes          |

## Live recommendations

Run `optimaizr live` in a second terminal and use your agent as normal. It
follows Claude Code and Codex sessions (and apps using `wrap()`) as they are
written, and raises a fix the moment a pattern crosses its threshold.

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

Pressing **Y** changes what comes next, never the call already billed:

- **Your app (`wrap()`)** switches from its next request, with no restart. If
  the provider rejects the new model, the original request is sent instead.
  `optimaizr undo <rule>` reverts it.
- **Claude Code** reads its model at session start, so `Y` updates
  `~/.claude/settings.json` for your next session and prints the `/model`
  command that switches the current one.
- **Codex:** `Y` records your decision; type `/model` in Codex to switch.

Amounts in `live` are what the window actually cost, never projected to a
month. Low-confidence findings are printed rather than prompted, and each is
raised once per session.

## Subscriptions and budgets

**Claude Pro, Max or Team.** Usage is rationed in 5-hour sessions, so
`--plan pro` (or `max5`, `max20`, `team`, `team-premium`) shows each session's
API-equivalent value and how much of it goes on waste. Anthropic doesn't
publish the limit, so run `optimaizr limit` when you hit it and optimAIzr
learns yours; `live --plan pro` then warns at 80% and 95%.

**ChatGPT plans.** Nothing to set: Codex records OpenAI's own limit meter, so
`profile` shows your plan and the exact usage and reset time of each window.

```
  ChatGPT Plus            $20.00/mo  what you pay
  API-equivalent         $117.72/mo  5.9x what you pay
  5-hour window                 82%  used · resets 01:49 · a full window ~$4.76
  Weekly window                 38%  used · resets Sep 25, 22:49
  Waste                          9%  fix it and you'd hit the limits ~10% later
```

**A monthly budget.** `--budget 300` shows the day a monthly cap runs out at
this pace, and how many days the fixes buy back. `live --budget 300` warns at
50, 80, 95 and 100%.

Save your plan or budget once in `~/.optimaizr/config.json`:
`{ "plan": "pro", "budget": 300 }`.

## Use it in your app

```ts
import Anthropic from "@anthropic-ai/sdk";
import optimaizr from "optimaizr";

const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
```

`wrap()` returns the same client, recording each call's usage to a local
ledger. It works the same with `new OpenAI()`, never changes a request unless
you accept a swap in `live`, and never throws into your code. Label call sites
with `optimaizr.withRoute("summarise-ticket", () => ...)` to get advice per
route.

## Privacy

- Reads token counts, not prompts. Prompt text is stored only if you turn on
  sampled, redacted capture for `verify`.
- Keeps its data in `~/.optimaizr/` as plain JSON. `rm -rf ~/.optimaizr`
  removes everything.
- Makes network calls only in `verify` (to your own provider, with your own
  key) and in the optional Jev second opinion, which sends route metadata
  only.

`optimaizr privacy` prints the details, and
[SECURITY.md](https://github.com/blendbunjaku/optimaizr/blob/main/SECURITY.md)
lists every file read and written.

## Install

```bash
npm install -g optimaizr    # or run any command with npx
```

Requires Node 20.11+. No runtime dependencies. `@anthropic-ai/sdk` and
`openai` are optional, needed only for `verify`.

## Links

- [Documentation](https://www.optimaizr.com/docs) and the full
  [CLI reference](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CLI.md)
- [Changelog](https://github.com/blendbunjaku/optimaizr/blob/main/CHANGELOG.md)
- [Report a bug](https://github.com/blendbunjaku/optimaizr/issues)
- [Contributing](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CONTRIBUTING.md)

## License

[MIT](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
