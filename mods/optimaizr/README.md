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
- **Each answer** gets one line: `optimaizr: this turn $0.18 · 4 requests · 5h 55% → 56%`
- **What a switch saved:** a switched turn's line leads with it, e.g.
  `saved $0.10 vs Opus 5.5 · this turn $0.10 on Sonnet 5.5 · …`, and the band
  keeps a running total. It is the same tokens priced on both models.
- **`/optimaizr`** prints the session's spend, what it saved, both plan windows
  and any switch. **`/optimaizr hud`** shows it as gauges and a sparkline.
- **Switches that pay:** subagents switch at once; a long conversation waits
  until reloading it into the new model pays back, and the band says so.
- **Before the cache expires:** Claude Code caches the conversation for an
  hour. Once it carries 50K tokens or more, the band counts down the last 15
  minutes, `cache     warm 10m more, then 300K is written again ($2.40)`, and one
  toast comes 5 minutes before. After it expires, the band says what the next
  message will cost. Past 200K, it says what each request re-reads.
- **`/optimaizr handoff`:** Claude writes a short note (what changed, what was
  decided, what is open, what to check first) while the cache is still warm,
  so it costs cents. `/clear`, and the next conversation in that project
  starts from the note instead of re-reading the old one. A note is used
  once and expires after 12 hours.
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
reads `~/.optimaizr/overrides.json` and writes one small file per session to
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

The tests were last run on Claude Code 2.1.286, where mods still needed
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. From 2.1.287 they are on by default.
