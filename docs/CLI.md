<!-- Full CLI reference. The npm page (apps/cli/README.md) is the short version. -->

# optimAIzr

**Spend fewer tokens on the same work.**

Add one line of code, or point it at your coding agents with no production
changes at all, and you get every call: cost, latency, tokens, and what's being
wasted. Then it tells you what to cut: a cheaper model here, a cache there, a
bloated prompt to trim.

Every fix is checked against your own quality bar first, on your own traffic,
so you're never trading cost for worse output.

```
  41% of your spend went on re-reading the conversation so far; the
  answers themselves were 25%.
  Start here: optimaizr apply context-compaction   compact sooner, so there is less to re-read

  Your Claude Pro did $801.89/mo of work at API prices: 40x what you pay

  Up to 30% of it can be saved: about 1.4x the work per 5-hour window and per
  week, if you take every step below.

  Where the 30% comes from
    Compact earlier                18%
    Cold cache returns              8%
    Smaller default model           3%
    6 smaller ones                  1%
    Each is taken from what the ones above leave, so nothing counts twice.
```

Once a change is in, `optimaizr results` puts the days after it against the
days before, on your own usage.

---

Release notes for each version are in [CHANGELOG.md](../CHANGELOG.md).

---

## Two ways in

**Your app: one line, whichever vendor you call.**

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import optimaizr from "optimaizr";

const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
const openai = optimaizr.wrap(new OpenAI(), { service: "checkout-api" });
```

Both write to the same ledger in the same shape, which is what makes spend
across vendors directly comparable rather than two dashboards you eyeball
side by side. On OpenAI the wrapper covers `chat.completions` and `responses`.

Every call keeps its normal signature and return value. The wrapper measures
latency, records usage and cost, and fingerprints the cacheable prefix. It is
built so it cannot break a production request: every hook is wrapped, recording
is asynchronous and best-effort, and an unrecognised client is returned
untouched rather than throwing.

Label call sites to get per-route advice:

```ts
import { withRoute } from "optimaizr";

await withRoute("summarise-ticket", () => client.messages.create({ ... }));
```

**Your coding agents: nothing to change.**

```bash
npm i -g optimaizr
optimaizr                      # your profile: what your plan does, savings found
optimaizr live                 # in a second terminal while you work
optimaizr statusline on        # Claude Code: context and cache countdown under the prompt
```

Reads Claude Code transcripts straight from `~/.claude/projects`, Codex sessions
from `~/.codex/sessions` and opencode 1.x history from
`~/.local/share/opencode/opencode.db` (on Node 22.13 or later). No
instrumentation, no config, no production changes, and all three land in one
dataset, so Anthropic and OpenAI agent spend sit in the same report. The
[Claude Code mod](#inside-claude-code) is optional: it adds switching models
mid-session and `/optimaizr handoff`, and nothing above needs it.

---

## Commands

|                             |                                                                      |
| --------------------------- | -------------------------------------------------------------------- |
| `optimaizr audit`           | The savings audit: what you spend, what is recoverable, and why      |
| `optimaizr profile`         | One screen: what your plan does, savings found, the biggest win      |
| `optimaizr scan`            | Spend, savings, and what to do about it                              |
| `optimaizr sessions`        | Your costliest conversations, and where re-reading takes over        |
| `optimaizr why`             | Drill into where the money actually goes                             |
| `optimaizr live`            | Watch calls as they happen and surface fixes interactively           |
| `optimaizr statusline on`   | Context, re-read cost and cache countdown under Claude Code's prompt |
| `optimaizr guard on`        | Hold a costly step once in Claude Code, before it is paid            |
| `optimaizr mod`             | Install steps and status of the Claude Code mod                      |
| `optimaizr recommend`       | Ranked actions with impact and confidence                            |
| `optimaizr show <rule>`     | The individual requests a recommendation touches                     |
| `optimaizr simulate <rule>` | What the change would cost, arithmetically                           |
| `optimaizr waste`           | Just the opportunities                                               |
| `optimaizr tokens`          | Token analytics and the priciest individual calls                    |
| `optimaizr verify <rule>`   | Prove a fix against your quality bar before applying it              |
| `optimaizr apply`           | What optimAIzr changes for you, and what you change yourself         |
| `optimaizr apply <rule>`    | Make the change, or get its steps; `--done` records one you made     |
| `optimaizr results`         | Each change against the days before it, on your own usage            |
| `optimaizr undo <rule>`     | Take back a change optimAIzr made, or mark one you made as undone    |
| `optimaizr import <file>`   | Load a CSV or JSON usage export you already have                     |
| `optimaizr report`          | Write a shareable HTML dashboard                                     |
| `optimaizr guide`           | Which model for which job, with the arithmetic                       |
| `optimaizr providers`       | What can be read, and from where                                     |
| `optimaizr privacy`         | What is collected, stored and sent                                   |
| `optimaizr metrics`         | How much has been analysed, and how much found                       |
| `optimaizr changelog`       | What changed in this version (`--all` for every version)             |

Flags: `--why` (show every calculation and assumption), `--days N`,
`--project STR`, `--source all|agents|sdk`, `--tz utc|local|<IANA>`, `--json`.

`optimaizr help` lists the commands to start with, in four groups: start here,
change things, look closer, about. `optimaizr help all` lists every one,
including the older views, and `optimaizr <command> --help` gives a command's
own flags.

`live` also takes `--backfill N` (replay recorded history first), `--window N`,
`--min-usd N` (default $0.25), `--source all|agents|sdk`, `--no-prompt` (print
recommendations instead of asking), `--no-turns` (no line after each Claude
Code turn), `--notify` (system notifications, see
[Watching live](#watching-live)) and `--auto` (apply confident model and effort
switches through the Claude Code mod without asking). With `--json` it never prompts. `sessions`
takes `--top N`, how many conversations to list (10 by default).

---

## Inside Claude Code

Claude Code 2.1.287 and later runs mods, plugins that work inside it. The
optimAIzr mod is optional: the CLI, `live` and the status line work without it.
It adds what only code inside the session can do, switching the model of the
session you are in and `/optimaizr handoff`. It lives in
[`mods/optimaizr`](../mods/optimaizr) and installs from this repository's
marketplace, in a Claude Code session:

```
/plugin marketplace add blendbunjaku/optimaizr
/plugin install optimaizr@optimaizr
```

What it adds:

- **The spinner** shows what the turn has cost so far and how full your 5-hour
  window is: `Thinking · $0.18 · 61% of 5h…`.
- **The band above the prompt** shows the window, how long it lasts at the pace
  of the last hour (once there are 10 minutes and one point of use to go on)
  and when it resets. The readings come from Claude Code's own limit meter and
  are shared by every session on the machine. Off a plan, it shows what the
  session has cost instead.
- **Each answer** gets one line: `optimaizr: this turn $0.18 · 2m 10s · 4
requests · ~0.4% of 5h`. The share is the turn's own, from its dollars at what
  1% of your window costs (see [Watching live](#watching-live)), not the meter
  before and after: other sessions move the meter too. Set the plugin's
  `turnLine` option to `false` to turn it off.
- **`/optimaizr`** prints the session's spend, both plan windows and any active
  switch. `/optimaizr hud` opens the same as a HUD, with the saving also shown as an
  estimated share of your 5-hour window (from how far the window moved against
  what the session spent; other sessions move it too): gauges for both windows, a
  sparkline of the last turns, savings and retries held. The meter turns green,
  yellow, then red as the window fills, and a toast marks 80% and 95%.
- **Switches.** When you press **Y** on a model swap in `optimaizr live`, the
  mod applies it from the next request of every running session in that
  project. A finding that covered only subagent calls switches only
  subagents, which start with a fresh context, so no cache is lost. A switch
  is written only when the finding covers at least 80% of that traffic's spend.
  A conversation already under way switches only once reloading it into the
  new model's cache pays back within 10 requests, priced from this session's
  average request; until then the band says `waiting` and why. Subagents start
  with an empty cache and switch at once. If the API refuses the model, the request is sent as
  it was and the session stays on its own model. The first switched request
  leaves a note in the conversation, and the band names the model you are on.
  For a harder task, `/optimaizr off` sends that session back to its own model
  and `/optimaizr on` resumes. `optimaizr undo <rule>` removes the switch from
  every running session within seconds.
- **What a switch saved.** Each switched request is priced twice from the
  token counts the API returned: at the original model's rates and at the new
  one's. The turn's line leads with the difference, as in `~$0.10 less than
the same tokens on Opus 5.5 · this turn $0.10 on Sonnet 5.5 · 1 request`, the
  band keeps a running total (`saved ~$0.10`), and `/optimaizr` adds it up and
  says how it was worked out. On the first request on the new model, the
  conversation is written to its cache where the original model would have
  read it from its own, so that request is priced against cache reads and can
  come out negative; the line then says how much more it cost, once. The
  figure is a price difference on the tokens that were used, not a measured
  saving: the original model could have thought and written more, or finished
  in fewer requests, and neither is counted. Prices come from the same
  catalogue as every other figure here, with cache writes priced as the engine
  prices them: the main conversation at the 1-hour rate, subagents at the
  5-minute rate.
- **Effort.** Accepting a `reasoning-effort` finding in `live` writes an effort
  switch: the same model, asked to think less on that work. The mod only ever
  lowers effort, and `/optimaizr off` goes back. A change made with `/effort`
  keeps the cache: in every case seen so far, `/effort low` among them, the
  next request read the whole conversation from it. One early test of the mod
  switching a session to low, on Claude Code 2.1.286, did read it again
  ($0.23 against $0.02 to $0.03 for the next ones); that came from how the mod
  switched, not from the lower effort. Claude Code doesn't report how much a
  request would have reasoned at the old setting, so effort switches carry no
  dollar figure.
- **A retry guard.** When the same command fails twice in a row and nothing has
  changed since (no successful edit or command in between), the mod holds the
  next identical attempt once and tells Claude to change something first. If
  Claude runs it again anyway, it goes through. Set the `retryGuard` option to
  `false` to turn it off. [Guard](#guard) does the same without the mod. The mod keeps the commands it has seen in memory
  only, and forgets them on compaction and `/clear`.

Dollar figures are what Claude Code totals, at API rates; on a plan they are
not what you pay. The terminal and the Desktop app draw the spinner and the
band; in the VS Code chat panel switches still apply but nothing is drawn.

`optimaizr mod` shows the install steps, which sessions are running it (each
writes `~/.optimaizr/mod/sessions/<id>.json` once a minute) and any active
switch. `live` uses the same files to decide what **Y** can reach.

---

## Three kinds of number, never blurred

A financial tool must not dress a guess as a measurement. Every figure declares
how it was derived:

|               |                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **measured**  | Read from provider-reported usage and priced at the rate in force. A fact.                      |
| **inferred**  | A pattern derived from measured data by a stated rule. True of the data, but our reading of it. |
| **estimated** | A projection that assumes how a different model or setting would behave. Could be wrong.        |

Monthly and annual figures are projections on top of all three, extrapolated
from the analysed window, and labelled as such everywhere they appear.

This is why a model swap is never labelled `measured`, however precise its
arithmetic: the replacement model's verbosity is an assumption, not a reading.
There is a test asserting exactly that.

---

## Three tiers of saving

Each finding says what kind of move it asks for:

|          |                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------- |
| **FIX**  | Clear waste. Removing it leaves the work as it was. The only tier in the headline ("Clear waste").   |
| **TRY**  | Likely savings that change what the model does, such as a smaller model for quick tasks. Shown as +. |
| **TEST** | Trade-offs sized from your own usage: compact earlier, a smaller default model. Only ever "up to ".  |

"Likely +" counts only calls that clear waste did not already claim, and a
TEST lever is never added to either. Only the profile's all-in figure puts
every tier together: the largest saving first, then each one on what the ones
before it leave, so two changes never save the same dollar (30% here, where the
plain sum of the parts would say 33%). Each figure also says how sure it is:
**high confidence**, **likely** or **possible** (the `high`, `medium` and
`low` confidence levels below).

**Tasks, not calls.** For Claude Code and Codex, calls are grouped into tasks: a
prompt and every call it set off. One step of a long debugging session looks
like a quick job on its own, so the rules judge the whole task, from its shape
only (calls, files edited, failures, thinking tokens, the closing answer's
length), never from prompt text. A quick task has at most 8 calls, edits at
most 2 files, fails at most once, thinks for under 2K tokens, and ends with an
answer under 1,500 tokens. Fix-and-rerun debugging, files being written, a
subagent's own reads and re-reads after an edit or compaction are not waste.

---

## Your profile at a glance

```bash
npx optimaizr profile
```

```
  optimAIzr | profile
  2026-09-25 to 2026-10-25  (30.0 days)

------------------------------------------------------------------

  41% of your spend went on re-reading the conversation so far; the
  answers themselves were 25%.
  Start here: optimaizr apply context-compaction   compact sooner, so there is less to re-read

  Your Claude Pro did $801.89/mo of work at API prices: 40x what you pay
  $823.97 in this window · 8,448 calls · 1.73B tokens · list rates, not a bill

  Up to 30% of it can be saved: about 1.4x the work per 5-hour window and per
  week, if you take every step below.

  Where the 30% comes from
    Compact earlier                18%
    Cold cache returns              8%
    Smaller default model           3%
    6 smaller ones                  1%
    Each is taken from what the ones above leave, so nothing counts twice.

  Biggest win  Compact earlier  TEST · possible
    Up to 18% less usage (~$149.73/mo), about 1.2x the work per 5-hour window

    What happened   23% of your Claude Code calls carried over 200K of
                    conversation
    Why it matters  Every call re-reads the whole conversation, so each
                    call costs more than the last: re-reading took 41% of
                    your Claude Code spend.
    What to do      Compact by hand when you finish a piece of work,
                    saying what to keep (/compact keep the API decisions).
                    Automatic compaction usually lands mid-task (88 of
                    your 92 compactions did), and a summary can drop
                    details from early in the conversation. Or have it
                    compact at 200K on its own. Claude Code: add "env": {
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000" } to
                    ~/.claude/settings.json, and it compacts a little
                    before that point. The saving already pays for each
                    summary and the cache it rebuilds, but a lower point
                    compacts more often. To keep more of each
                    conversation, pick a later point: optimaizr apply
                    context-compaction --at 400K. Try it for a week and
                    compare.

------------------------------------------------------------------

  Where it goes

    Re-reading the conversation    41%  ████████░░░░░░░░░░░░
    Loading context into cache     34%  ███████░░░░░░░░░░░░░
    Answers, code and thinking     25%  █████░░░░░░░░░░░░░░░
    Re-reading is billed at the cache-read rate, the cheapest there is.

  Clear waste and likely savings, item by item

    FIX   Oversized context                $4.95/mo     1% of usage  likely
    FIX   Oversized tool output            $1.75/mo    <1% of usage  likely
    TRY   Cold cache returns              $80.07/mo    10% of usage  high confidence
    TRY   Model mismatch                  $0.987/mo    <1% of usage  likely
    +1 smaller, under $0.25/mo each: optimaizr recommend
```

The savings come first, all together: "up to", because it counts the TEST
levers too, each taken from what the larger ones leave. On a plan it is put as
more work per 5-hour window and per week (cutting a share s of usage leaves
room for 1 / (1 - s) as much); off a plan, as dollars a month. Parts under 1%
fold into one row, and the rows add up to the total. Under 5% in all, the
screen shows each tier on its own line instead, as "Savings found". The biggest
win is the largest opportunity of any tier, put the same way, and each item
below shows its share of your usage, about its share of your 5-hour windows.
"Where it goes" splits spend into re-reading context, loading it into the
cache, output and new input. Below the screen shown here: each clear-waste and
likely item, your plan block and the next step.

Before anything is applied, the profile opens with one fact from your own
usage and the one command to start with. Once a change is in, that place goes
to an Applied block, with how each change is doing so far:

```
  Applied
    Compact earlier: Claude Code at 200K since Oct 7 · 28% less per prompt so far
    Model mismatch: Opus 5.5 -> Sonnet 5.5 in eatmaxxing since Oct 2
      too early to tell
    Before against after, for each: optimaizr results
```

A finding with a change in place for at least half of its spend leaves the
savings and the biggest win, so the profile doesn't keep offering what you
already did. An undone change, or one for another project, doesn't count.

Every figure is the same one `waste`, `audit` and `recommend` report. It is
read-only and fully local, and takes the same `--days`, `--project`,
`--source` and `--json` flags.

---

## Stay under a monthly cap

Many teams hand each developer a fixed agent budget, reset on the 1st. For them
the useful number is not a monthly saving but a date: will the cap last until
it resets?

```bash
optimaizr profile --budget 300
optimaizr live --budget 300
```

Or once, in `optimaizr.config.json` (or `~/.optimaizr/config.json`):

```json
{ "budget": 300 }
```

- **Used this month** is the calendar month so far, cut at midnight in the
  `--tz` zone (UTC by default). Use `--tz local` if your cap resets on local
  time.
- **At this rate** projects the month at its own pace so far. In the first
  week, when two busy days would overstate it, the last 14 days are used
  instead, and the report says which.
- **With the fixes below** re-runs the projection with every recoverable finding
  applied. It is an estimate: it assumes the share of spend the findings cover
  holds for the rest of the month.
- **Counts this machine only.** Calls made on another laptop or in a web app
  count against your cap but not here, so the real cap arrives sooner.
- In `live`, each of 50%, 80%, 95% and 100% is announced once. Thresholds
  already passed when `live` starts are not replayed. With `--json` a crossing
  is a line of the form `{"budget": {"threshold": 0.8, ...}}`.

---

## On a Claude plan

On Claude Pro, Max or Team you pay a flat price and usage is rationed in
five-hour sessions, with a weekly limit on top. The dollar figures elsewhere are
what the same work would cost on the API. They are still the right measure of a
session, because a larger model drains a session faster in roughly the
proportion it costs more.

**Your plan is detected.** Claude Code keeps your account's plan in its own
config after sign-in (`~/.claude.json`, or under `CLAUDE_CONFIG_DIR`).
optimAIzr reads only the plan fields from it, never your name or email. When
the tier isn't reported (Max without 5x or 20x, Team without the seat type) it
says so and asks; it never guesses. `--plan` wins over the config file, and
both win over what was detected:

```bash
optimaizr profile                  # detected
optimaizr profile --plan max20     # or "plan": "max20" in config, to override
```

| `--plan`       | Plan                 | Price used   | Per session        |
| -------------- | -------------------- | ------------ | ------------------ |
| `pro`          | Claude Pro           | $20/mo       | the base           |
| `max5`         | Claude Max 5x        | $100/mo      | 5x Pro             |
| `max20`        | Claude Max 20x       | $200/mo      | 20x Pro            |
| `team`         | Claude Team Standard | $25/seat/mo  | Standard seat      |
| `team-premium` | Claude Team Premium  | $125/seat/mo | 5x a Standard seat |

Prices are monthly list prices, the multiple's denominator. Billed annually,
Pro is $17 and Team seats $20 and $100, so on an annual plan the multiple reads
a little low. Two plans have no session view, and optimAIzr says so:

- **Enterprise** is $20 a seat plus usage billed at API rates, under a spend
  limit your admin sets. The dollars are the bill, so read it as a cap:
  `--budget <your limit>`.
- **Free** does not include Claude Code.

```
  Plan

  Claude Pro              $20.00/mo  what you pay
  API-equivalent         $443.55/mo  22x what you pay
  5-hour sessions                18  in the last 30 days
  Typical session            $18.50  median · heaviest $67.20 on Sep 14
  Waste per session             10%  fix it and you'd hit the limit ~11% later
  Your session limit        ~$26.90  learned from 3 times you hit it
  This session               $12.40  since 20:00, resets 01:00 · ~46% of it
```

**How it learns your limit.** Anthropic does not publish the limit. Each time
Claude Code refuses a request because the 5-hour window ran out, it writes that
to the transcript with the time the window resets, and optimAIzr reads it from
there: what the window had used by then, counted from its real start, is one
hit. Nothing to set up, in the terminal or in VS Code. Mine, 7 hits in four
weeks, were all between $33.50 and $42.06. For a hit the transcripts missed,
run:

```bash
optimaizr limit             # now
optimaizr limit --at 15:10  # after the fact
optimaizr limit undo        # remove the last one
```

Each hit records what that session had used by then. The median over your hits
is your limit, and `optimaizr live` warns at 80% and 95% of it, once each per
session. With the optimAIzr mod running none of this is needed: the mod writes
Claude Code's own 5-hour and weekly meters into its session file, and
`profile` and `live` show those instead.

**What is approximate.** Sessions are rebuilt from timestamps: one opens at the
top of the hour of the first message after the previous one closed, and lasts
five hours. Only Claude Code traffic counts; Codex belongs to a different plan.
The weekly limit is not modelled.

## On a ChatGPT plan

Codex needs none of the above. Each `token_count` it writes carries a
`rate_limits` block: the plan, and for the primary and secondary windows the
percentage used, the window length and the reset time. optimAIzr reads the
latest one and shows it:

```
  ChatGPT Plus            $20.00/mo  what you pay
  API-equivalent         $117.72/mo  5.9x what you pay
  5-hour window                 82%  used · resets 01:49 · a full window ~$4.76
  Weekly window                 38%  used · resets Sep 25, 22:49
```

- **Measured, not learned.** The percentages and resets are OpenAI's. A window
  that reset after the last reading shows as fresh.
- **A full window** is the API-equivalent spend inside it so far, divided by the
  share used, shown once at least 5% is used. Usage on another machine counts
  toward OpenAI's percentage but not toward that spend, so it reads low then.
- **Plans and prices**, by the plan type Codex reports: `free` $0, `go` $8,
  `plus` $20, `prolite` (Pro 5x) $100, `pro` (Pro 20x) $200. A plan type newer
  than this list is named as reported and shown without a price.
- **Seat plans** (`business`, `team`, its old name, `enterprise`, `edu` and
  their usage-based variants) show no price and no multiple. A Business seat is
  $25 billed monthly or $20 annually, Premium seats cost more, and the plan type
  does not say which.
- **The windows are whatever the plan has.** Plus reports a 5-hour and a weekly
  window; Free reports a weekly one only. Each is read as reported.
- **API-key sessions** carry no meter and show as plain spend.
- The section appears only when Codex reported a meter in the last 30 days.

When no plan can be detected, `profile` says so in one line and how to set
one. If you pay per token, `{ "plan": "api" }` in config turns it off.

---

## Where does the money go?

`optimaizr why` is an investigation tool, not a chart. Total, then provider,
model, project, workload and finally the individual request, each level
showing its share of the level above, because that ratio is what makes a bill
explicable:

```
  $132.47 total  across 1,807 requests

    anthropic                         $132.47  100% 1807 calls
      -> sonnet-5                         $99.47   75% 1640 calls
        -> kopshti-back                   $93.34   94% 1541 calls
          -> Mechanical                   $36.11   39% 746 calls
          -> Reasoning                    $27.52   29% 335 calls
          -> Generation                   $15.22   16% 141 calls
```

That last level is a workload class **inferred** from call shape: reasoning
tokens, output size, tool count. It does not know intent, and does not claim
to: a short answer to a hard question classifies as mechanical, and that is a
limitation of the method rather than a hidden one.

Narrow with `optimaizr why anthropic sonnet-5`. With more than one vendor
connected, the provider level is where the comparison starts.

### How your sessions run

`optimaizr sessions` opens with your costliest conversations, by the title
Claude Code gave each one:

```
  Costliest conversations (subagents included)
         cost   of 5h   worked   conversation
       $91.16   ~222%   1h 53m   Refactor the billing webhooks             api · Oct 1
       $48.20   ~118%   1h 02m   Landing page rebuild                      site · Sep 29
    The top 10 of 120 conversations, 51% of spend. Worked: time the agent spent on it, pauses over 15m left out.
    5h share at $0.410 per 1%, learned from 27 windows of your plan meter.
```

A conversation's cost includes its subagents. Worked is the time from each
prompt to the agent's last reply, with any pause over 15 minutes left out (a
question left open, a break), and a prompt queued while another ran counted
once. The share of the 5-hour window is the dollars at what 1% of your window
costs; past 100%, the conversation ran over more than one window. `--top N`
lists more, and `--json` gives every conversation with its `windowPercent`.

Then it answers the questions a re-reading figure raises: are the costs in a
few long sessions or many medium ones, and at what size does re-reading take
over? All of it is measured, nothing is estimated:

- calls, prompts and peak context per session (median and the top 1 in 10)
- the cache hit rate, and how many sessions were headless: started by
  `claude -p`, the Agent SDK or `codex exec`, with nobody there to read them.
  The costliest conversations mark them too
- the last five 5-hour windows: what each cost, its share of the window, how
  many conversations spent it and how many ran at once, and which ones took
  the most
- main-conversation calls by context size (0-50K up to 500K+), each band's
  share of spend and how much of its cost was re-reading, with the size where
  re-reading becomes half the cost of a call
- the costliest tenth of sessions and their share, the sessions that passed
  200K, and spend by session length
- cache writes: their share of tokens and of spend, what a session spends on
  them (median and the top 1 in 10), how much went to the 1-hour cache and how
  much to the 5-minute one, and what each write was for (below)
- cold cache returns: how often a long conversation was picked up after its
  cache expired, and what rewriting it cost against reading it warm. They are
  split into the times you were away and the times Claude was waiting on a
  tool in the middle of a turn: a long command, a subagent or a permission
  prompt left open. On the 5-minute cache, it names the commands Claude was
  waiting on when the cache ran out
- with [guard](#guard) on, conversations started from its handoff note against
  conversations carrying on after a compaction (below)

Re-reading is priced at the cache-read rate, already the cheapest rate there
is. It is the biggest share because every call pays it. A cache write costs
1.25x the input rate (5-minute cache) or 2x (1-hour), so a few percent of the
tokens can be a quarter of the bill. Each write gets one cause:

| Cause              | What happened                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| new content        | messages and tool results added since the last call, written once                                                                |
| new conversations  | the first call of a conversation, or a short one (under 50K) picked up after a break                                             |
| after a compaction | the first call after a compaction writes the summary                                                                             |
| subagents          | each subagent starts empty and writes its own context                                                                            |
| after a break      | a cold cache return, the same calls as the section below                                                                         |
| rebuilt while warm | most of the context written again inside the cache's lifetime: a rewind, a change to tools or settings, or a cache dropped early |
| model switches     | the same, right after a change of model: each model has its own cache                                                            |

The last three wrote again what the cache already held, and the section totals
them. `--json` prints the same numbers, and `profile --json` carries them as
`sessions`.

The windows show when parallel conversations are what drained one:

```
  5-hour windows (Claude Code, the latest 5 of 61)
    Oct 18 20:00     $30.35   ~79% of 5h   4 conversations, 3 at once
        90% Billing webhooks · 8% Release notes · 2% Flaky e2e test · 1 more
    Oct 16 13:00     $0.485  ~1.3% of 5h   1 conversation
        100% Landing page copy
    Two or more conversations ran at once in 38 of 61 windows, 83% of spend.
```

A window starts at the hour of the first call after the last one closed and
lasts five hours. At once is the most
conversations with a call in the same 10 minutes.

Guard's handoff note is a fresh start that carries the work over; compacting
carries it over in a summary. Both are measured the same way:

```
  Starting from a note against compacting (Claude Code)
                            from a note   after a compaction
    times                             2                   69
    first call                      39K                  46K
    waited before it               none               1m 16s
    files read again                0.0                  1.2
    calls per prompt                3.0                 11.7
```

First call is the context of the first call after it, waited is how long the
summary took, and files read again counts files the conversation had worked on
before and read again after. Until there are 5 notes it says to read it as a
first look.

---

## Every opportunity carries its own economics

A savings number with nothing behind it is a guess with a dollar sign on it.
So each finding says what happened, why it matters and what to do, and reports
its own arithmetic:

```
  FIX   Oversized context · likely
        $12.14/mo | $147.69/yr | a change in habit | context-bloat

        What happened   25 small tasks started with ~449.4K of context;
                        similar tasks start near 65.9K
        Why it matters  Every call in those tasks re-reads the whole history,
                        so a small job costs as much as a big one.
        What to do      Start small, unrelated jobs in a fresh conversation
                        (/clear), or /compact when you change topic. A
                        subagent also starts with an empty context.

        now    $13.54  ->  after    $0.921  (82 calls, 1% of spend)  basis inferred
```

**Confidence and impact measure different things, deliberately.**

- **Confidence** is about the _money_: how much to trust the dollar figure. It
  is `low`, `medium` or `high`, decided by whether the cost was measured or
  modelled, how many calls the estimate averages over, and whether the fix
  leaves token counts alone. Deleting a duplicate read is more certain than
  swapping a model, and the level says so.

  It is deliberately a level and not a percentage. The three inputs are
  mechanical, but the weighting between them is a judgement no outcome in this
  repo has ever been calibrated against, so "78%" would be a made-up number.

- **Impact** and **risk** are about the _output_. A saving can be
  arithmetically certain and still be a bad idea, which is what
  `optimaizr verify` is for.

`optimaizr scan --why` prints the calculation and every assumption behind each
number:

```
How this was calculated
  Each call re-priced on Haiku 4.5 using its recorded token counts and
  the rate cards in force on the day of the call, then summed.

Assumptions
  * The cheaper model produces a comparable token profile - a different
    model may be more or less verbose.
  * Every affected call fits inside Haiku 4.5's 200.0K-token context.
  * Quality is unverified until `optimaizr verify model-fit` replays this traffic.
```

Nothing here is presented as a guaranteed saving.

---

## Bringing your own data

Three ways in, one analysis. Beyond the SDK wrapper and agent transcripts,
`optimaizr import` reads a CSV or JSON export you already have:

```bash
optimaizr import usage-export.csv --service billing
```

Column names are matched loosely, because every provider exports a different
shape: `prompt_tokens`, `input_tokens`, `ntokens_prompt` and `tokens_in`
all map to the same field. A row carrying its own `cost` is trusted over our
arithmetic, because that row is the actual bill. Rows that cannot be priced are
imported and **flagged**, never silently dropped or guessed at.

---

## The part that isn't a dashboard

Anyone can tell you a cheaper model would be cheaper. The question is whether
it still does the job. `optimaizr verify` answers that on your traffic, before you
change anything:

```bash
$ optimaizr verify model-fit

  optimaizr verify | Route mechanical calls to Haiku 4.5
  quality bar: optimaizr.config.json

   PASS   40 samples replayed

  cost/call   $0.0121 -> $0.0034
  projected   $61.40/mo saved
  this check cost you $0.38

  Quality checks
    ok   no-refusal               candidate 40/40, baseline 40/40
    ok   tool-name-matches        candidate 39/40, baseline 39/40

  Pairwise judge (each pair judged twice, positions swapped)
    52% win rate  9W / 8L / 23T
```

How it works:

- **Replay, not simulation.** Your recorded requests are re-sent under the
  proposed change. Only the candidate is re-run: the baseline response and its
  usage were already recorded in production, which is both the more honest
  reference and half the API cost.
- **Deterministic checks come first.** The JSON parses, the required field is
  there, the same tool got called, the answer is inside its length budget. A
  regression here fails the candidate outright, no judgement involved.
- **Then a pairwise judge**, shown both answers to the same input. Position bias
  is real, so every pair is judged twice with the order swapped. A side only
  wins a pair if it wins both orderings; disagreement is a tie. A judge that
  always picks the first response therefore produces no winner at all; there's
  a test for exactly that.
- **A failed verification is a result.** If the cheap model is worse, optimAIzr
  says so and tells you to keep what you have. The saving wasn't free.

Define the bar in `optimaizr.config.json`:

```json
{
  "qualityBar": {
    "sampleSize": 40,
    "checks": [
      { "type": "json-parses" },
      { "type": "contains", "value": "summary" },
      { "type": "max-chars", "value": 2000 }
    ],
    "judge": {
      "model": "claude-opus-5-5",
      "criteria": "Which response is more accurate and complete?",
      "minWinRate": 0.45
    }
  }
}
```

Verification replays real prompts, so it needs them. Capture is **opt-in,
sampled, redacted, and local-only**: emails, keys, bearer tokens and long
digit runs are masked before anything touches disk, and nothing is ever
uploaded:

```ts
optimaizr.wrap(client, { service: "checkout-api", capture: { rate: 0.02 } });
```

---

## Two levers: compact earlier, a smaller default

Most of a Claude Code or Codex bill is the conversation being re-read on every
call. Two levers are sized from your own sessions and shown as TEST, "up to":

- **Compact earlier.** Each conversation is replayed as if the agent compacted
  at 200K (it otherwise compacts near the model's window, 1M on current
  models): the compaction's summary call and reload are charged, and every
  later call re-reads less. The reload is a cache rebuild, priced at the write
  rate the conversation uses (Claude Code writes 1-hour cache, 2x the input
  rate). Where the agent compacted on its own, the replay starts over from
  there.
- **A smaller default model.** Finished tasks on a frontier model without heavy
  reasoning or repeated failures, re-priced one tier down. Whether the smaller
  model does them as well is what `optimaizr verify model-default` checks.

Applying the first one is a setting, with an exact undo:

```bash
optimaizr apply context-compaction              # Claude Code and/or Codex, whichever you use
optimaizr apply context-compaction --agent codex
optimaizr apply context-compaction --at 400K    # a later point, 100K to 1M
optimaizr undo context-compaction               # puts back what was there
```

For Claude Code it sets `"env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000" }`
in `~/.claude/settings.json`; for Codex, `model_auto_compact_token_limit = 200000`
in `~/.codex/config.toml`. Both are read when a session starts. The previous
values are kept in `~/.optimaizr/settings-changes.json`. Claude Code compacts a
little before the number it is given: with 200000 set, it fired at 166-170K.

A model compacts as its own window fills, so a point at or past that window
changes nothing for it. If every model you use there has a window that small
(Haiku 4.5's is 200K), the setting is left alone and a point below the window
is suggested, like `--at 150K`. If you also use a 1M model, it is set, and
says which model it moves.

The finding also prices compacting later, at 300K, 400K and 600K, from the same
replay. A later point keeps more of each conversation and saves less; pick the
one you trust and pass it with `--at`.

It also counts the compactions Claude Code really ran, from its transcripts:
how many, how many were automatic, how many landed mid-task (the reply before
was about to call a tool), and how long you waited for the summaries. A lower
point compacts more often, and automatic compaction usually cuts into work in
progress, so compacting by hand when a piece of work is done is the safer
habit: `/compact keep the API decisions`.

---

## Did it work?

`optimaizr apply` on its own lists both kinds of change: the ones optimAIzr
makes for you, on or off, and the ones only you can make, with what each is
worth:

```
  Changes optimAIzr makes for you
    context-compaction      on   Claude Code and Codex at 200K, since Oct 7
    statusline              off  optimaizr apply statusline
    Undo any of them: optimaizr undo <rule>

  Changes you make yourself
    cold-resume             Cold cache returns        $91.43/mo
    model-default           Smaller default model     $71.13/mo
    oversized-input         Oversized context          $8.22/mo
    The steps for one: optimaizr apply <rule>. Made it? optimaizr apply <rule> --done
```

For a Claude Code or Codex finding, `optimaizr apply <rule>` prints the steps:
the change is in how the agent is used, so there is nothing to gate or write.
Once you have made it, tell optimAIzr when:

```bash
optimaizr apply cold-resume --done
optimaizr apply context-compaction --done --at 300K --agent claude   # set by hand
optimaizr undo cold-resume                                           # stopped doing it
```

`--done` takes any rule there is, even one with nothing found in this window,
and keeps the agent and project the finding covered. Findings from your app's
SDK traffic still need a passing `verify` (or `--accept-risk`) first, and get
their change as `optimaizr-change.md`.

Every change, made by optimAIzr or recorded by you, goes into
`~/.optimaizr/changes.jsonl`, one line each, never rewritten: an undo is a line
of its own. Compaction settings and model switches from before 0.11 are read
from where they were kept.

`optimaizr results` splits your usage at each change and puts the days after it
against the days before: 14, or as many as the change has been in, up to 30.

```
  Compact earlier: Claude Code at 200K
  applied Oct 7, 12 days ago

  Not clear yet: 5% to 24% less per prompt than the 3 to 14 days before,
  and 5% is within the usual swing. The trade-offs are clearer: calls
  per prompt, tool errors per prompt, compactions a day, files read
  again after summaries a day and waiting for summaries a day went up.

                                                before     after
    cost per prompt                              $1.06    $0.803   -24%
    cost per call                               $0.142    $0.066   -54%
    calls per prompt                               7.5        12   +64%  trade-off
    tool errors per prompt                        0.21      0.35   +68%  trade-off
    calls past 200K                                60%        0%   -60 pts
    median context                                288K      100K   -65%
    compactions a day                             0.23       5.2   23x  trade-off
    landed mid-task                               100%       96%   -4 pts
    files read again after summaries a day        0.38       6.2   16x  trade-off
    waiting for summaries a day                   0.4m      6.8m   16x  trade-off

  Since the change: 46 conversations, 363 prompts, 68 compactions, fired
  at 168K on the median, 80 files read again after them, 0 calls past
  200K.

  Worth knowing
  · Against just the 5 days before the change it is 5% less instead of
    24% less, so part of the difference may have been under way
    already.
```

The verdict is judged on cost per prompt (per call where there are no
prompts, as with SDK traffic), counted only for the agent and project the
change covers. A verdict needs 3 active days and 100 prompts after the change
(300 calls for SDK traffic); until then it says how far along it is and when
to look again. A move of under 10% either way is no clear effect. When a
shorter baseline (3, 5 or 7 days) gives a different size, the verdict gives the
range, lowest to highest, instead of the one number that reads best, and it
says Working or Not working only when every baseline puts the move past 10%.
Otherwise it is Not clear yet, as with mine above: 24% less against the 14
days before, 5% against the 5 days before.

The other rows are there so a saving that costs you something shows it, for
every kind of change: more calls per prompt, more tool errors, more time
waiting on summaries, and for compaction the files read again after each
summary (files the conversation had worked on before it, read again before the
next one). Any of them going up is marked as a trade-off, and the verdict says
so. Codex changes get the same rows, from Codex's own compactions, except the
wait: Codex doesn't record how long a summary takes.

What it can't tell apart, it names: a baseline shorter than 14 days, a
different mix of projects before and after, another change in the same days,
or a difference that was already under way in the days just before. `results
<rule>` shows one change; `--json` gives the whole report.

`optimaizr metrics` counts realised savings only from these readings: what
each measured change saved since it went in, at the measured rate. With
[guard](#guard) on, `results` ends with what it kept in the last 7 days.

---

## Watching live

`optimaizr live` follows Claude Code, Codex, opencode and your wrapped apps as
they run. It opens with a legend, not a manual: what it watches, how a finished
turn reads, the three marks (**⚠** worth a look, **⏸** guard stepped in, **⏳**
a cache about to expire), your last 7 days in a line, whether
[guard](#guard) is on and what it kept, and the keys.

On a terminal the bottom stays in place and redraws itself: a row for each
conversation with a call in the last hour (up to four, then how many more),
working ones first, and the status line under them:

```
  ── now ─────────────────────────────────────────────────────────
  ⠹ Billing webhooks          Claude working · 1m 12s · $0.21 so far · 161K · Opus 5.5 xhigh
  ○ Release notes             idle 6m · 98K · cache warm 54m more · Sonnet 5.5 high
  ◉ optimAIzr live · $4.80 this run · 37 calls · most: Billing webhooks $3.90 · nothing found yet (? why) · watching ⣾
```

A working conversation has a spinner and what the turn has cost so far. An
idle one says how long its cache stays warm (yellow in the last 15 minutes) or
that it expired. Each row ends with the model and effort of its last call, the
first thing left out on a narrow terminal. Each conversation keeps its colour
everywhere it is named.
The status line says what the run has found: nothing yet (under 50 calls), no
waste found, or how much the findings have already cost and what they still
cost a call.

Waste means money lost to a mistake: an expired cache, a whole big file, a
retry loop, a quick job on a big model. Choosing Opus for hard work is not
one, so `?` says it apart, marked `·`, and only when it would move the bill by
a tenth or more:

```
        · Model    Opus 5.5 at xhigh. The same calls on Sonnet 5.5: 31% less, not half (re-reads, 39% of it, cost the same)
        · Effort   xhigh: thinking was 13% of the cost ($1.79); /effort high on routine steps keeps the cache
```

| Key | What it does                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?` | What was checked and passed: the cache hit rate, context against the compaction point, how long caches stay warm, cold returns, tool errors, and on a top model what the model and effort cost. It also prints once at 50 calls and when you stop.                                  |
| `n` | The next step for the biggest finding: what it has already cost, what it still costs a call, and what to do now and next time. With nothing found, the costliest conversation this run, what each message re-reads, and `/compact` against `/clear` (`/new` in Codex and opencode). |
| `a` | Applies that step when it is a setting optimAIzr can undo (guard, compacting earlier), after a Y/N. With `--dry-run` it says what it would change.                                                                                                                                  |

It says when a conversation's context jumps by 50K or more in one call, or
passes 200K, with what re-reading it costs on that call, and the first time a
Claude Code or Codex conversation passes 200K it offers to compact earlier from
then on. Findings come as cards with what happened, the change, the money and
how sure it is; press **Y** to apply, **N** to skip, **D** for the evidence. On
Ctrl-C it prints what the run saw and found.

It also follows each long conversation's cache (50K tokens or more), in the
rows at the bottom (for Codex, whose cache lifetime OpenAI decides, how long it
has sat idle). Five minutes before a cache expires it says what coming back
after will cost, when that is 50 cents or more, and a call that did come back
to an expired cache is shown with what it paid against a warm read, and
whether you were away or Claude was waiting on a tool. With `--json` these
arrive as `{"cache": {"kind": "expiring" | "cold", ...}}`.

`--notify` adds system notifications (macOS, or `notify-send` on Linux) for a
cache about to expire, a cold return, and a turn done after 45 seconds or more,
for when the terminal is out of sight.

When a Claude Code turn ends, one line names the conversation, in its colour,
then how long the agent worked, what the turn cost, its own share of your
5-hour window and the conversation so far:

```
  ●  14:32:08  Fix the login bug     2m 10s · $0.620 · ~1.5% of 5h · conversation $7.80
```

The share is the turn's dollars over what 1% of your window costs, not the
meter before and after: with three or four sessions open, all of them move it.
What 1% costs is learned from the meter's history (Claude Desktop keeps one,
and the status line logs a reading each time the meter moves) and what Claude
Code spent while it moved, once three windows have each moved 5 points or
more. Until then it is your plan's estimated limit over 100, and the legend at
the top says which it used. This works for conversations in the VS Code
extension too. In a conversation over 100K a second line says what each
message re-reads before anything new: `now 152K long: Claude re-reads all of it
on every step, about $0.19 a message here`. `--no-turns` hides them, and with
`--json` each turn arrives as `{"turn": ...}`.

### Under Claude Code's prompt

```
optimaizr statusline on        # sets statusLine in ~/.claude/settings.json
optimaizr statusline off       # takes it out again
optimaizr statusline           # on or off, and what it shows for your latest conversation
```

Claude Code runs `optimaizr statusline` under its prompt, every 30 seconds
and after each message:

```
◉ optimAIzr · 161.0K context, $0.032/call to re-read · cache warm 42m · 5h 61%
◉ optimAIzr · 161.0K context, $0.032/call to re-read · cache warm 12m, then $1.29 to write again · leaving? handoff note, then /clear · 5h 61%
◉ optimAIzr · 161.0K context, $0.032/call to re-read · cache expired, next message writes it all again ($1.29) · new task? /clear first · 5h 61%
```

It reads the end of the session's transcript for the last call's time and
cache writes, and Claude Code's own 5-hour meter from the input it is given
(the weekly one too, from 75%). The one thing it writes: when the 5-hour
meter moves, the time and the new percent go to `~/.optimaizr/meter.jsonl`, to
learn what 1% of the window costs. The command uses the node
and script it was applied with, by full path, so a different `node` first on
Claude Code's PATH can't break it. A status line you already have is never
replaced: `statusline on` says so and changes nothing. `apply statusline` and
`undo statusline` do the same as `on` and `off`.

Claude Code draws status lines in a terminal. The VS Code extension's chat panel
doesn't show one, so there run `optimaizr live` in the editor's terminal for the
same countdown.

---

## Guard

`live` says what a step cost after it was paid. Guard steps in before, through
ordinary Claude Code hooks, so its holds work in the terminal and the VS Code
extension's chat panel alike, with no mod:

```
optimaizr guard on        # adds its hooks to ~/.claude/settings.json
optimaizr guard off       # takes out only its own
optimaizr guard           # on or off, and what it held in the last 7 days
```

The first time `optimaizr` finds $5 or more of messages guard would have held
in the last 30 days, it says how many and what they cost, and asks once to turn
it on (Enter is yes). Under $5 it waits for a later run. Only in a terminal:
piped, with `--json` or in CI it never asks.

It holds a costly step once and lets it through when it comes again:

| Hold          | When                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expired cache | A message to a conversation whose cache expired, when sending it writes 50 cents or more back into the cache. It says what, as a share of your 5-hour limit on a Claude plan, and on Opus or Fable what Sonnet would pay. Not after the 5-hour limit stopped the conversation, nor for a bare "continue". |
| Big read      | Claude reading a whole file over 64KB. Claude is told to Grep for the part it needs or read a range, and a second whole read goes through.                                                                                                                                                                |
| Retry         | The same command failing twice in a row with nothing changed in between. Claude is told to change something or say what blocks it.                                                                                                                                                                        |
| Compact nudge | Once, at the end of a turn, when the conversation is at 75% of where it compacts: `/compact` now, before the next task starts mid-summary. Claude Code compacts under its setting (168K with 200K set, on mine), so once it has compacted 3 times under yours, the nudge goes by where it really did.     |

A held message isn't lost: Claude Code prints it under the hold as Original
prompt. Send it again to go ahead, or type `/clear` and send it there: the
new conversation starts from a short note of where the held one stood, built
from its transcript with no model call:

```
Asked last: add the retry to the webhook handler
Changed: src/webhooks.ts, test/webhooks.test.ts
Dropped: npm run e2e (failed 2 times); a change to src/queue.ts, undone
Still open: update the docs
Last reply: The handler now retries three times...
```

Dropped is what was tried and didn't work: a command that kept failing, an
edit you turned down, a change Claude made and then undid, so the next
conversation doesn't try it again. A search that finds nothing isn't counted.
The note goes only to the `/clear` of the conversation it was held in, once,
within 30 minutes. `optimaizr sessions` compares conversations started from it
with ones carrying on after a compaction.

**What it kept.** Every hold is logged, and so is a held step that went
through after all. Only holds that stuck count: a message never sent again, a
whole read never made, a retry never run. The total, as `4 catches, $2.17 not
spent`, shows in `guard`, at the start of `live`, on the profile, at the end of
`results` and on the status line when there is nothing to warn about. A cold
hold counts the rewrite it avoided, a big read the first write of what it
would have sent; a retry has no dollar figure.

**Once a week.** The first conversation you finish a turn in each week starts
`optimaizr guard week` in the background, and the next turn shows its line:

```
optimAIzr, your last 7 days: re-reading 33% of spend (was 29%), 3 returns to a cold cache (was 25), 1 stop at the 5-hour limit (was 1). Guard: 4 catches, $2.17 not spent.
```

Stops at the 5-hour limit come from Claude Code's transcripts and show when
either week had one; a retry before the reset is the same stop. Guard's
catches get a "was" once it has been on for a week before. The same line opens
`live` and the profile. Headless runs (`claude -p`, the
SDK) never get it, and the cold hold skips them too.

**Your 5-hour pace.** On a Claude plan whose limit optimAIzr has learned (from
the status line's meter, Claude Desktop, or the stops Claude Code writes in its
transcripts), guard works out at most every 10 minutes, in the background,
whether the window runs out before it resets at the last hour's pace. From
half the limit used, it says so once a window, at the end of a turn:

```
optimAIzr: at the last hour's pace, your 5-hour limit runs out around 14:09, 51 minutes before it resets at 15:00. About 63% is used. Sonnet 5.5 makes it last longer: /model sonnet.
```

The model line shows only on a frontier model, and running out within 15
minutes of the reset isn't worth a warning. On my last 51 windows it came
before all 7 stops at the limit, 19 minutes to 2h 44m ahead, 67 on the median.
It also came in 10 of the 44 windows that never stopped, 4 of which still
ended at 80% of the limit or more. `optimaizr guard pace` runs the same check
by hand.

Guard reads the end of the conversation's transcript at each message and tool
call, in memory: about 50ms on a 405K conversation. What it keeps is in
[SECURITY.md](../SECURITY.md): what it held, the note until it is used, the
week's line and the pace.

---

## What it looks for

| Rule                    | What it catches                                                 |
| ----------------------- | --------------------------------------------------------------- |
| `cache-churn`           | A prefix that changes between calls, so caching never pays off  |
| `repeat-tool-calls`     | Files re-read inside one session, re-billed on every later call |
| `model-fit`             | Mechanical turns running on a model priced for reasoning        |
| `reasoning-effort`      | Heavy deliberation that produced almost no output               |
| `oversized-tool-output` | Single results large enough to distort the whole session        |
| `error-loops`           | The same failing command retried unchanged                      |
| `prompt-bloat`          | An oversized system prompt paid for on every call               |
| `repeated-context`      | The same prefix re-sent across separate sessions                |
| `oversized-input`       | Small jobs inheriting a whole session's context                 |
| `cold-resume`           | A long conversation picked up after its cache expired           |
| `heavy-start`           | Conversations that start heavy: MCP servers, agents, skills     |
| `oversized-output`      | Responses far longer than the median, including truncated ones  |
| `spend-concentration`   | A few workloads driving most of the bill                        |
| `cost-spike`            | A sudden increase that call volume does not explain             |
| `pricing-change`        | Rates changing under you                                        |

Findings are marked **safe to apply** (pure waste removal) or **needs
verification** (could change output). The headline savings figure counts only
what you can actually bank. A rate increase you have to absorb is reported
separately, because a number you can't bank is the thing this tool exists to
stop shipping.

---

## Getting the numbers right

Two things make naive LLM cost tooling wrong, and both are handled here.

**Transcripts double-count.** Claude Code writes one JSONL record per content
block and stamps every one with the _same_ usage object from the parent API
response. A response with a thinking block and six tool calls lands as seven
records each claiming the full token count. Summing rows inflates spend by
**1.91x** on real transcripts. optimAIzr groups by `message.id` and keeps one
usage per response, preferring the completed record over the placeholder that
early blocks carry.

**Images don't cost what they weigh.** A screenshot is ~800,000 base64
characters but only ~1,600 tokens, because images bill on pixel area after the
API downscales them to a 1568px long edge. Estimating from encoded length
overstates a screenshot's cost by more than a hundredfold. optimAIzr reads the real
dimensions out of the PNG, JPEG, GIF or WebP header and applies the actual
formula.

**Prices are dated, and they are data.** A model's price is a list of rate
cards with effective ranges, so a call is always costed at the rate in force on
the day it was made, not at today's rate applied backwards. Promotional pricing
is not a special case; it is just an earlier card.

A card is only added when a price change actually takes effect. An _announced_
change is not a card: Claude Sonnet 5's scheduled rise to $3/$15 on
1 September 2026 was cancelled, and encoding it early over-charged every Sonnet
call from that date by exactly 1.5x. There is a regression test pinning the rate
across that boundary.

On Anthropic models cache reads bill at 10% of the input rate by default,
5-minute writes at 125%, 1-hour writes at 200%, and batch traffic at 50%. That
is per-provider policy, and a model can set its own: Opus 5.5 reads at 5%
($0.20/M against $4/M input) and Fable 5.1 at 2.5%.

**Open models count too.** Through opencode you can run DeepSeek, GLM, Kimi or
MiniMax, and each has a card from its vendor's own price list: DeepSeek V4 at
half price off-peak (outside 01:00 to 04:00 and 06:00 to 10:00 UTC on
weekdays), MiniMax M3 with its long-context rate, the free GLM models at $0.
They are priced so their calls count; `guide` lists them on one line and
never suggests switching to one. A model with no card is priced at what
opencode itself recorded for the call, when it recorded anything, and the
report says how many calls that was. Calls nothing could price are counted
under the total as $0, with the models named, so a gap never passes for a
cheap month.

**Some things aren't billed per token at all.** Server-side web search bills
$10 per 1,000 searches regardless of tokens, so a report that sums only
input/output/cache misses it completely, and invisibly,
because no token count moves when a search runs. optimAIzr reads
`server_tool_use.web_search_requests` and prices it as its own component. Web
fetch is free and priced at zero. Code execution bills by container-hour
against a monthly free allowance that a transcript does not record, so it is
not estimated rather than guessed at.

**Days need a timezone.** A call at 01:00 local in UTC+2 belongs to the
previous UTC day, which can move a real share of a day's spend across the
boundary. Day buckets default to UTC so two machines reading the same
transcripts agree; `--tz local` or `--tz Europe/Berlin` cuts them elsewhere.
Whichever is used, the report prints it: a daily figure that doesn't say
which midnight it used can't be compared to anything.

```
optimaizr scan --tz local
optimaizr report --tz Asia/Tokyo --out report.html
```

### What this number is not

The headline is **estimated API-equivalent spend**: published list rates
applied to the tokens your transcripts recorded. It is not an invoice.

If you are on a Claude subscription or a plan with a usage allowance, that
meter counts consumption on its own terms and will not match this figure
exactly. Neither number is wrong; they answer different questions. Use this one
to compare your own traffic against itself (across days, models,
projects and routes), not to predict a bill.

`scripts/reconcile.py` is a standalone, dependency-free second implementation
that prices the same transcripts independently and breaks any gap down by the
rules two tools usually disagree on: which midnight the day was cut at, whether
cache writes were priced at the 1-hour rate or the 5-minute one, and whether
subagent traffic and every project are in scope. None of those are arithmetic
errors.

Two further caveats on projections:

- **Monthly and annual figures divide by the window's full span**, including
  days with no traffic. A fortnight's gap in the middle of a window is counted
  as elapsed time and deflates the per-day average.
- **Transcripts are live.** optimAIzr reads files that a running agent session
  is still appending to, so scanning twice during an active session legitimately
  returns two different totals.

Adding a model, a price change, or an entirely new provider is a config edit,
never a code change:

```json
// ~/.optimaizr/models.json
[
  {
    "id": "acme-turbo-1",
    "label": "Turbo 1",
    "provider": "acme",
    "tier": "fast",
    "rates": [{ "from": "2026-01-01", "inputPerM": 0.5, "outputPerM": 1.5 }],
    "contextTokens": 128000,
    "maxOutputTokens": 8000,
    "capabilities": ["tools"],
    "bestFor": "Cheap bulk work."
  }
]
```

The analysis engine never learns about a provider; it reads the catalogue.

---

## Architecture

```
Provider -> Adapter -> UsageEvent -> analysis -> savings -> recommendation -> UI
```

Adapters are the only place vendor-specific knowledge is allowed. Everything
downstream reads `UsageEvent` and nothing else, which is what makes spend
across vendors comparable and what makes adding a vendor additive rather than a
refactor. `optimaizr providers` lists what is registered.

The domain types live in `packages/core/src/domain/types.ts`: `UsageEvent`, `Provider`,
`ProviderAdapter`, `CostCalculation`, `OptimizationFinding`, `SavingsEstimate`,
`Recommendation`, `Project`, `Organization`, `Evidence`.

Rules are pure functions registered in one array; adding a detector means
adding a function. Findings describe the world and are recomputed every run;
recommendations carry the decision state and persist.

---

## Observe, explain, recommend, simulate, optimise

```
observe     optimaizr scan       what am I spending?
explain     optimaizr why        why am I spending it?
recommend   optimaizr recommend  what can I change?
simulate    optimaizr simulate   what would that cost?
verify      optimaizr verify     would the output still be good?
optimise    optimaizr apply      the exact change, gated on a passing verify
measure     optimaizr results    did it work?
```

`simulate` and `verify` are deliberately different things. Simulation is
arithmetic on your recorded tokens and says nothing about quality. Verification
replays your traffic and scores it. Conflating the two is how cost tools talk
teams into regressions.

---

## Data handling

Analysis is entirely local. No backend, no account, no telemetry, no upload.
Reports are self-contained files that fetch nothing when opened.

Network calls happen only in `verify` (to your own provider, with your own key,
which optimAIzr never stores or logs), in Jev if you enable it, and once a day
in a background request to registry.npmjs.org for the latest optimaizr version
number. That request sends nothing about you or your usage, never runs in CI,
with `--json` or when output is piped, and is off with
`OPTIMAIZR_NO_UPDATE_CHECK=1` or `"updateCheck": false` in the config. See
[SECURITY.md](../SECURITY.md).

Prompt contents are not stored unless you explicitly enable capture, which is
sampled, capped, redacted before it touches disk, and local-only. The one
exception is [guard](#guard)'s handoff note, kept until the `/clear` it was
made for, 30 minutes at most. Nothing in
that store is ever uploaded.

`optimaizr privacy` prints the full answer; [SECURITY.md](../SECURITY.md) is the
long form.

---

## Install

```bash
npm install optimaizr
```

Node 20.11+. Zero runtime dependencies. `@anthropic-ai/sdk` and `openai` are both
optional peers, needed only for `verify`, and only the one whose traffic you
are verifying. `verify` reads `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, uses
whichever it finds, and says plainly which traffic it had to skip.

Recorded data lives in `~/.optimaizr/` as plain JSONL. No daemon, no database, no
network.

```bash
npm test    # unit tests, plus integration against the real SDK
npm run e2e  # drive the whole CLI against a mock endpoint - no key, no spend
```

### Tested against the real SDK, not just stubs

Unit tests prove the logic; a second layer proves the wrapper survives contact
with the actual `@anthropic-ai/sdk` client - a real Proxy over a real class
instance, real HTTP, real SSE streaming, real `RateLimitError` objects. The
endpoint is mocked, so it costs nothing and needs no key.

`npm run e2e` runs the full product loop end to end: record real SDK traffic
through the wrapper, `optimaizr scan` finds the opportunity, `optimaizr verify`
replays all of it on the cheaper model and judges every pair twice, and
`optimaizr apply` opens only because a PASS was recorded.

## License

MIT
