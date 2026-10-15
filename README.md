# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![GitHub stars](https://img.shields.io/github/stars/blendbunjaku/optimaizr?style=flat)](https://github.com/blendbunjaku/optimaizr/stargazers)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

[![optimaizr live catching a cold cache return while Claude Code works. Click to watch the 42-second demo.](https://raw.githubusercontent.com/blendbunjaku/optimaizr/main/docs/demo.jpg)](https://optimaizr.com/demo)

In a long Claude Code session, most of what you pay for isn't Claude writing
code. It's Claude re-reading your conversation on every call, cheap per token
but paid again and again, and writing it into the cache again after a break, at
up to twice the input price. optimAIzr shows
where your tokens go, warns you before the expensive moments, and fixes what it
can in one command. For Claude Code, Codex and opencode.

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

**Live, beside your agent.** `optimaizr live` warns when context jumps or
passes 200K, and 5 minutes before a cache expires, and offers a fix you take
with **Y**. After each turn it says what that turn cost and how much of your
5-hour window it took.

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
write was for, and every time you came back too late:

```
  Cold cache returns
    16 times you came back after a long conversation's cache
    expired, and paid for all of it again: 5.9M tokens for
    $47.25, where a warm cache would have read it for $1.19.
```

## Fix it in one command

```bash
optimaizr apply context-compaction   # Claude Code and Codex compact at 200K
optimaizr undo context-compaction    # and back
optimaizr results                    # did it work?
```

```
  Compact earlier: Claude Code at 200K
  applied Oct 7, 7 days ago

  Working: 26% less per prompt than the 14 days before. It comes with a
  cost: compactions a day and waiting for summaries a day went up.

                                     before     after
    cost per prompt                   $1.06    $0.787   -26%
    calls past 200K                     60%        0%   -60 pts
    compactions a day                  0.23       5.3   23x  trade-off
    waiting for summaries a day        0.4m      7.1m   17x  trade-off
```

That's my own change, a week in. Against just the 5 days before it, the drop
is 7%, and `results` says so too.

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
| `optimaizr live`          | Watches while you work, fixes with **Y**        |
| `optimaizr statusline on` | The cache countdown under Claude Code's prompt  |
| `optimaizr sessions`      | Where long conversations start to cost more     |
| `optimaizr why`           | Spend by model, project and kind of work        |
| `optimaizr apply <rule>`  | Applies a fix; `undo <rule>` takes it back      |
| `optimaizr results`       | Did it work? The days after against before      |
| `optimaizr verify <rule>` | Replays your own requests on the cheaper option |
| `optimaizr card`          | Your last 30 days as an image to post           |

`optimaizr --help` lists the rest.

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
