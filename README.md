# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![GitHub stars](https://img.shields.io/github/stars/blendbunjaku/optimaizr?style=flat)](https://github.com/blendbunjaku/optimaizr/stargazers)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

[![optimaizr live catching a cold cache return while Claude Code works. Click to watch the 42-second demo.](https://raw.githubusercontent.com/blendbunjaku/optimaizr/main/docs/demo.jpg)](https://optimaizr.com/demo)

In a long Claude Code session, most of what you pay for isn't Claude writing
code. It's Claude re-reading your conversation on every call (56% of my bill),
cheap per token but paid again and again, and writing it into the cache again
after a break, at up to twice the input price: 62 of those cost me $114.95,
where a warm cache would have read it for $3.27. optimAIzr shows where your
tokens go, holds the expensive message before it is paid, and fixes what it can
in one command. For Claude Code, Codex and opencode.

```bash
npx optimaizr
```

No account, no upload, no telemetry. It reads token counts from the logs already
on your machine, never your prompts or Claude's answers. To spot repeated work
it also reads what each tool call was given (a file path, a command, the first
200 characters of anything else), in memory only, and stores none of it.

```
  Your Claude Pro did $938.12/mo of work at API prices: 47x what you pay

  Savings found
    Clear waste             $13.07/mo  $159.01/yr · fix it, nothing to lose
    Likely, if you try      +$1.54/mo  model mismatch, excess reasoning
    Up to, if you test     $263.14/mo  compact earlier · 48% of calls carry over 200K of conversation

  Where it goes
    Re-reading the conversation    56%  ███████████░░░░░░░░░
    Loading context into cache     24%  █████░░░░░░░░░░░░░░░
    Answers, code and thinking     20%  ████░░░░░░░░░░░░░░░░
```

## Catch the expensive moments

**The cache countdown.** Claude Code keeps a conversation cached for an hour.
Come back later and your first message writes all of it again. One command puts
a countdown under Claude Code's prompt, with what coming back will cost.

```bash
optimaizr statusline on
```

```
◉ optimAIzr · 161.0K context, $0.032/call to re-read · cache warm 12m, then $1.29 to write again · leaving? handoff note, then /clear · 5h 61%
```

**Guard: the expensive message, held once.** With `optimaizr guard on`, a
message to a long conversation whose cache has expired is held once, with what
sending it would cost. Mine, after 3 days away:

```
optimAIzr held this message once. The conversation has been idle 3 days and its
cache expired, so sending it writes all 162K tokens again: about $1.30 on Opus 5.5.
It was not sent: copy it from Original prompt below. Send it again to go ahead,
or type /clear and send it there: the new conversation starts from a short note
of where this one stood.
On Sonnet 5.5 the same rewrite is about $0.40: /model sonnet, then send it again.
```

Send it again and it goes through. Its first day on my machine: two held
messages, $2.17 not spent. Guard also stops Claude reading a big file
whole, or running a command that failed twice a third time unchanged, and
nudges `/compact` before a conversation compacts in the middle of a task. It
uses Claude Code's own hooks, no mod, and `optimaizr guard` lists what it held.

**Live, beside your agent.** `optimaizr live` keeps a row for each open
conversation: a spinner and the cost so far while Claude works, how long the
cache stays warm once it stops. It warns when context jumps or passes 200K, and
5 minutes before a cache expires. **?** shows what it checked, **n** the next
step for the biggest finding, **a** applies it. After each turn it says what
that turn cost and how much of your 5-hour window it took, and `--notify` sends
a system notification when the terminal is out of sight.

**Where long sessions turn expensive.** `optimaizr sessions` opens with your
costliest conversations, by the title Claude Code gave them, and what each one
took of your 5-hour window (mine, with the titles changed):

```
  Costliest conversations (subagents included)
         cost   of 5h   worked   conversation
       $91.16   ~222%   1h 53m   Refactor payment webhook handling
       $89.81   ~219%   2h 21m   Migrate auth to session tokens
       $74.40   ~182%   2h 36m   Build analytics dashboard filters
       $74.35   ~181%   1h 31m   Fix flaky checkout integration tests
       $71.99   ~176%   2h 25m   Add search indexing pipeline
    The top 5 of 122 conversations, 34% of spend.
    5h share at $0.410 per 1%, learned from 27 windows of your plan meter.
```

Then it finds the context size where re-reading takes over, what each cache
write was for, which conversations shared each 5-hour window, and every time a
cache expired before the next call, with who was waiting:

```
  Cold cache returns
    62 times a long conversation's cache had expired by its next call, and
    all of it was written again: 14.0M tokens for $114.95, where a warm
    cache would have read it for $3.27.
      you were away                    55   $109.84
      Claude was waiting on a tool      7     $5.11
```

## Fix it in one command

```bash
optimaizr apply context-compaction   # Claude Code and Codex compact at 200K
optimaizr undo context-compaction    # and back
optimaizr results                    # did it work?
```

```
  Compact earlier: Claude Code at 200K
  applied Oct 7, 12 days ago

  Working: 5% to 24% less per prompt than the 3 to 14 days before. It
  comes with a cost: calls per prompt, tool errors per prompt,
  compactions a day, files read again after summaries a day and waiting
  for summaries a day went up.

                                                before     after
    cost per prompt                              $1.06    $0.803   -24%
    calls per prompt                               7.5        12   +64%  trade-off
    tool errors per prompt                        0.21      0.35   +68%  trade-off
    calls past 200K                                60%        0%   -60 pts
    compactions a day                             0.23       5.2   23x  trade-off
    files read again after summaries a day        0.38       6.2   16x  trade-off
    waiting for summaries a day                   0.4m      6.8m   16x  trade-off
```

That's my own change, 12 days in, with a few rows left out. The range is the
baselines: 24% less against the 14 days before, 5% against the 5 days before,
so part of it may have been under way already. Every row that got worse is
marked.

Every finding says what happened, why it matters and what it saves, in dollars
from your own logs. Savings are split into clear waste, likely, and "up to", and
never added together.

## Inside Claude Code

The optional optimAIzr mod runs inside the session: the cost of each answer and
your 5-hour window as you work, **Y** in `live` moves the session you're in to a
cheaper model, and `/optimaizr handoff` writes a note to start fresh from.

```
  ⏺ optimaizr: this turn $0.18 · 2m 10s · 4 requests · ~0.4% of 5h

  optimAIzr  █████████░░░░░░░  56% of 5h · resets 15:00
```

```
/plugin marketplace add blendbunjaku/optimaizr
/plugin install optimaizr@optimaizr
```

## Commands

| Command                   | What it does                                    |
| ------------------------- | ----------------------------------------------- |
| `optimaizr`               | Where your tokens go, and what to fix first     |
| `optimaizr live`          | Watches every open conversation while you work  |
| `optimaizr guard on`      | Holds an expensive message once, before it goes |
| `optimaizr statusline on` | The cache countdown under Claude Code's prompt  |
| `optimaizr sessions`      | Where long conversations start to cost more     |
| `optimaizr why`           | Spend by model, project and kind of work        |
| `optimaizr apply <rule>`  | Applies a fix; `undo <rule>` takes it back      |
| `optimaizr results`       | Did it work? The days after against before      |
| `optimaizr verify <rule>` | Replays your own requests on the cheaper option |
| `optimaizr card`          | Your last 30 days as an image to post           |

`optimaizr help` lists the rest, `optimaizr help all` every view.

## Works with

Claude Code, Codex and opencode 1.x with no setup. opencode history is read
from `~/.local/share/opencode/opencode.db` (under `$XDG_DATA_HOME` when that is
set) and needs Node 22.13 or later. History from opencode 2.0 isn't read yet.
Reports, `live` and the steps in `apply` cover all three;
`apply context-compaction` changes Claude Code and Codex only.

Your Claude plan (Pro, Max, Team) and ChatGPT plan are detected. Your own app
with one line, `optimaizr.wrap(new Anthropic())` or `new OpenAI()`, and CSV or
JSON usage exports. Node 20.11 or later.

## Recent releases

- **0.12** (Oct 19, 2026): guard. The message that would write an expired
  cache all over again is held once, with its price (62 of those cost me
  $114.95), and `/clear` starts fresh from a short note of where it stood. Its
  first day on my machine: two held messages, $2.17 not spent. `live` shows
  every open conversation with its cache countdown, `results` marks every
  trade-off, and open models in opencode are priced.
- **0.11** (Oct 13, 2026): did the change work? `optimaizr results` measures
  it on your own usage, with what the saving cost you. Mine, a week after
  compacting at 200K: 26% less per prompt, for 7 minutes a day waiting on
  summaries. `live` says what each turn cost and how much of your 5-hour
  window it took, and `sessions` ranks your costliest conversations the same
  way. In 0.11.1: opencode support.
- **0.10** (Oct 7, 2026): a cache countdown under Claude Code's prompt, no mod
  needed. In 0.10.3: spot conversations that start heavy, and see what each
  cache write was for in `optimaizr sessions`.
- **0.9** (Oct 6, 2026): your plan detected, savings labelled by how sure they
  are, compacting earlier in one command.
- **0.8** (Oct 2, 2026): the Claude Code mod, with the cost of every answer and
  cheaper models mid-session.

Every release in full:
[changelog](https://github.com/blendbunjaku/optimaizr/blob/main/CHANGELOG.md) or
`optimaizr changelog`.

## Privacy

Everything runs on your machine and stays in `~/.optimaizr/`. The only network
calls are `verify` (to your own provider, with your own key), the optional Jev
second opinion, and a daily version check against npm, off with
`OPTIMAIZR_NO_UPDATE_CHECK=1`.
[SECURITY.md](https://github.com/blendbunjaku/optimaizr/blob/main/SECURITY.md)
lists every file read and written.

## More

- [Docs](https://www.optimaizr.com/docs) and the
  [CLI reference](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CLI.md):
  every command, flag and figure explained
- [Contributing](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CONTRIBUTING.md):
  `npm install && npm run build && npm test`
- [Report a bug](https://github.com/blendbunjaku/optimaizr/issues)

First presented on September 13, 2026, open source since September 30, 2026.
optimAIzr Pro, the hosted product coming to
[optimaizr.com](https://www.optimaizr.com), is separate from this repository.

[MIT](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
