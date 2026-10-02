# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

optimAIzr is a local CLI that finds wasted tokens in Claude Code, Codex and your
own API calls, shows what each fix would save, and checks it on your own
traffic before you switch. No account, no upload, no telemetry. It reads token
counts, never your prompts.

```bash
npm i -g optimaizr
optimaizr profile
```

Or try it once without installing: `npx optimaizr profile`.

## New in 0.8.0: inside Claude Code

Claude Code now runs mods, plugins that work inside it. The optimAIzr mod puts
the numbers where you work, lets **Y** in `optimaizr live` switch the session
you are in, and shows what each switch saved.

```
  ⏺ optimaizr: this turn $0.18 · 4 requests · 5h 55% → 56%

  optimAIzr  █████████░░░░░░░  56% of 5h · resets 15:00
  ❯
```

Install it from a Claude Code session (2.1.287 or later):

```
/plugin marketplace add blendbunjaku/optimaizr
/plugin install optimaizr@optimaizr
```

- **The cost while Claude works.** The spinner shows what the turn has cost so
  far and how full your 5-hour window is. The band above the prompt shows the
  window, how long it lasts at this pace and when it resets, from Claude Code's
  own limit meter. Each answer gets one line with its cost, its requests and
  how far the window moved.
- **Switches in the session you are in.** Press **Y** on a model swap in
  `optimaizr live` and the running session uses the cheaper model from its next
  request. No restart, no `/model`. A reasoning-effort finding lowers effort
  the same way.
- **What a switch saved.** A switched turn's line leads with the saving: the
  same tokens priced on the original model, less what they cost. The band keeps
  a running total.
- **Back in one command.** Harder task? `/optimaizr off` returns the session you
  are in to its own model and effort; `/optimaizr on` resumes.
- **A guard against retry loops.** When the same command fails twice in a row
  with nothing changed, the next identical attempt is held once and Claude is
  asked to change something first.
- **`/optimaizr`** prints the session's spend, what it saved, both plan windows
  and any switch.

It reads usage figures and the commands Claude runs, never your prompts or file
contents, and makes no network calls.
The source is in
[`mods/optimaizr`](https://github.com/blendbunjaku/optimaizr/tree/main/mods/optimaizr),
and `optimaizr mod` shows whether it is running.

## What it does

### See where your tokens go

`optimaizr profile` reads the sessions already on your machine and puts spend,
waste and the biggest fix on one screen. On a Claude plan, add `--plan pro`.

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
shows up.

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
- **Claude Code with the optimAIzr mod** switches the running session from
  its next request, and each answer then says what the switch saved. The
  switch is as narrow as the finding: one project, and only subagents when that
  is what it covered. If the API refuses the new model, the request goes out on
  the original.
- **Claude Code without the mod** reads its model at session start, so `Y`
  updates `~/.claude/settings.json` for your next session and prints the
  `/model` command that switches the current one.
- **Codex:** `Y` records your decision; type `/model` in Codex to switch.

Amounts in `live` are what the window actually cost, never projected to a
month. Low-confidence findings are printed rather than prompted.

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

- **Claude Pro, Max or Team:** `--plan pro` (or `max5`, `max20`, `team`,
  `team-premium`) shows each 5-hour session and how much of it goes on waste.
  Anthropic doesn't publish the limit, so run `optimaizr limit` when you hit it
  and optimAIzr learns yours.
- **ChatGPT plans:** nothing to set. Codex records OpenAI's own meter.
- **A monthly budget:** `--budget 300` names the day the cap runs out at this
  pace, and how many days the fixes buy back.

```
  ChatGPT Plus            $20.00/mo  what you pay
  API-equivalent         $117.72/mo  5.9x what you pay
  5-hour window                 82%  used · resets 01:49 · a full window ~$4.76
  Weekly window                 38%  used · resets Sep 25, 22:49
  Waste                          9%  fix it and you'd hit the limits ~10% later
```

`live` warns at 80% and 95% of a plan limit, and at 50, 80, 95 and 100% of a
budget. Save your plan or budget once in `~/.optimaizr/config.json`:
`{ "plan": "pro", "budget": 300 }`.

## Works with

| Source                     | Setup                             |
| -------------------------- | --------------------------------- |
| Claude Code                | None. Reads `~/.claude/projects`. |
| Codex                      | None. Reads `~/.codex/sessions`.  |
| Your Anthropic/OpenAI app  | One line with `wrap()`, below     |
| A usage export (CSV, JSON) | `optimaizr import usage.csv`      |

### In your app

```ts
import Anthropic from "@anthropic-ai/sdk";
import optimaizr from "optimaizr";

const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
```

`wrap()` returns the same client and records each call's usage to a local
ledger. It works the same with `new OpenAI()`, never changes a request unless
you accept a swap in `live`, and never throws into your code. Label call sites
with `optimaizr.withRoute("summarise-ticket", () => ...)` to get advice per
route.

## What it catches

13 detectors, each reporting its own evidence and confidence:

| Area            | Detects                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| Model choice    | Mechanical calls on an expensive model; reasoning spent on trivial output |
| Caching         | Low cache hit rate; the same large context re-sent across sessions        |
| Context         | Bloated system prompts, oversized inputs and outputs, huge tool results   |
| Agent behaviour | Repeated file reads, retry loops on the same failing call                 |
| Spend patterns  | Cost spikes, spend concentrated in a few sessions, price changes          |

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

Also `mod` (the Claude Code mod), `audit`, `tokens`, `guide` (which model for
which job), `limit`, `import`, `undo`, `providers` and `privacy`. Run
`optimaizr --help` for everything.

## Privacy

- Reads token counts, not prompts. Prompt text is stored only if you turn on
  sampled, redacted capture for `verify`.
- Keeps its data in `~/.optimaizr/` as plain JSON. `rm -rf ~/.optimaizr`
  removes everything.
- Makes network calls only in `verify` (to your own provider, with your own
  key) and in the optional Jev second opinion, which sends route metadata only.
- The Claude Code mod reads usage figures and the commands Claude runs, never
  your prompts or file contents, and makes no network calls.

`optimaizr privacy` prints the details, and
[SECURITY.md](https://github.com/blendbunjaku/optimaizr/blob/main/SECURITY.md)
lists every file read and written.

## Requirements

Node 20.11+. No runtime dependencies. `@anthropic-ai/sdk` and `openai` are
optional, needed only for `verify`.

## Links

- [Documentation](https://www.optimaizr.com/docs) and the full
  [CLI reference](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CLI.md)
- [Source on GitHub](https://github.com/blendbunjaku/optimaizr)
- [Changelog](https://github.com/blendbunjaku/optimaizr/blob/main/CHANGELOG.md)
- [Report a bug](https://github.com/blendbunjaku/optimaizr/issues)

## License

[MIT](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
