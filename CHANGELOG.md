# Changelog

## 0.13.0

- **optimAIzr for VS Code.** Most of my Claude Code runs in VS Code, where the
  chat panel draws no status line, so the cache countdown was out of sight.
  The new extension puts the conversation in the folder you have open in VS
  Code's status bar: `143K · 54:51 · 5h 56%` is 143K of context, 54 minutes
  51 seconds left on its cache and 56% of the 5-hour window used. It turns
  yellow in the cache's last five minutes and red past 90% of the window.
  Search optimAIzr in Extensions, or
  `code --install-extension optimAIzr.optimaizr-vscode`.
- **A heads-up before an expensive cache expires.** About 5 minutes before a
  long conversation's cache runs out, when coming back after it would cost
  $0.50 or more: "Reply before then to skip a $1.14 rewrite." on mine.
- **The savings, guard and every fix in a sidebar.** It leads with what is
  left to save, up to 13% on mine, about 1.1x the work per 5-hour window, with
  compaction at 200K already applied. Guard is one switch: 51 returns to an
  expired cache wrote 8.9M tokens again in my last 30 days, $56.02/mo. The
  fixes come biggest money first, 4 on mine for $60.48/mo, and habits get an
  I did this button so `results` can measure them. Compaction at 200K and its
  undo are one click each, and the full report opens in an editor tab.
- **A done alert.** A desktop notification when a turn of 45 seconds or more
  finishes while VS Code is in the background, on macOS and Linux.
- The status bar, heads-up, guard and done alert watch Claude Code; the
  savings also read Codex and opencode. Everything is worked out on your
  machine. Guard uses this CLI, and the extension offers to install it. It
  needs VS Code 1.90 or newer.
- **Big opencode histories are read again** (#20). With 500 busy sessions the
  parts query returned about 120k rows, and passing them on in one call
  overflowed Node's stack, so the opencode history was left out without a
  word. Rows now go one at a time, and a database that fails to read is named
  in the profile. The same fix covers a Codex rollout with 100k+ calls, which
  dropped all Codex history, and `results` over a baseline that long.
- **No console windows on Windows.** Guard's background refresh started
  through a shell, and Windows opened a console window for every run. It now
  starts Node directly and hidden, and so does the daily update check.
- **Big logs, measured.** My 434 MB of Claude Code history reads in 1.9 s at
  228 MB of memory, and a 537 MB Codex rollout with 120k calls in 3.0 s at
  242 MB.

## 0.12.1

- **Everything it found, in one figure.** The profile now opens with every
  saving together: "Up to 30% of it can be saved: about 1.4x the work per
  5-hour window and per week" on mine, then where the 30% comes from. The
  largest saving counts first and each one after it only on what the ones
  before it leave, so two changes never save the same dollar: a plain sum of
  mine would have said 33%. Off a plan it is dollars a month, and under 5% in
  all the profile shows the tiers on their own lines, as before.
- **Your 5-hour limit, learned with nothing to set up.** Claude Code writes
  each request it refused because the 5-hour window ran out into the
  transcript, with the time the window resets. optimAIzr now reads those, so
  the profile, `live` and `sessions` know your limit in the terminal and in VS
  Code alike, where until now it needed `optimaizr limit` by hand or the
  status line. What a window had used is counted from its real start: mine, 7
  hits in four weeks, all between $33.50 and $42.06. A retry before the reset
  is the same hit, and `optimaizr limit` stays for the ones the transcripts
  miss.
- **Guard holds say what they cost your plan.** On a Claude plan, a held
  message now leads with its share of the 5-hour limit, like "about 3% of
  your 5-hour limit ($1.30 at API prices, Opus 5.5)", and the cheaper model's
  line says the same. The rate is the one `sessions` and `live` already learn,
  and the profile and guard's weekly run now keep it fresh.
- **Guard no longer holds a forced wait.** A conversation the 5-hour limit
  stopped mid-task had its cache expire while you were locked out, so the
  message after the reset goes through, and so does a bare "continue" (or
  "go on", "keep going"), which asks for the work `/clear` would lose. On my
  machine the one hold of that kind was sent again in 3 seconds. The
  refusal is also no longer taken for Claude's last reply in the handoff
  note.
- **The compact nudge comes in time.** Claude Code compacts under its
  setting: with 200K set, my 76 automatic compactions since Oct 7 were at
  168K on the median. A nudge from 75% of 200K had only 150K to 168K to
  fire in, and a turn ended there before 13 of them. Guard now learns where
  it really compacts (the last 10 times under your setting, once there are 3) and nudges from 75% of that, 126K on mine: 25 of the 76. Another 35 came
  inside one long turn, where no end-of-turn nudge can reach.
- **`results` says "Not clear yet" when the baselines disagree.** My own
  compaction change read "Working: 4% to 22% less per prompt": 22% against
  the 16 days before, 4% against the 5 days before, which is inside the 10%
  swing. A verdict of Working or Not working now needs every baseline past
  10%; otherwise it is Not clear yet, with the trade-offs that did move.
- **`optimaizr` offers guard once, with your own numbers.** The first report
  that finds $5 or more of messages guard would have held in the last 30 days
  says how many and what they cost, and asks "Turn guard on? [Y/n]". Mine
  would have read 40 messages after a break, $90.26 to write their
  conversations into the cache again where a warm cache would have read them
  for $2.26. Under $5 it waits for a later run. It asks once, only in a
  terminal, and never if guard was ever on.
- **The weekly line counts your stops at the 5-hour limit.** Next to
  re-reading and cold returns, against the week before: mine reads "1 stop at
  the 5-hour limit (was 1)". Retries before the reset are one stop. It shows
  only when either week had one, and guard's catches now say the week
  before's too.
- **Guard warns before the 5-hour limit stops you.** Once half the window is
  used, guard works out in the background whether the last hour's pace runs
  it out before the reset, and says so once, at the end of a turn: "your
  5-hour limit runs out around 14:09, 51 minutes before it resets at 15:00",
  with `/model sonnet` when you are on Opus. Tried on my last 51 windows, it
  came before all 7 stops, 19 minutes to 2h 44m ahead (67 on the median), and
  in 10 of the 44 windows without one, 4 of which still ended at 80% of the
  limit or more. It needs your limit learned: from the status line, Claude
  Desktop or a stop in the transcripts.

## 0.12.0

**Guard: the expensive moments, held before they are paid.**

- **`optimaizr guard on`.** It adds Claude Code hooks next to your own, no mod
  needed, and holds each of these once, letting it through when it comes
  again: a message to a conversation idle past its cache, when writing it all
  again costs $0.50 or more (with what that costs, and on Opus or Fable what
  Sonnet would pay); a whole read of a file over 64KB, so Claude reads the part
  it needs; a command that failed twice in a row with nothing changed since.
  Near the compaction point, the end of a turn says once that this is a good
  moment to `/compact`. A headless run's message (`claude -p`, the SDK) is
  never held, and `optimaizr guard off` takes out only its own hooks.
- **Start fresh from a note.** When a message is held, `/clear` in that
  conversation starts the new one from a short note of where the old one
  stood: the last ask, the files changed, what was tried and dropped, open
  todos and a clip of the last reply. It is written on your machine from the
  transcript, read once by the `/clear` of the held conversation and then
  deleted; a note nobody reads goes after 30 minutes.
- **What it kept.** Every hold, and what went through after all, goes to
  `~/.optimaizr/guard/receipts.jsonl`. One number counts only the holds that
  stuck, like "4 catches, $2.17 not spent": `live` opens with it, and the
  profile, `results` and the status line show it. `optimaizr guard` lists the
  last 7 days.
- **Once a week.** How the last 7 days compare with the 7 before: the share
  of spend going to re-reading, returns to a cold cache, and what guard kept.
  `live` and the profile open with it, and with guard on, Claude Code shows it
  at the end of a turn once a week.
- **`optimaizr live`, redesigned.** It opens with a legend instead of a
  manual. The bottom keeps a row for each open conversation, each in its own
  colour: a spinner and the cost so far while Claude works, how long the cache
  stays warm once it stops (yellow in the last 15 minutes), and the model and
  effort it runs on. Under them, the run's status line: what it cost, the
  costliest conversation, and what was found. `?` shows what was checked and
  passed, `n` the next step for the biggest finding, and `a` applies it when
  it is a setting optimAIzr can undo.
  `--notify` sends a system notification for a cache about to expire, a cold
  return, and a long turn done. Each finished turn is one line, with a second
  over 100K saying what every message re-reads first, and a cold return says
  whether you were away or Claude was waiting on a tool.
- **What the model and effort cost.** On Opus or another top model, `?` says
  what the same calls would cost one model down, and why it is often not half:
  re-reading a long conversation costs the same on Opus 5.5 and Sonnet 5.5. At
  max or xhigh it says what share went to thinking, and that `/effort` keeps
  the cache. Both are a choice, never counted as waste, and show only when
  they would move the bill by a tenth or more.
- **`optimaizr results` gives a range.** The headline is measured against the
  3, 5, 7 and 14 days before, and says the range, so a drop that was already
  under way shows. Every row that got worse is marked as a trade-off, a new
  row counts files read again after summaries, and the end says what guard
  kept.
- **`optimaizr sessions` and the cache.** How much of your spend was on the
  1-hour cache and how much on the 5-minute one. Cold returns are split into
  you away and Claude waiting on a tool, and on the 5-minute cache it names
  the commands that outlasted it. Each 5-hour window lists the conversations
  that spent it and how many ran at once. Runs from `claude -p`, the SDK or
  `codex exec` are tagged headless. Conversations started from guard's note
  are measured against compactions: the first call, the wait, files read
  again and calls per prompt.
- **Help, regrouped.** `optimaizr help` shows the commands you use, the older
  views moved under `optimaizr help all`, and `optimaizr <command> --help`
  gives that command's own flags.
- **Open models are priced.** DeepSeek V4, GLM, Kimi and MiniMax M3 through
  opencode, from each vendor's own price list: DeepSeek at half price off-peak,
  MiniMax M3's long-context rate, the free GLM models at $0. They are never
  suggested as a switch. A model with no price card takes what opencode
  recorded for the call, and calls nothing could price are counted as $0 with
  the models named.
- **The handoff note in the mod** has a Dropped line too: what was tried and
  given up, so the next conversation doesn't try it again.
- **Fixed.** The 5-hour window spans the earliest to the latest call, whatever
  order they arrive in. After a compaction only the new conversation counts
  as warm. The profile's next step for a coding agent is `apply`, not
  `simulate`. The docs and the mod said a switch to low effort may
  read the conversation again without the cache. `/effort` keeps it, low too;
  the one uncached read came from how the mod switched. In Claude Code, the
  advice for coming back to a cold cache points to `optimaizr guard on`, and
  `live` names a long conversation by its title, like its other notices.

## 0.11.1

- **opencode support.** optimAIzr reads opencode's history next to Claude
  Code and Codex, with no setup: `~/.local/share/opencode/opencode.db`, opened
  read-only. Every report covers it, `optimaizr live` follows it as it runs,
  and `apply` gives the steps for its findings. Compacting earlier is still set
  for Claude Code and Codex only. It needs Node 22.13 or later, for Node's
  built-in SQLite.
- **Left out, and said so.** History from opencode 2.0 isn't read yet. When
  the database holds it, or Node is too old to open it, the report and `live`
  say so instead of leaving it out quietly.
- **SECURITY.md and `optimaizr privacy`** list the opencode database and what
  is read from it: session titles and folders, the usage on each reply, and
  tool calls without their output. Never your prompts or the replies' text.
- **Coming from 0.10?** 0.11.0 is the one to read: `optimaizr results`
  measures whether a change worked on your own usage, and `optimaizr sessions`
  opens with your costliest conversations. `optimaizr changelog 0.11.0` has
  all of it.

## 0.11.0

**Did the change work? optimAIzr now measures it, on your own usage.**

- **`optimaizr results`.** For each change you made, the days after it against
  the days before (14, or as many as it has been in, up to 30), judged on cost
  per prompt for the agent and project it covers. Next to it: calls per prompt,
  tool errors, calls past the compaction point, compactions a day and time
  spent waiting on summaries, so a saving that costs you something shows it.
  Codex is measured the same way, from its own compactions, except for the
  wait: Codex doesn't record how long a summary takes. Until there are 3
  active days and 100 prompts it says how far along it is and when to look
  again. It names what it can't separate: a short baseline, a shift between
  projects, another change in the same days, a drop that was already under
  way.
- **A journal of changes.** Every change optimAIzr makes, and every undo, goes
  into `~/.optimaizr/changes.jsonl`. Compaction settings and model switches
  from earlier versions are read from where they were kept, so a change made
  on 0.10 is measured too.
- **`optimaizr apply` lists what you can change.** On its own it shows the
  changes optimAIzr makes for you, on or off, and the ones only you can make,
  with what each is worth. For a Claude Code or Codex finding, `apply <rule>`
  prints the steps, with no verification gate and no file to write. Once you
  have made a change, `optimaizr apply <rule> --done` records it, with the
  agent and project it covers, so `results` can measure it, and
  `optimaizr undo <rule>` records when you stopped. Findings from your app's
  SDK traffic still need a passing `verify`.
- **The profile knows what you changed.** An Applied block at the top says how
  each change is doing so far, and a finding with a change in place for at
  least half of its spend leaves the savings and the biggest win. Until
  anything is applied, the profile opens with one fact from your own usage and
  the one command to start with.
- **`optimaizr metrics`** counts realised savings only from what `results`
  measured, and shows how many changes are in place.
- **What each conversation cost.** `optimaizr sessions` opens with your
  costliest conversations, by the title Claude Code gave them: what each cost
  with its subagents, how long the agent worked on it (pauses over 15 minutes
  left out) and its share of the 5-hour window. `--top N` lists more, and
  `--json` gives them all.
- **A line after every turn.** `optimaizr live` says when a Claude Code turn
  ends, how long it took, what it cost and its own share of the 5-hour window,
  then the conversation so far: `2m 10s · $0.620 · ~1.5% of 5h`. The share
  comes from the turn's dollars, not the meter before and after, because other
  sessions move the meter too. It works for the VS Code extension. `--no-turns`
  hides it. The mod's turn line adds the time and the same share.
- **What 1% of your window costs, learned.** From Claude Desktop's meter
  history and the readings `optimaizr statusline` now logs to
  `~/.optimaizr/meter.jsonl` when the meter moves, against what Claude Code
  spent meanwhile, once three windows have moved 5 points or more. Until then,
  your plan's estimated limit over 100.
- **More machines.** CI builds and tests on Linux, macOS and Windows, on Node
  20.11, 22 and 24. On an older Node, `optimaizr` says which version it needs
  instead of failing somewhere inside.
- **Corrections.** The docs and `optimaizr privacy` say that what each tool
  call was given (a path, a command, the first 200 characters of anything
  else) is read from agent logs in memory and never stored, and that a
  `wrap()` record keeps those 200 characters. `guide` and the docs give each
  model's own cache rate: Opus 5.5 reads at a twentieth of input, not a
  tenth. The docs and the mod no longer say every effort switch reloads the
  cache: only a switch to low has been seen to. The biggest win's line lost a
  stray space before its comma.
- **Haiku 5.5 is priced,** with its 5x rate past 100K of prompt. Suggested
  switches still go to Haiku 4.5.

## 0.10.3

- **Conversations that start heavy.** A new finding, `heavy-start`, measures
  how big each project's conversations are before your first message. From
  60K, it says what carrying that on every call cost and points to `/context`
  to see what fills it: MCP servers, agents and skills you don't use, a long
  CLAUDE.md. The mod says so once a session when a new conversation starts
  that heavy.
- **What each cache write was for.** `optimaizr sessions` splits cache writes
  by cause: new content, new conversations, compactions, subagents, coming
  back after a break, rebuilds while the cache was warm and model switches.
  It adds up the ones that wrote again what the cache already held.
- **`/optimaizr handoff` on an expired cache says what it costs first.**
  Writing the note means paying for the whole conversation again, so the mod
  names the price and hands off only when you run it again within 2 minutes.
  The warnings also say which to use: `/compact` keeps the conversation going,
  a handoff starts a fresh one.
- **`apply context-compaction` checks your model's window.** Claude Code
  compacts at whichever comes first, the model's context window or the point
  you set, so on a 200K model compacting at 200K changes nothing. It now says
  so, leaves the setting alone and suggests a point that does, like
  `--at 150K`. With a 1M model in use as well, it applies and names the model
  it changes.
- **Compacting by hand comes first.** The compaction finding leads with
  `/compact` at a natural break, with your own count of compactions that
  landed mid-task, and the 200K setting second. On a plan, each saving in the
  profile also shows as a share of your usage.
- **Plainer wording.** A model switch in the mod reads "~$0.10 less than the
  same tokens on Opus 5.5": it is a price difference on the tokens used, not
  a measured saving. Coming back to an expired cache reads "You came back to
  an expired cache 38 times: 12.9M of conversation written again".
- **Coming from 0.9?** 0.10.0 is the one to read: `optimaizr statusline on`
  puts a cache countdown under Claude Code's prompt, and `optimaizr sessions`
  shows where long conversations turn expensive. `optimaizr changelog 0.10.0`
  has all of it.

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
