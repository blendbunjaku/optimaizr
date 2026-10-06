# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

optimAIzr is a local CLI that finds wasted tokens in Claude Code, Codex and your
own API calls, shows in exact dollars what each fix saves, applies the ones you
accept, and checks them on your own traffic. No account, no upload, no
telemetry. It reads token counts, never your prompts.

First presented on September 13, 2026, and open source since September 30, 2026.

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
The source is in [`mods/optimaizr`](mods/optimaizr).

## What it does

### See where your tokens go

`optimaizr profile` reads the sessions already on your machine and puts what
your plan does, the savings found, the biggest win and where the money goes on
one screen.

```
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
                    when you change topic.

  Where it goes

    Re-reading the conversation    56%  ███████████░░░░░░░░░
    Loading context into cache     24%  █████░░░░░░░░░░░░░░░
    Answers, code and thinking     20%  ████░░░░░░░░░░░░░░░░
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

On Claude Pro, Max or Team your plan is detected, and `profile` shows your
5-hour sessions and how much of each goes on waste; with the mod running it
shows Claude Code's own 5-hour and weekly meters. On ChatGPT plans it reads
OpenAI's own meter from Codex. On a company budget, `--budget 300` names the
day the money runs out.

```
  ChatGPT Plus            $20.00/mo  what you pay
  API-equivalent         $117.72/mo  5.9x what you pay
  5-hour window                 82%  used · resets 01:49 · a full window ~$4.76
  Weekly window                 38%  used · resets Sep 25, 22:49
  Waste                          9%  fix it and you'd hit the limits ~10% later
```

## Works with

| Source                     | Setup                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| Claude Code                | None. Reads `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`. |
| Codex                      | None. Reads `~/.codex/sessions`, or `$CODEX_HOME/sessions`.         |
| Your Anthropic/OpenAI app  | One line: `optimaizr.wrap(new Anthropic())`                         |
| A usage export (CSV, JSON) | `optimaizr import usage.csv`                                        |

Two Claude accounts? Point it at each one:
`CLAUDE_CONFIG_DIR=~/.claude-personal optimaizr profile`. The plan, the
transcripts and any setting it applies all follow that folder.

13 detectors cover oversized models, cache misses, bloated prompts, repeated
file reads, retry loops, runaway reasoning, cost spikes and more, and two
levers size what compacting earlier or a smaller default model would save.

## Commands

| Command                     | What it answers                               |
| --------------------------- | --------------------------------------------- |
| `optimaizr profile`         | Where am I wasting the most?                  |
| `optimaizr why`             | Where does the money go?                      |
| `optimaizr live`            | What is wasting tokens right now?             |
| `optimaizr mod`             | Is the Claude Code mod installed and running? |
| `optimaizr recommend`       | What can I change, ranked by saving?          |
| `optimaizr simulate <rule>` | What would the change save?                   |
| `optimaizr verify <rule>`   | Does the output still hold up on my traffic?  |
| `optimaizr apply <rule>`    | What exactly do I change?                     |
| `optimaizr undo <rule>`     | How do I take it back?                        |
| `optimaizr report`          | A shareable HTML report                       |
| `optimaizr card`            | Your last 30 days as an image to post         |
| `optimaizr changelog`       | What changed in this version?                 |

Run `optimaizr --help` for everything.

## Privacy

Everything runs on your machine and stays in `~/.optimaizr/`. The only network
calls are `verify` (to your own provider, with your own key), the optional Jev
second opinion, and a once-a-day request to the npm registry for the latest
version number, which sends nothing about you and is off with
`OPTIMAIZR_NO_UPDATE_CHECK=1`. [SECURITY.md](SECURITY.md) lists every file read and
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
| `mods/optimaizr` | The Claude Code mod, installed from this repo's marketplace     |

```bash
npm install && npm run build && npm test
```

Requires Node 20.11+. See [CONTRIBUTING](docs/CONTRIBUTING.md).

optimAIzr Pro, the hosted product coming to
[optimaizr.com](https://www.optimaizr.com), is separate from this repository.

## License

[MIT](LICENSE)
