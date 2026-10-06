# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

optimAIzr is a local CLI that finds wasted tokens in Claude Code, Codex and your
own API calls, shows in exact dollars what each fix saves, applies the ones you
accept, and checks them on your own traffic. No account, no upload, no
telemetry. It reads token counts, never your prompts.

```bash
npm i -g optimaizr
optimaizr profile
```

Or try it once without installing: `npx optimaizr profile`.

## New in 0.9.0

optimAIzr now knows your plan, counts only what holds up, and shows its work.

```
  Your Claude Pro did $938.12/mo of work at API prices: 47x what you pay

  Savings found
    Clear waste             $13.07/mo  $159.01/yr · fix it, nothing to lose
    Likely, if you try      +$1.54/mo  model mismatch, excess reasoning
    Up to, if you test     $263.14/mo  compact earlier · 48% of calls carry over 200K of conversation
                            $54.45/mo  smaller default model · 16% of Opus 5.5 spend is light work
```

- **No setup.** Your Claude plan (Pro, Max, Team) is read from Claude Code
  itself, so `optimaizr profile` needs no flags.
- **Savings in exact dollars, by how sure they are.** Clear waste you can fix
  for free, likely savings, and the levers worth testing, each with the
  measured fact behind it. The tiers are never added together.
- **The biggest lever is usually the conversation itself.** Every call
  re-reads it. `optimaizr apply context-compaction` makes Claude Code and Codex
  compact at 200K, and `optimaizr undo context-compaction` puts it back.
- **`live` shows its work:** a status line, a notice when context jumps or
  passes 200K, and **Y** to compact earlier from then on.
- **Stricter detection.** Whole tasks are judged, not single calls, so
  debugging, file writes and switches that would not pay back are no longer
  counted. The figures are lower than in 0.8 and hold up when checked. See the
  [changelog](CHANGELOG.md).

## Inside Claude Code

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
  request. No restart, no `/model`. Subagents switch at once; a long
  conversation waits until reloading it into the new model pays back. A
  reasoning-effort finding lowers effort the same way. With
  `optimaizr live --auto`, confident switches apply without asking.
- **What a switch saved.** A switched turn's line leads with the saving: the
  same tokens priced on the original model, less what they cost. The band keeps
  a running total.
- **Back in one command.** Harder task? `/optimaizr off` returns the session you
  are in to its own model and effort; `/optimaizr on` resumes.
- **A guard against retry loops.** When the same command fails twice in a row
  with nothing changed, the next identical attempt is held once and Claude is
  asked to change something first.
- **`/optimaizr`** prints the session's spend, what it saved, both plan windows
  and any switch. `/optimaizr hud` shows it all as gauges and a sparkline.

It reads usage figures and the commands Claude runs, never your prompts or file
contents, and makes no network calls.
The source is in
[`mods/optimaizr`](https://github.com/blendbunjaku/optimaizr/tree/main/mods/optimaizr),
and `optimaizr mod` shows whether it is running.

## What it does

### See where your tokens go

`optimaizr profile` reads the sessions already on your machine and puts what
your plan does, the savings found, the biggest win and where the money goes on
one screen. Your Claude plan is detected; `--plan` is only for overriding it.

```
  optimAIzr | profile
  2026-04-08 to 2026-10-05  (180.2 days)

------------------------------------------------------------------

  Your Claude Pro did $938.12/mo of work at API prices: 47x what you pay
  $974.52 in this window · 7,693 calls · 1.98B tokens · list rates, not a bill

  Savings found
    Clear waste             $13.07/mo  $159.01/yr · fix it, nothing to lose
    Likely, if you try      +$1.54/mo  model mismatch, excess reasoning
    Up to, if you test     $263.14/mo  compact earlier · 48% of calls carry over 200K of conversation
                            $54.45/mo  smaller default model · 16% of Opus 5.5 spend is light work

  Biggest win  Compact earlier  TEST · possible
    Up to 28% less usage (~$263.14/mo), about 1.4x the work per 5-hour window

    What happened   48% of your Claude Code calls carried over 200K of
                    conversation
    Why it matters  Every call re-reads the whole conversation, so each
                    call costs more than the last: re-reading took 56% of
                    your Claude Code spend.
    What to do      Compact at 200K. Claude Code: add "env": {
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000" } to
                    ~/.claude/settings.json. Or compact by hand (/compact)
                    when you change topic. A summary can drop details from
                    early in a long conversation, so try it for a week and
                    compare.

------------------------------------------------------------------

  Where it goes

    Re-reading the conversation    56%  ███████████░░░░░░░░░
    Loading context into cache     24%  █████░░░░░░░░░░░░░░░
    Answers, code and thinking     20%  ████░░░░░░░░░░░░░░░░

  Clear waste and likely savings, item by item

    FIX   Oversized context               $12.15/mo  likely
    FIX   Oversized tool output           $0.847/mo  likely
    TRY   Model mismatch                   $1.75/mo  likely
    TRY   Excess reasoning                $0.415/mo  likely
    +1 smaller, under $0.25/mo each: optimaizr recommend
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

`optimaizr live` runs beside your agent, says what it sees and raises a fix the
moment a pattern shows up. Press **Y** and your app switches from its next
request, and so does Claude Code with the [optimAIzr mod](#inside-claude-code).
Without it, Claude Code switches from its next session.

```
◉ optimAIzr live · 1 call · $0.031 this run · last Opus 5.5 $0.031, 120.5K context · no issues · checked 3s ago

  ⚠  12:31:07  Long conversation now 215.5K of context
        Every call re-reads all of it: $0.043 on this call alone, before any work (Opus 5.5).

  ⚡ optimAIzr · Switch eligible requests from Sonnet 5 to Haiku 4.5 · likely

  What happened   11 simple calls ran on Sonnet 5
  Why it matters  These jobs were within reach of a model one tier
                  down, so the bigger model's price bought nothing
                  extra: the same work costs 50% less there.
  Change          Sonnet 5 -> Haiku 4.5
  Saving          $0.110 could have been saved on 11 calls in the last 10 min

  [Y] Apply   [N] Not now   [D] Why?
```

### Know what a fix is worth

Every finding says what happened, why it matters and what to do, with its own
arithmetic and how sure it is. Clear waste (FIX) is the headline; what changes
the model's output is TRY; trade-offs are TEST and only ever "up to". `--why`
prints the full calculation and every assumption.

```
  FIX   Oversized context · likely
        $12.14/mo | $147.69/yr | a change in habit | context-bloat

        What happened   25 small tasks started with ~449.4K of context;
                        similar tasks start near 65.9K
        Why it matters  Every call in those tasks re-reads the whole history,
                        so a small job costs as much as a big one.
        What to do      Start small, unrelated jobs in a fresh conversation
                        (/clear), or /compact when you change topic.
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

- **Claude Pro, Max or Team:** detected from Claude Code, nothing to set. It
  shows each 5-hour session and how much of it goes on waste; with the mod
  running, Claude Code's own 5-hour and weekly meters. Without the mod, run
  `optimaizr limit` when you hit the limit and optimAIzr learns yours.
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
budget. To override the detected plan or set a budget, save it once in
`~/.optimaizr/config.json`: `{ "plan": "max20", "budget": 300 }`.

## Works with

| Source                     | Setup                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| Claude Code                | None. Reads `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`. |
| Codex                      | None. Reads `~/.codex/sessions`, or `$CODEX_HOME/sessions`.         |
| Your Anthropic/OpenAI app  | One line with `wrap()`, below                                       |
| A usage export (CSV, JSON) | `optimaizr import usage.csv`                                        |

Two Claude accounts? Point it at each one:
`CLAUDE_CONFIG_DIR=~/.claude-personal optimaizr profile`. The plan, the
transcripts and any setting it applies all follow that folder.

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
| `optimaizr undo <rule>`     | How do I take it back?                       |
| `optimaizr report`          | A shareable HTML report                      |
| `optimaizr card`            | Your last 30 days as an image to post        |
| `optimaizr changelog`       | What changed in this version?                |

Also `mod` (the Claude Code mod), `audit`, `tokens`, `guide` (which model for
which job), `limit`, `import`, `providers` and `privacy`. Run
`optimaizr --help` for everything.

## Privacy

- Reads token counts, not prompts. Prompt text is stored only if you turn on
  sampled, redacted capture for `verify`.
- Keeps its data in `~/.optimaizr/` as plain JSON. `rm -rf ~/.optimaizr`
  removes everything.
- Makes network calls only in `verify` (to your own provider, with your own
  key), in the optional Jev second opinion, which sends route metadata only,
  and once a day to the npm registry for the latest version number, which
  sends nothing about you. `OPTIMAIZR_NO_UPDATE_CHECK=1` turns that off.
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
