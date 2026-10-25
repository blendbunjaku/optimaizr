# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![GitHub stars](https://img.shields.io/github/stars/blendbunjaku/optimaizr?style=flat)](https://github.com/blendbunjaku/optimaizr/stargazers)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

[![optimaizr guard holding a message to an expired cache in Claude Code while optimaizr live shows the hold. Click to watch the 47-second demo.](https://raw.githubusercontent.com/blendbunjaku/optimaizr/main/docs/demo.jpg)](https://optimaizr.com/demo)

In a long Claude Code session, most of what you pay for isn't Claude writing
code. It's Claude re-reading your conversation on every call, cheap per token
but paid again and again (41% of my last 30 days), and writing it into the cache
again after a break, at up to twice the input price: 58 of those cost me $98.83
in the same 30 days, where a warm cache would have read it for $2.48. optimAIzr
shows where your tokens go, holds the expensive message before it is paid, and
fixes what it can in one command. For Claude Code, Codex and opencode.

```bash
npx optimaizr
```

**Runs locally: nothing leaves your machine.** No account, no upload, no
telemetry. It reads the logs your agents already keep (`~/.claude`, `~/.codex`,
opencode's database), keeps what it learns in `~/.optimaizr/`, and by default
never reads your prompts or Claude's answers, only token counts. Guard, once you
turn it on, keeps a short note from your last prompt for `/clear`, deleted once
read or after 30 minutes. More under Privacy below.

```
  Your Claude Pro did $801.89/mo of work at API prices: 40x what you pay

  Up to 30% of it can be saved: about 1.4x the work per 5-hour window and per
  week, if you take every step below.

  Where the 30% comes from
    Compact earlier                18%
    Cold cache returns              8%
    Smaller default model           3%
    6 smaller ones                  1%
    Each is taken from what the ones above leave, so nothing counts twice.

  Where it goes
    Re-reading the conversation    41%  ████████░░░░░░░░░░░░
    Loading context into cache     34%  ███████░░░░░░░░░░░░░
    Answers, code and thinking     25%  █████░░░░░░░░░░░░░░░
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
sending it would cost: on a Claude plan, its share of your 5-hour limit first.
Mine, after 3 days away:

```
optimAIzr held this message once. The conversation has been idle 3 days and its
cache expired, so sending it writes all 162K tokens again: about 3% of your
5-hour limit ($1.30 at API prices, Opus 5.5).
It was not sent: copy it from Original prompt below. Send it again to go ahead,
or type /clear and send it there: the new conversation starts from a short note
of where this one stood.
On Sonnet 5.5 the same rewrite is about 2% ($0.65): /model sonnet, then send it again.
```

Send it again and it goes through. Over my last 30 days, 40 messages like this
one wrote their conversation into the cache again for $90.26, where a warm
cache would have read it for $2.26. Guard also stops Claude reading a big file
whole, or running a command that failed twice a third time unchanged, nudges
`/compact` before a conversation compacts in the middle of a task, and warns
once when your pace will run out the 5-hour limit before it resets. It uses
Claude Code's own hooks, no mod, and `optimaizr guard` lists what it held.

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
       $91.16   ~220%   1h 53m   Refactor payment webhook handling
       $89.81   ~217%   2h 21m   Migrate auth to session tokens
       $74.40   ~179%   2h 36m   Build analytics dashboard filters
       $71.99   ~174%   2h 25m   Add search indexing pipeline
       $62.39   ~150%   3h 37m   Fix flaky checkout integration tests
    The top 5 of 80 conversations, 48% of spend.
    5h share at $0.415 per 1%, learned from 8 windows of your plan meter.
```

Then it finds the context size where re-reading takes over, what each cache
write was for, which conversations shared each 5-hour window, and every time a
cache expired before the next call, with who was waiting:

```
  Cold cache returns
    58 times a long conversation's cache had expired by its next call, and
    all of it was written again: 12.4M tokens for $98.83, where a warm
    cache would have read it for $2.48.
      you were away                    51    $93.72
      Claude was waiting on a tool      7     $5.11
```

## Fix it in one command

```bash
optimaizr apply context-compaction   # Claude Code and Codex compact at 200K
optimaizr undo context-compaction    # and back
optimaizr results                    # did it work?
```

`results` compares the days after a change with the days before it, on your
own usage, and marks every row that got worse, so you see what a saving cost.

Every finding says what happened, why it matters and what it saves, in dollars
from your own logs. Savings are split into clear waste, likely, and "up to".
The total takes each one from what the others leave, so no saving is counted
twice: a plain sum of mine would have said 33%, not 30%.

## Share your numbers

The numbers above are one person's history: mine. `npx optimaizr card` makes
an image of your last 30 days with totals only, no project names, paths or
prompts, to post wherever you compare notes. If you applied a fix, add
`optimaizr results`, even when it says the fix didn't work.

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

- **0.12** (Oct 20, 2026): guard. The message that would write an expired cache
  all over again is held once, with its price (58 of those cost me $98.83 in my
  last 30 days), and `/clear` starts fresh from a short note of where it stood.
  `live` shows every open conversation with its cache countdown, `results` marks
  every trade-off, and open models in opencode are priced. In 0.12.1: the
  profile opens with everything it found, together and never counted twice (up
  to 30% of my usage, about 1.4x the work per 5-hour window and per week), your
  5-hour limit is learned from Claude Code's own transcripts, and guard warns
  when your pace will run it out. Tried on my history, it came before all 7 of
  my stops, 67 minutes ahead on the median.
- **0.11** (Oct 13, 2026): did the change work? `optimaizr results` measures
  it on your own usage, with what the saving cost you. `live` says what each
  turn cost and how much of your 5-hour window it took, and `sessions` ranks
  your costliest conversations the same way: my top one took $91.16, 220% of a
  5-hour window. In 0.11.1: opencode support.
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

Everything runs on your machine and stays in `~/.optimaizr/`. To spot repeated
work it also reads what each tool call was given (a file path, a command, the
first 200 characters of anything else) and keeps that in memory only, since
commands can hold secrets. A report you export names the file or command a
finding is about. Guard, when you turn it on, logs what it held in
`~/.optimaizr/guard/`, and a held message leaves a short note from your last
prompt and Claude's last reply, deleted once read or after 30 minutes.

The only network calls are `verify` (to your own provider, with your own key),
the optional Jev second opinion, and a daily version check against npm that
sends nothing about you, off with `OPTIMAIZR_NO_UPDATE_CHECK=1`.
[SECURITY.md](https://github.com/blendbunjaku/optimaizr/blob/main/SECURITY.md)
lists every file read and written.

## Hosted dashboard, coming soon

optimAIzr Pro will be a hosted dashboard for you or your team: 12 months of
history, fixes applied for you and spend guardrails. It is opt-in and separate
from this repository: nothing is sent unless you connect the CLI to it, and
never your prompts or code. The CLI stays free and local either way.
[Get told when it opens](https://www.optimaizr.com/#pro).

## More

- [Docs](https://www.optimaizr.com/docs) and the
  [CLI reference](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CLI.md):
  every command, flag and figure explained
- [Contributing](https://github.com/blendbunjaku/optimaizr/blob/main/docs/CONTRIBUTING.md):
  `npm install && npm run build && npm test`
- [Report a bug](https://github.com/blendbunjaku/optimaizr/issues)

First presented on September 13, 2026, open source since September 30, 2026.

[MIT](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
