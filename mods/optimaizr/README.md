# optimAIzr for Claude Code

A Claude Code mod from [optimAIzr](https://github.com/blendbunjaku/optimaizr).
It puts what your session costs where you work, lets `optimaizr live` switch
the model or effort of the session you are in, and shows what each switch
saved.

```
/plugin marketplace add blendbunjaku/optimaizr
/plugin install optimaizr@optimaizr
```

Needs Claude Code 2.1.287 or later.

## What it adds

- **The spinner** shows what the turn has cost so far and how full your 5-hour
  window is: `Thinking · $0.18 · 61% of 5h…`
- **The band above the prompt** shows the window, how long it lasts at this
  pace and when it resets: `61% of 5h · ~2h 25m left at this pace · resets 01:00`
- **Each answer** gets one line: `optimaizr: this turn $0.18 · 2m 10s · 4 requests · ~0.4% of 5h`.
  The share is the turn's own, from its dollars, not the meter before and after:
  other sessions move the meter too. It shows once `optimaizr sessions` or
  `optimaizr live` has worked out what 1% of your window costs.
- **What a switch saved:** a switched turn's line leads with it, e.g.
  `~$0.10 less than the same tokens on Opus 5.5 · this turn $0.10 on Sonnet 5.5 · …`,
  and the band keeps a running total. It prices the tokens the new model used
  on both models; it can't know what the original model would have used.
- **`/optimaizr`** prints the session's spend, what it saved, both plan windows
  and any switch. **`/optimaizr hud`** shows it as gauges and a sparkline.
- **Switches that pay:** subagents switch at once; a long conversation waits
  until reloading it into the new model pays back, and the band says so.
- **Before the cache expires:** Claude Code caches the conversation for an
  hour. Once it carries 50K tokens or more, the band counts down the last 15
  minutes, `cache     warm 10m more, then 300K is written again ($2.40)`, and one
  toast comes 5 minutes before. After it expires, the band says what the next
  message will cost. Past 200K, it says what each request re-reads.
- **`/optimaizr handoff`:** Claude writes a four-line note (done, what was
  tried and dropped, next, the file to start from) while the cache is still warm,
  so it costs cents. `/clear`, and the next conversation in that project
  starts from the note instead of re-reading the old one. A note is used
  once and expires after 12 hours. Once the cache has expired, the note
  costs what your next message would, so it says how much and goes ahead
  only when you run it again. It is not `/compact`: `/compact` shrinks the
  conversation you are in and carries on, a handoff starts a new one.
- **A heavy start:** when a new conversation's first request carries 60K or
  more before any work (a usual start is about 30K), one toast says so and
  points to `/context`, which shows what fills it: MCP tools, agents, skills,
  memory files. Once a session, never after `/resume` or compaction.
- **A guard against retry loops:** when the same command fails twice in a row
  with nothing changed, the next identical attempt is held once and Claude is
  asked to change something first.
- **Switches.** Press **Y** on a model swap in
  [`optimaizr live`](https://www.npmjs.com/package/optimaizr) and running
  sessions in that project use the new model from their next request. A
  reasoning-effort finding lowers effort the same way. The first switched
  request leaves a note, and the band names the model. Harder task?
  `/optimaizr off` goes back for this session, `/optimaizr on` resumes, and
  `optimaizr undo <rule>` takes it back everywhere.

## Options

| Option       | Default | What it does                                  |
| ------------ | ------- | --------------------------------------------- |
| `turnLine`   | `true`  | The line under each answer with what it cost. |
| `retryGuard` | `true`  | Hold a command that failed twice unchanged.   |

## Privacy

It reads the usage figures Claude Code already shows you (cost, token counts,
context fill, plan windows) and the commands Claude runs, kept in memory for
the retry guard. It never reads your prompts or file contents and makes no
network calls of its own. It
reads `~/.optimaizr/overrides.json` and `~/.optimaizr/window-rate.json`, and
writes one small file per session to
`~/.optimaizr/mod/sessions`, which is how `optimaizr live` knows it is running.
That file also carries Claude Code's own 5-hour and weekly meters, so
`optimaizr profile` and `optimaizr live` can show your real windows.
`/optimaizr handoff` is the one exception to "no text": only when you run it,
it asks Claude for a note through your own session and saves the reply to
`~/.optimaizr/mod/handoffs`, one file per project, which the next conversation
there reads once. Nothing leaves your machine besides that one request to Claude.
`claude plugin validate` on this folder lists every call it makes.

## Develop

```bash
claude --plugin-dir mods/optimaizr     # reloads on save
claude plugin validate mods/optimaizr
claude plugin test mods/optimaizr
```

The tests were last run on Claude Code 2.1.312.
