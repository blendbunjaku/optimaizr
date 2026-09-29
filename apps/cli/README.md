# optimAIzr

**Find where your LLM spend is wasted, then verify and apply the savings.**

**100% local.** No account, no upload, no telemetry. It reads token counts,
never your prompts.

For Claude Code and Codex users, whether you pay per token, spend a monthly
budget from your company, or are on Claude Pro/Max or ChatGPT Plus/Pro and keep
hitting the 5-hour limit.

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

Paying per token? Leave out `--plan`. The dollars are then your real bill.

---

## New in 0.7.0

- **Claude Team.** `--plan team` (Standard seat, $25) and `--plan team-premium`
  ($125) show your 5-hour sessions like Pro and Max, priced per seat.
  `--plan enterprise` and `--plan free` say what to use instead: Enterprise
  bills usage at API rates, so `--budget` is its measure, and Free has no
  Claude Code.
- **Every ChatGPT plan Codex reports, named and priced.** Pro 5x ($100) and
  Pro 20x ($200) are told apart, Go is priced at $8, and Team shows under its
  new name, Business. A plan newer than optimAIzr is named as Codex reports it,
  without a price.
- **`optimaizr limit` points at your plan.** It used to say `--plan pro`
  whatever you were on; it now uses the plan you set.
- **Claude Sonnet 5.5.** Priced at $2/$10 (cache reads $0.20) and reported as
  its own model. Before, its calls were counted as Sonnet 5.
- **`verify`'s judge has room to answer.** Opus 5 thinks by default, and a
  16-token ceiling could cut it off before its verdict, which scored as a tie.
- **Smaller fixes.** The cost-spike finding pointed at a `why --day` flag that
  doesn't exist (it now says `optimaizr show cost-spike`); `--flag=a=b` kept
  only `a`; `live` read your history up to three times at start.

---

## New in 0.6.1

- **`Y` in `live` now switches your app's very next request.** Apps using
  `wrap()` pick up an accepted model swap from their next call, with no
  restart. `optimaizr undo <rule>` takes it back the same way, and
  `optimaizr undo` lists what is active.
- **Large Claude Code histories are read in full.** Past roughly 100,000
  recorded responses (a few months of heavy use), reading Claude Code
  transcripts failed with "Maximum call stack size exceeded" and reports
  quietly showed Codex usage only. Fixed, and one unreadable transcript is now
  skipped instead of taking the rest with it.
- **A source that fails is impossible to miss.** If one can't be read, every
  command says so at the top, in red, including `profile` and the "nothing to
  analyse" screen.
- **`optimaizr feedback`** prints where to report a bug, with the version line
  to include.

---

## New in 0.6.0

- **Your 5-hour sessions, on Claude Pro and Max.** `--plan pro` (or `max5`,
  `max20`) shows how much of the current session you've used, when it resets,
  and how much of each session goes on waste. Anthropic doesn't publish the
  limit, so run `optimaizr limit` when you hit it: after a couple of hits it
  knows yours.
- **ChatGPT plans, read straight from Codex.** No flag needed: Codex records
  OpenAI's own meter, so `profile` shows your plan, how much of the 5-hour and
  weekly limits you've used, and exactly when each resets. Plus how much of it
  went on waste.
- **Live recommendations now warn before you hit a limit.** `optimaizr live`
  already flagged waste while your agent runs. Now it also warns at 80% and 95%
  of your Codex limits (automatically) and your Claude session limit
  (`--plan pro`), and `live --budget 300` at 50, 80, 95 and 100% of a monthly
  cap.
- **Monthly budgets.** If your company gives you a fixed amount per month,
  `--budget 300` names the day it runs out at this pace, and how many days the
  fixes buy back.
- **A card to share.** `optimaizr card` turns your last 30 days into an image:
  what it costs at API prices, tokens, top model, how much was waste. Totals
  only, no project names.
- **"At this rate" means now.** Monthly figures project your last 30 days
  instead of averaging your whole history.

---

## Fully local

- **Nothing to set up.** It reads the transcripts Claude Code and Codex already
  write on your machine (`~/.claude/projects`, `~/.codex/sessions`).
- **Nothing leaves your machine.** No account, no telemetry, no upload. Its own
  records are plain JSONL in `~/.optimaizr/`; `rm -rf ~/.optimaizr` removes
  everything.
- **Token counts, not token contents.** Prompt text is never stored unless you
  switch capture on for `verify`.
- **One network call, and it's yours.** `verify` replays requests to your own
  provider with your own key. Nothing else talks to the network.
- `optimaizr privacy` prints exactly what is collected, stored and sent.

---

## Why optimAIzr

- **Zero setup for agents.** Reads Claude Code and Codex sessions straight from
  disk. Nothing to instrument.
- **Live, not after the bill.** `optimaizr live` flags waste while your agent
  runs, and applies a model switch with one key: from your app's very next
  request, or your agent's next session.
- **One line for your team's app.** Wrap an Anthropic or OpenAI client and
  every service's spend and savings land in real dollars per month.
- **Savings you can trust.** Every figure is labelled _measured_, _inferred_ or
  _estimated_, and `--why` shows the maths behind it.
- **Verify before you switch.** Replays your own traffic on the cheaper option
  and scores it, so you never trade cost for worse output.

---

## Get started

**Coding agents: nothing to change.**

```bash
npx optimaizr profile             # usage, waste and your biggest bottleneck
npx optimaizr profile --plan pro  # on Claude Pro/Max: your 5-hour sessions
npx optimaizr live                # recommendations as your agent runs
npx optimaizr card                # your last 30 days as an image to share
```

**Your app: one line.**

```ts
import optimaizr from "optimaizr";

const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
const openai = optimaizr.wrap(new OpenAI(), { service: "checkout-api" });
```

Already have a usage export? `optimaizr import usage.csv`.

---

## Live recommendations

Open a second terminal, run `optimaizr live`, and use your agent as normal.
optimAIzr follows Claude Code and Codex sessions (and the `wrap()` ledger) as
they are written, and raises a fix the moment a pattern crosses its threshold.

```bash
npx optimaizr live
```

High-confidence findings ask you what to do:

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

The rest are printed as they appear, each with the next command to run:

```
  LOW   9:47:41 PM  Stop retrying identical failing calls
        $0.015 observed over 114 calls / 22m of traffic
        Identical failing calls were retried without changing anything.
        > optimaizr apply error-loops - safe, no quality question
```

- **Same rules as the reports.** A call analysed live and the same call analysed
  tomorrow produce identical numbers.
- **Observed, never projected.** Amounts are what the live window actually cost.
  A few minutes of traffic is never annualised.
- **`Y` changes what comes next, never the call on screen.** That call was
  billed before optimAIzr saw it. How soon the next one changes depends on who
  sends it:
  - **Your app (`wrap()`)**: from its very next request, with no restart. `Y`
    writes a model override to `~/.optimaizr/overrides.json`, scoped to the
    service, route and model the finding covered, and wrapped clients check it
    before every request. If the provider rejects the new model, the original
    request is sent instead. `optimaizr undo <rule>` reverts it the same way;
    `wrap(client, { overrides: false })` or `OPTIMAIZR_OVERRIDES=0` opts out.
    Calls made through the `.stream()` helper are never rewritten; use
    `create({ stream: true })`.
  - **Claude Code**: it reads its model only when a session starts, so no
    outside tool can switch the session that's running. When the swap covers
    at least 80% of your Claude Code spend, `Y` writes it to
    `~/.claude/settings.json` for your next session and prints the `/model`
    command that switches this one now.
  - **Codex**: `Y` records your decision; type `/model` in Codex to switch.

  When nothing can apply it, or the swap covers too little traffic for a global
  change, `Y` records your decision and hands you `optimaizr verify <rule>`.

- **Quiet by design.** The same rule and route is raised once per session.

On a plan, it also watches your 5-hour session once it knows your limit:

```
  SESSION ~80% of your usual session limit used ($21.50 of ~$26.90) · resets 01:00
          switch mechanical work to a smaller model to make the rest last: /model sonnet
```

Flags: `--plan pro|max5|max20|team|team-premium` (session alerts), `--budget N` (warn at
50/80/95/100% of a monthly cap), `--backfill N` (replay recent history first),
`--window N`, `--min-usd N`, `--source all|agents|sdk`, `--no-prompt`, `--json`.

---

## On Claude Pro, Max or Team

Usage there isn't billed per token, it's rationed in 5-hour sessions. The dollar
figures are what the same work would cost on the API, which is still the right
measure: a bigger model drains a session faster, roughly in proportion to what
it costs.

```bash
optimaizr profile --plan pro   # sessions, waste per session, the one running now
optimaizr limit                # run this when Claude says you've hit the limit
optimaizr limit --at 15:10     # or record one after the fact
optimaizr live --plan pro      # warns at 80% and 95% of your learned limit
```

`--plan` takes `pro`, `max5`, `max20`, `team` (a Standard seat) or
`team-premium`. Set it once with `{ "plan": "pro" }` in
`~/.optimaizr/config.json` (or `{ "plan": "api" }` if you pay per token, to hide
the plan hint). On Enterprise, usage is billed at API rates under a spend limit,
so use `--budget <your limit>` instead. Sessions are rebuilt from timestamps,
and weekly limits aren't modelled yet.

---

## On ChatGPT Plus or Pro (Codex)

Nothing to set. Codex writes OpenAI's own limit meter into its session files, so
`optimaizr profile` finds your plan and shows it next to the waste:

```
  Codex · plan and limits read from Codex, not guessed

  ChatGPT Plus            $20.00/mo  what you pay
  API-equivalent         $117.72/mo  5.9x what you pay
  5-hour window                 82%  used · resets 01:49 · a full window ~$4.76
  Weekly window                 38%  used · resets Sep 25, 22:49
  Waste                          9%  fix it and you'd hit the limits ~10% later
```

The percentages and reset times are OpenAI's, not estimates. `optimaizr live`
warns at 80% and 95% of each window. Sessions run with an API key have no
meter, so they show as plain spend.

---

## The loop

```
profile     optimaizr profile    where am I wasting the most?
watch       optimaizr live       what is wasting money right now?
explain     optimaizr why        where does the money go?
recommend   optimaizr recommend  what can I change?
simulate    optimaizr simulate   what would that save?
verify      optimaizr verify     would the output still be good?
apply       optimaizr apply      the exact change, once verified
```

Also: `audit`, `report` (shareable HTML), `card` (your last 30 days as an image
to post), `guide` (which model for which job), `privacy`. Run `optimaizr --help` for everything.

---

## What it catches

Cache misses, oversized context, models too big for the job, repeated file
reads, runaway reasoning, bloated prompts, retry loops, cost spikes and more:
13 detectors in all.

---

## Install

```bash
npm install optimaizr
```

Node 20.11+. Zero runtime dependencies. The Anthropic and OpenAI SDKs are
optional, needed only for `verify`.

Data stays in `~/.optimaizr/` as plain JSONL. The only network call is `verify`,
to your own provider with your own key.

Full docs: [optimaizr.com/docs](https://optimaizr.com/docs).

## License

MIT
