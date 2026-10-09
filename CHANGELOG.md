# Changelog

## 0.10.2

- **How your compactions really went.** The compaction finding reads Claude
  Code's own record of each compaction and says how many there were, how many
  were automatic, how many landed mid-task, and how long you waited for the
  summaries. It also prices compacting later, at 300K, 400K and 600K, next to
  200K.
- **`optimaizr apply context-compaction --at 400K`** sets a later point, from
  100K to 1M, and `optimaizr undo context-compaction` puts back what was there.
  Claude Code compacts a little before the point you set (around 167K with
  200K), and the output now says so.
- **Compact by hand when a piece of work is done.** Automatic compaction
  usually lands mid-task, so the finding suggests
  `/compact keep the API decisions` at a natural break instead.
- **A shorter handoff note**: three lines (done, next, the file to open
  first), under 80 words, in the mod and in the cache warning.
- **A plan with no Claude Code usage** no longer headlines "$0.00/mo, 0.0x".
  `optimaizr plan` names the folder it looked in instead.
- **Small fixes.** "from 1 days" reads "from 1 day". Codex limit readings from
  days ago show their date instead of passing for today. The status line in
  `optimaizr live` no longer leaves copies of itself in panes narrower than
  they report.
- **Coming from 0.9?** 0.10.0 is the one to read: `optimaizr statusline on`
  puts a cache countdown under Claude Code's prompt, and `optimaizr sessions`
  shows where long conversations turn expensive. `optimaizr changelog 0.10.0`
  has all of it.

## 0.10.1

- **A shorter README** that leads with what optimAIzr does and what it found,
  with the last three releases in one line each. No code changes.
- **Coming from 0.9?** 0.10.0 is the one to read: `optimaizr statusline on`
  puts a cache countdown under Claude Code's prompt, and `optimaizr sessions`
  shows where long conversations turn expensive. `optimaizr changelog 0.10.0`
  has all of it.

## 0.10.0

**Where long sessions really lose money, measured, and a way out of them, from
the terminal you already have open.**

- **`optimaizr statusline on`.** Claude Code's own status line, under the
  prompt, shows the conversation's size, what each call pays to re-read it,
  and how long its cache stays warm. In the last 15 minutes it counts down and
  says what coming back after will cost; once the cache has gone it says what
  the next message pays. Your 5-hour meter sits at the end. No mod needed. It
  never replaces a status line you already have, and `optimaizr statusline
off` takes it out. `optimaizr statusline` on its own says whether it is on
  and shows what it would say for your latest conversation.
- **`optimaizr live` counts down as well**, for Claude Code and Codex. The
  status line at the bottom shows the warm cache that expires first, a
  warning comes 5 minutes before a long conversation's cache expires (only
  when coming back would cost 50 cents or more), and a call that came back to
  an expired cache is shown with what it paid against a warm read. `--json`
  emits both as `cache` events.
- **`optimaizr --help` is grouped**: start here, change things, go deeper.
- **`optimaizr sessions`** answers the questions people asked about the 0.9
  numbers, from your own logs and with nothing estimated: how long sessions
  run, the context size where re-reading becomes half of what a call costs,
  whether the money sits in a few long sessions or many medium ones, and how
  often you came back to a conversation after its cache expired. `--json` for
  the numbers.
- **Cold cache returns, a new rule (try tier).** Come back to a long
  conversation after its cache expired and the first call writes all of it
  again, at 2x the input rate on Claude Code's 1-hour cache. The rule counts
  those returns from the cache writes they recorded and prices a fresh start
  from a short handoff note against them, net of the note and the new
  session's setup. Codex too: OpenAI caches on its own and sets no fixed
  lifetime, so there a return is a mostly uncached call after 5 minutes or
  more away, priced at the full input rate it paid.
- **The compaction lever prices the reload at the rate your conversations
  use.** After a compaction the conversation is written to the cache again;
  that write is now priced at the 1-hour rate when that is what the
  conversations use, not the 5-minute one, so the lever comes out lower and
  closer to what a compaction costs.
- **Re-reading is described at its real rate.** The profile and share card
  say it is billed at the cache-read rate, the cheapest there is, and nothing
  says "a tenth" any more: on Opus 5.5 a cache read is a twentieth of input.
- **The mod counts down to the cache expiring.** Once a conversation carries
  50K tokens or more, the band shows the last 15 minutes of its cache and what
  coming back after will cost, with one toast 5 minutes before. Past 200K it
  says what each request re-reads, once as a toast and then in the band.
- **`/optimaizr handoff`.** Claude writes a short note (what changed, what was
  decided, what is open, what to check first) from the warm cache, for cents.
  `/clear`, and the next conversation in that project starts from it. A note
  is used once, within 12 hours, and stays on your machine.

## 0.9.0

**optimAIzr knows your plan, counts only what holds up, and shows its work.**

- **Your plan, detected.** `optimaizr profile` reads which Claude plan you are
  signed in to (Pro, Max 5x or 20x, Team) from Claude Code's own account
  details, so `--plan` is no longer needed. Only the plan fields are read. When
  the tier isn't reported it says so and asks, it never guesses, and `--plan`
  or the config still win. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected.
- **Stricter detection.** Calls are grouped into tasks (a prompt and every
  call it set off) and the rules judge the task. Fix-and-rerun debugging, files
  being written, a subagent's own reads, re-reads after an edit or a
  compaction, and model switches that would not pay back their cache reload
  are no longer counted. Figures are lower than in 0.8 and hold up when
  checked: on the author's own usage the headline went from $121/mo to $13/mo
  of clear waste. The 0.8.1 note below quotes $89.56/mo for model-fit on a
  month of real use; most of that was steps inside bigger tasks, and 0.9 puts
  the same month at $1.74/mo.
- **Savings in three tiers, in exact dollars.** Clear waste (fix it, nothing
  to lose) is the headline. Likely savings that change what the model does
  show as `+$X`. Trade-offs worth testing show as `up to $X` and are never
  added in. `waste`, `recommend` and `profile` now agree on the total.
- **Every recommendation says what happened, why it matters and what to do**,
  and how sure it is: high confidence, likely or possible.
- **Two levers, sized from your own usage**, for Claude Code and Codex.
  Compact earlier: every call re-reads the conversation, which is usually the
  biggest part of the bill, and compacting at 200K is replayed on your own
  sessions, net of what the compactions cost. A smaller default model, for
  work without heavy reasoning. `optimaizr apply context-compaction` sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for Claude Code and
  `model_auto_compact_token_limit` for Codex; `optimaizr undo
context-compaction` puts back what was there.
- **A new profile.** It leads with what your plan does at API prices, then the
  savings found, the biggest win (on a plan, as more work per 5-hour window)
  and where the money goes. The share card follows it.
- **`live` shows its work.** A status line with calls, spend, the last call
  and what it found; a notice when a conversation's context jumps or passes
  200K, with what re-reading costs on that call; `Y` to compact earlier from
  then on; cards that say what happened, the change and the money; and a
  summary when you stop.
- **Codex** gets tasks, blind-retry detection (a non-zero exit now counts as
  a failure), both levers and its own compactions. A model now steps down to
  its own smaller variant: GPT-5.4 to GPT-5.4 mini, not GPT-5 mini.
- **The mod** writes Claude Code's real 5-hour and weekly meters into its
  session file, so `profile` and `live` show them instead of a learned limit.
- **Update awareness.** Once a day a background request asks the npm registry
  for the latest version number (nothing about you or your usage is sent, and
  no command waits for it), and a later run says when there is a newer one.
  `optimaizr changelog` shows what changed. Off with
  `OPTIMAIZR_NO_UPDATE_CHECK=1` or `"updateCheck": false` in the config.

## 0.8.1

- **`optimaizr live --auto`.** Confident model and effort findings about
  Claude Code are applied through the mod without asking; everything else still
  asks. Each automatic switch says so once, in a toast and a note, the band and
  the pane mark it `(auto)`, and `p` in the HUD or `/optimaizr off` undoes it.
  The payback check below still holds a long conversation back.
- **A switch waits until it pays.** Switching a conversation mid-way means the
  new model reloads it into its cache, and on a long session that can cost
  more than the switch saves. The mod now weighs it: the reload's cost against
  what an average request in this session saves, and it switches a
  conversation under way only when that pays back within 10 requests. Until
  then the band says `waiting` and why, such as `reload $0.38 pays back in
~43 requests`. Subagents start with an empty cache, so they switch right
  away, and so does a conversation idle for over an hour, whose cache has
  expired.
- **Opus steps down to Sonnet, not Haiku.** The model-fit finding moves simple
  work one tier down within its provider: Opus to Sonnet 5.5 (half the price),
  Sonnet to Haiku 4.5, GPT-5 to GPT-5 mini. Sonnet 5.5's 1M-token window also
  takes the long-context calls Haiku's 200K window couldn't, so the finding
  usually covers more traffic: on one month of real use, $89.56/mo instead of
  $45.51.
- **`/optimaizr hud`.** A heads-up display docked beside Claude: what it
  is doing right now (`● on Sonnet 5.5`, `● waiting`, `● paused`), what the
  switch saved, how much cheaper it ran and roughly what share of your
  5-hour window that is, spend, burn rate per hour, cache
  hits, both plan windows as gauges with when the 5-hour one runs out, a
  coloured sparkline of the last turns with the priciest one named, and a
  button (`p`) that pauses or resumes the switch.
- **A meter you can read at a glance.** The band's meter turns from green to
  yellow to red as the window fills, and a toast says when it passes 80% and
  95%, with the time left at this pace. Another says when a session's savings
  pass $0.50, $1, $2 and so on.
- **Subagent savings priced right.** A subagent writes its cache from scratch
  on either model, so its first request no longer counts as a reload.

- **Fixes.** A model-fit finding over more than one model (Opus and Sonnet
  traffic, each with its own step down) could no longer be applied with Y. It
  can again, each model to its own target. The question card no longer repeats
  `Change:` on every wrapped line, and `--auto` says why when it asks after all.

## 0.8.0

**optimAIzr inside Claude Code.** Claude Code 2.1.287 added mods, plugins that
run inside Claude Code itself, and optimAIzr now ships one. Install it from a
Claude Code session:

```
/plugin marketplace add blendbunjaku/optimaizr
/plugin install optimaizr@optimaizr
```

- **The numbers where you work.** While Claude works, the spinner shows what
  the turn has cost so far and how full your 5-hour window is. The band above
  the prompt shows the window, how long it lasts at this pace and when it
  resets, read from Claude Code's own limit meter rather than estimated. Each
  answer gets one dim line with its cost, its requests and how far the window
  moved (the `turnLine` option turns it off). `/optimaizr` prints the
  session's spend, both plan windows and any active switch.
- **`Y` in `live` switches the running Claude Code session.** Claude Code reads
  its model when a session starts, so until now `Y` could only change the next
  one. With the mod loaded, an accepted swap reaches running sessions from
  their next request, with no restart. It is as narrow as the finding: one
  project, and only subagents or only the main conversation when that is what
  the finding covered, and only when it covers at least 80% of that traffic's
  spend. If the API refuses the new model, the request goes out on the
  original and the session stays on it. The first switched request leaves a
  note in the conversation, and the band keeps saying which model you are on.
  For a harder task, `/optimaizr off` sends that session back to its own model
  and `/optimaizr on` resumes; `optimaizr undo <rule>` removes the switch
  everywhere within seconds. Without the mod, `Y` still writes
  `~/.claude/settings.json` for your next session.
- **See what a switch saved.** Each switched request is priced twice: what it
  cost, and what the same tokens would have cost on the original model. A
  switched turn's line leads with the difference (`saved $0.10 vs Opus 5.5 ·
this turn $0.10 on Sonnet 5.5 · …`), the band keeps a running total and
  `/optimaizr` adds it up for the session. The first request on the new model
  writes the conversation to its cache, where the original model would have
  read it, so it can cost more; its line says by how much, and why.
- **Lower reasoning effort, live.** Accept a reasoning-effort finding in `live`
  and sessions running the mod use less effort on that work from their next
  request, on the same model. It only ever lowers effort, and
  `/optimaizr off` goes back. Like a model switch, the first request at the
  new effort reads the conversation once without the cache.
- **A guard against retry loops.** When the same command fails twice in a row
  with nothing changed in between, the mod holds the next identical attempt
  once and asks Claude to change something first. Asked again, it goes
  through. The `retryGuard` option turns it off.
- **`optimaizr mod`** prints the install steps, which sessions are running the
  mod, and any active switch. `--json` for scripts.
- **Still fully local.** The mod reads the usage figures Claude Code already
  shows you, the commands Claude runs (kept in memory for the retry guard) and
  `~/.optimaizr/overrides.json`, and writes one small file per session to
  `~/.optimaizr/mod/sessions`. It never reads your prompts or file contents and
  makes no network calls; `claude plugin validate mods/optimaizr` lists every
  call it makes.
- **Findings say where they came from.** Each `live` finding lists the
  sessions behind it and its latest calls: time, session id (marked `sub` for
  a subagent), project, and what the call did, e.g. `Read .../src/app.ts` or
  `Bash npm test`. `optimaizr show <rule>` prints the same under every row,
  and `live --json` carries `sessions` and `examples`. With several agents
  running at once, you can now tell which one a finding is about.
- **`live` stays quiet about cents.** A finding must have cost $0.25 over the
  window before it is announced (was $0.01). `--min-usd` still overrides it.
- **Windows project names.** `show` now shortens `C:\...\repo` to `repo`.

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
