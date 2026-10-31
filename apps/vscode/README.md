# optimAIzr for VS Code

**Spend fewer tokens on the same work.** See what Claude Code, Codex and opencode cost you, and
what you could save. For Claude Code there is more: the cache countdown, your context size and your
5-hour window right in the status bar, a heads-up before an expensive moment, and fixes you apply
in one click. Everything stays on your machine.

[![optimAIzr for VS Code in 28 seconds. Click to watch.](https://raw.githubusercontent.com/blendbunjaku/optimaizr/main/docs/vscode.jpg)](https://optimaizr.com/vscode)

```
$(layers) 142K · $(watch) 4:12 · 5h 38%
```

That is this folder's Claude Code conversation: 142K tokens of context, 4 minutes 12 seconds left
on its cache, 38% of your 5-hour window used.

![The optimAIzr sidebar: up to 13% to save, a cache expiring in 2:40, guard on](https://raw.githubusercontent.com/blendbunjaku/optimaizr/main/apps/vscode/media/screens/sidebar.png)

## Why

In a long Claude Code session, most of what you pay for is not Claude writing code. It is Claude
re-reading your conversation on every call, and writing it into the cache again when you come back
after it expired.

Over my last 30 days on Claude Pro:

- **$676/mo** of work at API prices, **34x** what the plan costs
- **51 returns** to an expired cache wrote **8.9M tokens** again, about **$56/mo**
- **Up to 13%** of it could be saved, about **1.1x the work** per 5-hour window and per week

Your numbers show up the moment the extension opens.

## What you get

**A status bar that watches the cache.** Context size, the cache countdown and the 5-hour window
for the conversation in the folder you have open. It turns yellow in the last five minutes and red
past 90% of the window. Hover for the details: the model and effort, what the last reply cost, and
what your open fixes are worth. Click to open the sidebar.

**A heads-up before the cache expires.** About 5 minutes before a long conversation's cache runs
out, when coming back after would cost at least $0.50. Reply now, or know what the break costs.
Set it anywhere from 1 to 10 minutes.

**Guard, one switch.** Guard holds the next message to an expired cache once and tells you what it
would cost to send. Send it again and it goes through, or `/clear` and start from a short note of
where you were. It also catches a big file read and a retry loop. The sidebar shows what it held
this week.

**One-click compaction.** Compact Claude Code earlier, at 200K, so every message stops re-reading
everything. Undo is one click too, and leaves the rest of your settings alone.

**Fixes, biggest money first.** Each fix says what happened, why it costs, and what to do. Habits
get an **I did this** button, so optimAIzr can measure whether it worked.

**Results.** After a fix, see whether it worked: less per prompt, or too early to tell.

**A done alert.** A desktop notification when a turn of 45 seconds or more finishes while VS Code
is in the background, so you can stop watching it work.

**The full report.** Where the share comes from, the biggest single win, and every fix opened up.

![The full optimAIzr report](https://raw.githubusercontent.com/blendbunjaku/optimaizr/main/apps/vscode/media/screens/report.png)

## Works with

|                                      | Claude Code | Codex | opencode |
| ------------------------------------ | ----------- | ----- | -------- |
| Savings, fixes, results, full report | yes         | yes   | yes      |
| Status bar, heads-ups, done alert    | yes         |       |          |
| Guard and one-click compaction       | yes         |       |          |

## Private by design

optimAIzr reads the logs Claude Code, Codex and opencode already keep on your machine and works
everything out there. No account, no upload, no telemetry. It reads token counts and conversation
titles, never your prompts or the answers. Guard, once you turn it on, keeps a short note from your last prompt for `/clear`, deleted
once read or after 30 minutes.

## Guard and the CLI

Everything in the sidebar works on its own. Turning guard **on** uses the free
[optimaizr](https://www.npmjs.com/package/optimaizr) command line tool, and the extension offers to
install it for you (`npm i -g optimaizr`, Node.js 20 or newer). Turning guard off needs nothing.

## Commands

Open the Command Palette and type **optimAIzr**.

| Command                                         | What it does                                 |
| ----------------------------------------------- | -------------------------------------------- |
| optimAIzr: Show savings                         | Opens the sidebar                            |
| optimAIzr: Open full report                     | Opens the report in an editor tab            |
| optimAIzr: Refresh                              | Reads your history again                     |
| optimAIzr: Turn guard on / Turn guard off       | Guard, the same switch as in the sidebar     |
| optimAIzr: Compact Claude Code earlier, at 200K | Sets Claude Code's compaction window to 200K |
| optimAIzr: Undo earlier compaction              | Puts compaction back where it was            |
| optimAIzr: Settings                             | Opens these settings                         |

## Settings

| Setting                                 | Default | What it does                                                    |
| --------------------------------------- | ------- | --------------------------------------------------------------- |
| `optimaizr.statusBar.enabled`           | on      | Context, cache countdown and 5-hour window in the status bar    |
| `optimaizr.alerts.cacheExpiring`        | on      | Heads-up before a cache expires                                 |
| `optimaizr.alerts.cacheExpiringMinutes` | 5       | How many minutes before it expires the heads-up comes (1 to 10) |
| `optimaizr.alerts.coldCache`            | on      | What a return to an expired cache cost                          |
| `optimaizr.alerts.longConversation`     | on      | Once, when a conversation grows past 200K                       |
| `optimaizr.alerts.guard`                | on      | When guard holds a message, a read or a retry                   |
| `optimaizr.alerts.claudeDone`           | on      | Desktop alert when a long turn finishes (macOS and Linux)       |
| `optimaizr.days`                        | 30      | Days of history the savings are worked out over (7 to 90)       |
| `optimaizr.cliPath`                     | empty   | Where the `optimaizr` CLI is; empty looks on your PATH          |

## Requirements

- VS Code 1.90 or newer, or a fork that runs VS Code extensions
- Claude Code, Codex or opencode, with some history on this machine
- For guard only: Node.js 20 or newer

## More

- [optimaizr.com](https://optimaizr.com)
- [The CLI on GitHub](https://github.com/blendbunjaku/optimaizr), MIT licensed
- [Report a bug](https://github.com/blendbunjaku/optimaizr/issues)
