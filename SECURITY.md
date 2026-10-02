# Security and data handling

optimAIzr reads how you spend money on models. That data is commercially
sensitive, and it sits next to your prompts and credentials. This page is the
full answer to what happens to it; `optimaizr privacy` prints a summary.

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/blendbunjaku/optimaizr/security/advisories/new) rather than in
a public issue. The failure this project cares most about is optimAIzr leaking
prompt contents, credentials or usage data off your machine.

## Where your data goes

**Nowhere, by default.** Analysis runs entirely on your machine. There is no
account, no upload and no telemetry: no analytics, no phone-home, no crash
reporting. `optimaizr metrics` is computed from your local data and sent
nowhere.

Two features make network calls, and only when you ask for them:

- **`optimaizr verify`** replays captured traffic against your own model
  provider (Anthropic or OpenAI), with your own key, exactly as your app would.
- **Jev** (`live --jev`, off in this version unless `OPTIMAIZR_JEV=1` is set)
  sends route names, model ids, median token counts and tool names to
  `api.typesafe.ai`. Never prompts, completions or tool payloads.
  `live --jev --dry-run` prints the exact request instead of sending it.

The Claude Code mod (`mods/optimaizr`) makes no network calls. Inside Claude
Code it reads the session's usage figures (cost, token counts, the context
window's fill, the plan's rate-limit windows) and the commands Claude runs,
which it keeps in memory to spot a retry loop. It never reads your prompts,
Claude's answers or file contents, and stores none of them.
`claude plugin validate mods/optimaizr` lists every call it makes.

## What is read

| Path                    | Why                                      |
| ----------------------- | ---------------------------------------- |
| `~/.claude/projects`    | Claude Code transcripts (usage per call) |
| `~/.codex/sessions`     | Codex rollouts (usage and plan meter)    |
| `~/.optimaizr/*.json`   | Your config and custom model prices      |
| Files you pass `import` | A CSV or JSON usage export               |

Transcripts are never copied or modified.

## What is written

Everything optimAIzr keeps lives in `~/.optimaizr/` as plain JSON and JSONL.
Nothing is encrypted, because nothing leaves the machine and the files inherit
your user permissions.

| File                  | Contents                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `events.jsonl`        | One record per call from `wrap()` or `import`: model, time, token counts, cost, latency, tool names, and a hash of the prefix. |
| `samples.jsonl`       | **Only if you enable capture.** Redacted request/response pairs for `verify`.                                                  |
| `decisions.json`      | Which recommendations you viewed, simulated or applied.                                                                        |
| `verifications.json`  | The current verification state per rule, which `apply` checks.                                                                 |
| `verifications.jsonl` | Every verification attempt, append-only.                                                                                       |
| `overrides.json`      | Model swaps you accepted in `live`, applied by `wrap()` and the Claude Code mod until you run `optimaizr undo`.                |
| `mod/sessions/*.json` | Written by the Claude Code mod, one per session: its id, working directory, mod version and times. Removed after 7 days.       |
| `limits.jsonl`        | Times you recorded hitting a Claude session limit with `optimaizr limit`.                                                      |

Outside that directory, optimAIzr writes only:

- `~/.claude/settings.json`, and only when you press **Y** on a model swap in
  `live` while no session is running the mod. It merges the `model` key,
  leaves everything else alone, and prints what changed and how to undo it.
- `optimaizr-report.html`, `optimaizr-card.html`/`.svg` and
  `optimaizr-change.md` in the current directory, when you run `report`,
  `card` or `apply`.

## Prompt contents

**Not stored by default.** A usage record holds token _counts_, not contents.
The prefix hash is a SHA-1 of your tools and system prompt, cut to 12
characters, used to spot cache-defeating churn. It can't be reversed.

`verify` is the only feature that needs real prompts, because it replays them.
So capture is:

- **opt-in**: off unless you pass `capture` to `wrap()`
- **sampled**: `{ rate: 0.02 }` keeps one call in fifty
- **capped**: `maxPerRoute` bounds how much accumulates
- **redacted before write**: emails, `sk-` API keys, bearer tokens, long digit
  runs and card-shaped numbers are masked in memory first
- **local**: read back only by `verify`, on your machine

```ts
optimaizr.wrap(client, { service: "checkout-api", capture: { rate: 0.02 } });
```

You can pass your own `redact` function. Redaction is pattern-based, so treat it
as a safety net, not a guarantee: if your prompts carry regulated data, leave
capture off.

## Credentials

optimAIzr never stores, logs or prints an API key.

- `verify` checks only that `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is _set_,
  then constructs the provider's own SDK client, which reads the value itself.
- Jev reads `TYPESAFE_API_KEY` and sends it to `api.typesafe.ai` as the
  request's bearer token. That is the only key optimAIzr handles directly, and
  only when you enable Jev.

## Reports you share

`optimaizr report` and `optimaizr card` produce files meant to be forwarded, so
they treat their input as untrusted. Model, project and route names come from
transcripts, directory names and imported files, any of which could carry
markup. Every such value is escaped, the embedded chart data can't close its
script block, and chart rows are built with `textContent`. Tests fail if any of
that escaping is removed. The report loads nothing over the network.

A report contains costs, token counts, and model and project names. The card
contains totals only. Neither contains prompt contents or credentials.

## Retention and deletion

Data is kept until you delete it.

```bash
rm -rf ~/.optimaizr               # everything optimAIzr has stored
rm ~/.optimaizr/samples.jsonl     # only captured prompts
```
