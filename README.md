# optimAIzr

[![npm](https://img.shields.io/npm/v/optimaizr)](https://www.npmjs.com/package/optimaizr)
[![CI](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml/badge.svg)](https://github.com/blendbunjaku/optimaizr/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/blendbunjaku/optimaizr/blob/main/LICENSE)
[![Node](https://img.shields.io/node/v/optimaizr)](https://nodejs.org)

**Spend fewer tokens on the same work.**

In a long Claude Code session, most of what you pay for isn't Claude writing
code. It's Claude re-reading your conversation, on every call. optimAIzr shows
where your tokens go, warns you before the expensive moments, and fixes what it
can in one command. For Claude Code and Codex.

```bash
npx optimaizr
```

No account, no upload, no telemetry. It reads token counts from the logs already
on your machine, never your prompts.

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
with **Y**.

**Where long sessions turn expensive.** `optimaizr sessions` finds the context
size where re-reading takes over, and every time you came back too late.

```
  Cold cache returns
    16 times a long conversation was picked up after its cache
    expired. The first call back rewrote 5.9M tokens for $47.25;
    a warm cache would have read them for $1.19.
```

## Fix it in one command

```bash
optimaizr apply context-compaction   # Claude Code and Codex compact at 200K
optimaizr undo context-compaction    # and back
```

Every finding says what happened, why it matters and what it saves, in dollars
from your own logs. Savings are split into clear waste, likely, and "up to", and
never added together.

## Inside Claude Code

The optional optimAIzr mod runs inside the session: the cost of each answer and
your 5-hour window as you work, **Y** in `live` moves the session you're in to a
cheaper model, and `/optimaizr handoff` writes a note to start fresh from.

```
  ⏺ optimaizr: this turn $0.18 · 4 requests · 5h 55% → 56%

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
| `optimaizr verify <rule>` | Replays your own requests on the cheaper option |
| `optimaizr card`          | Your last 30 days as an image to post           |

`optimaizr --help` lists the rest.

## Works with

Claude Code and Codex with no setup. Your Claude plan (Pro, Max, Team) and
ChatGPT plan are detected. Your own app with one line,
`optimaizr.wrap(new Anthropic())` or `new OpenAI()`, and CSV or JSON usage
exports. Node 20.11 or later.

## Recent releases

- **0.10.0** (Oct 7, 2026): a cache countdown under Claude Code's prompt, no
  mod needed.
- **0.9.0** (Oct 6, 2026): your plan detected, savings labelled by how sure they
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
