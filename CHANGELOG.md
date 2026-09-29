# Changelog

## 0.7.1

- **New README and tagline.** The npm page leads with what optimAIzr does,
  with real output for each step, and `optimaizr --help` and the package
  description now read "Spend fewer tokens on the same work." No behaviour
  changes.

## 0.7.0

- **Claude Team plans.** `--plan team` (Standard seat, $25) and
  `--plan team-premium` ($125) show your 5-hour sessions like Pro and Max,
  priced per seat. `--plan enterprise` and `--plan free` explain what to use
  instead: Enterprise bills usage at API rates, so `--budget` is its measure,
  and Free doesn't include Claude Code.
- **Every ChatGPT plan Codex reports, named and priced.** Pro 5x ($100) and
  Pro 20x ($200) are told apart, Go is priced at $8, and Team shows under its
  new name, Business. A plan newer than optimAIzr is shown as Codex names it,
  without a price.
- **Claude Sonnet 5.5.** Priced at $2/$10 per million tokens (cache reads
  $0.20) and reported as its own model. Before, its calls were counted as
  Sonnet 5.
- **`optimaizr limit` points at your plan.** Its closing hint said
  `--plan pro` for everyone; it now uses the plan you set.
- **`verify`'s judge has room to answer.** Opus 5 thinks by default, and a
  16-token ceiling could cut it off before its verdict, which scored as a tie.
  The ceiling is now 1,024.
- **Fixes.** The cost-spike finding pointed at a `why --day` flag that doesn't
  exist (it now suggests `optimaizr show cost-spike`). A flag written
  `--name=a=b` kept only `a`. `live` read recent history up to three times at
  start and now reads it once.
- **Open source.** The CLI, its analysis engine and the local host are now
  developed in the open at
  [github.com/blendbunjaku/optimaizr](https://github.com/blendbunjaku/optimaizr),
  under the MIT license.

## 0.6.1

- **`Y` in `live` switches your app's next request.** Apps using `wrap()` pick
  up an accepted model swap from their next call, with no restart.
  `optimaizr undo <rule>` takes it back the same way, and `optimaizr undo`
  lists what is active.
- **Large Claude Code histories are read in full.** Past roughly 100,000
  recorded responses, reading transcripts failed with "Maximum call stack size
  exceeded" and reports showed Codex usage only. One unreadable transcript is
  now skipped instead of taking the rest with it.
- **A source that fails can't be missed.** If one can't be read, every command
  says so at the top, in red.
- **`optimaizr feedback`** prints where to report a bug, with the version line
  to include.

## 0.6.0

- **5-hour sessions on Claude Pro and Max.** `--plan pro` (or `max5`, `max20`)
  shows how much of the current session you've used, when it resets, and how
  much of each session goes on waste. Anthropic doesn't publish the limit, so
  run `optimaizr limit` when you hit it and it learns yours.
- **ChatGPT plans, read straight from Codex.** Codex records OpenAI's own
  meter, so `profile` shows your plan, how much of the 5-hour and weekly limits
  you've used, and when each resets.
- **Limit warnings in `live`.** Warns at 80% and 95% of your Codex limits and
  your Claude session limit, and `live --budget 300` at 50, 80, 95 and 100% of
  a monthly cap.
- **Monthly budgets.** `--budget 300` names the day a monthly cap runs out at
  this pace, and how many days the fixes buy back.
- **`optimaizr card`.** Your last 30 days as an image to share. Totals only,
  no project names.
- **"At this rate" means now.** Monthly figures project your last 30 days
  instead of averaging your whole history.

## 0.5.0

- **`optimaizr profile`.** One screen: what you spend, how much of it is waste,
  and the single biggest opportunity, with the next command to run.
- **Current models priced.** Claude Opus 5.5 and Fable 5.1, GPT-6 Astra, Sol
  and Luna, and GPT-5.1 through 5.6. Before, some of these were costed at an
  older model's rate or went unpriced.
- **OpenAI cache writes.** GPT-5.6 and later bill cache writes at 1.25x input,
  and past 272K input tokens the whole request moves to the long-context rate.
  Both are now costed as OpenAI bills them.

## 0.4.0

- **`optimaizr live`.** Watches calls as they land and raises a fix the moment
  a pattern crosses its threshold, using the same rules as the reports. Follows
  Claude Code and Codex sessions as they are written, and the SDK ledger.
- **Codex transcripts.** OpenAI agent spend is read from `~/.codex/sessions`
  with no setup.
- **Gemini, built but off.** Enable with `OPTIMAIZR_GEMINI=1` once you've
  checked its rates.
- **Self-contained reports.** The HTML report makes no network requests.
