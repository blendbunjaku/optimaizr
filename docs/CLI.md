<!-- Full CLI reference. The npm page (apps/cli/README.md) is the short version. -->

# optimAIzr

**Find where your LLM spend is wasted, then verify and apply the savings.**

Add one line of code, or point it at your coding agents with no production
changes at all, and you get every call: cost, latency, tokens, and what's being
wasted. Then it tells you what to cut: a cheaper model here, a cache there, a
bloated prompt to trim.

Every fix is checked against your own quality bar first, on your own traffic,
so you're never trading cost for worse output.

```
$107.72 observed   |   $84.77/month at this rate

  tokens in  317.7M    (310.8M cached, 98% hit rate)
  tokens out 1.3M      (443.1K reasoning, 33% of output spend)

  $7.49/month recoverable - 9% of your projected spend

  MEDIUM  439 mechanical calls ran on an over-specified model
          $5.62/mo | needs verification | model-fit
```

---

## New in 0.7.0

**Claude Team.** `--plan team` reads usage against a Standard seat ($25) and
`--plan team-premium` against a Premium seat ($125), with the same five-hour
sessions as Pro and Max; the price is marked per seat. Enterprise and Free are
recognised and redirected: Enterprise bills usage at API rates under a spend
limit, so `--budget` answers its question, and Free does not include Claude
Code. See [On a Claude plan](#on-a-claude-plan).

**Every ChatGPT plan Codex reports.** `prolite` is Pro 5x at $100 and `pro` is
Pro 20x at $200, Go is priced at $8, and `team` shows as Business, its current
name. A plan type newer than optimAIzr's table is named as Codex reports it and
shown without a price. See [On a ChatGPT plan](#on-a-chatgpt-plan).

**`optimaizr limit` names your plan.** Its closing hint said `--plan pro` for
everyone. It now uses the plan in your config, or the one you passed.

**Claude Sonnet 5.5** is in the catalogue at $2/$10 per million (cache reads
$0.20), reported as its own model rather than counted as Sonnet 5.

**Fixes.** The `verify` judge's output ceiling was 16 tokens, which a model
that thinks by default (Opus 5) could spend before giving its verdict; that
scored as a tie. It is now 1,024. The cost-spike finding pointed at a
`why --day` flag that does not exist and now points at `optimaizr show
cost-spike`. A flag written `--name=a=b` kept only `a`. `live` read recent
history up to three times at start and now reads it once.

---

## New in 0.6.1

**Live applies to your app's next request.** Press `Y` on a model swap in
`optimaizr live` and apps using `wrap()` switch from their very next request,
with no restart. The override is scoped to the service, route and model the
finding covered, is kept in `~/.optimaizr/overrides.json`, and falls back to the
original request if the provider rejects the new model. Opt out with
`wrap(client, { overrides: false })` or `OPTIMAIZR_OVERRIDES=0`. Calls made
through the `.stream()` helper are never rewritten; use `create({ stream: true })`.

```bash
optimaizr undo             # the overrides that are active
optimaizr undo model-fit   # revert one; wrapped apps go back on their next request
```

Claude Code reads its model when a session starts, so there `Y` writes
`~/.claude/settings.json` for your next session (when the swap covers at least
80% of its spend) and prints the `/model` command that switches this one. In
Codex, `Y` records the decision; type `/model` to switch.

**Large Claude Code histories.** Past roughly 100,000 recorded responses,
reading Claude Code transcripts failed with "Maximum call stack size exceeded"
and every report showed Codex usage only. They are read in full now. A
transcript that cannot be read is skipped with a note, and a source that fails
outright is a red warning at the top of every command.

**`optimaizr feedback`** prints where to report a bug and the version line to
include with it.

---

## New in 0.6.0

**Monthly budgets.** If your company gives you a fixed amount of Claude Code or
Codex spend per month, tell optimAIzr the cap and it answers in dates:

```bash
npx optimaizr profile --budget 300
```

```
  Budget

  Monthly cap               $300.00  resets Oct 1 (UTC)
  Used this month           $246.40  ████████████████░░░░ 82% · day 22 of 30
  At this rate               Sep 27  cap reached 4 days before reset
  With the fixes below       Sep 28  +1 day · estimated
  Pace: $11.42/day, from this month so far. Counts this machine only.
```

`optimaizr live --budget 300` warns as the month crosses 50%, 80%, 95% and 100%
of the cap, once each. Set it once in `optimaizr.config.json` with
`"budget": 300`. See [Stay under a monthly cap](#stay-under-a-monthly-cap).

**Claude Pro and Max.** On a flat-rate plan the dollars are not a bill, so
`--plan pro` (or `max5`, `max20`, and since 0.7.0 `team`, `team-premium`)
reads your usage the way the plan rations it:
five-hour sessions, how much of each goes on waste, and the session you are in
now. Run `optimaizr limit` when Claude tells you the limit is reached and it
learns where your limit sits; `live --plan pro` then warns at 80% and 95% of
it. See [On a Claude plan](#on-a-claude-plan).

**`optimaizr card`.** Your last 30 days as a 1200x630 image to post: what it
costs at API prices (and the multiple of your plan, with `--plan pro`), tokens,
cache, top model, and how much was waste. It writes `optimaizr-card.html`, which
downloads a PNG, copies the image or opens a post, and `optimaizr-card.svg`
beside it. Totals only: no project names, paths, prompts or fine-tune ids.

**ChatGPT plans, read from Codex.** Codex writes OpenAI's own limit meter into
every session file: the plan, and for each rolling window the share used and
the reset time. `profile` shows it with no flag, next to what the usage would
cost at API prices and how much of it was waste, and `live` warns at 80% and 95%
of each window. See [On a ChatGPT plan](#on-a-chatgpt-plan).

**"At this rate" means the recent rate.** Monthly figures, spend and every
saving, now project the last 30 days of a longer history instead of averaging
all of it. A history that began in April and grew ten-fold in September used to
report April-weighted numbers; it now reports September's. Histories of 30 days
or less are unchanged.

**Smaller things.** `optimaizr` with no command runs `profile`. A mistyped
command says so, suggests the closest one, and exits 1 instead of printing help.

---

## New in 0.5.0

**`optimaizr profile`.** One screen: what you spend, how much of it is waste,
and the single biggest opportunity, with the next command to run. It is
read-only and reports the same figures as `scan`, `audit` and `recommend`. See
[Your profile at a glance](#your-profile-at-a-glance).

**Current models priced.** Claude Opus 5.5 and Fable 5.1, GPT-6 Astra, Sol and
Luna, and the GPT-5.1 through 5.6 families are in the catalogue. Before this,
`claude-opus-5-5` and `gpt-5.5` fell back to the nearest older id and were
costed at Opus 5 and GPT-5 rates, and `gpt-6-*` went unpriced. Reports are
computed on the fly, so re-running them fixes the numbers.

**OpenAI cache writes.** GPT-5.6 and later bill cache writes at 1.25x input.
They are read from `input_tokens_details.cache_write_tokens` and costed at that
rate instead of as plain input. Past 272K input tokens the whole request is
billed on the long-context band, as OpenAI bills it.

---

## New in 0.4.0

**Live recommendations, on the agent you are already using.** `optimaizr live`
watches calls as they land and surfaces a fix the moment one crosses its
threshold, instead of waiting for you to run a report. It follows Claude Code
and Codex sessions as they are written, so there is nothing to instrument:
open a second terminal, use your agent as normal, and recommendations appear as
the pattern emerges. It follows the SDK ledger too, for apps using `wrap()`.

```
  ⚡ optimAIzr

  This task looks suitable for a cheaper model.

  Current:       Sonnet 5
  Suggested:     Haiku 4.5
  Observed cost: $0.202 / 26 calls

  [Y] Apply optimization
  [N] Continue
  [D] Why?
```

It runs the same rules the reports run (there is no second recommendation
engine) over a rolling window of recent calls, because every rule is a
population statistic and no rule can judge a single call in isolation. The
transcript parsers are the same ones `scan` uses, one per vendor, shared
between both paths, so a call analysed live and the same call analysed
tomorrow produce identical numbers. Amounts are what was
**observed** over that window, never projected to a month: a window of minutes
cannot honestly be annualised.

`Y` is honest about what it can do. `live` follows the ledger, and the ledger is
written after a response returns, so the call on screen has already been sent
and billed. Until a pre-request integration exists, accepting records the
decision and hands you `optimaizr verify <rule>` rather than claiming to have
changed a request. `D` shows the evidence behind the detection and returns you
to the choice. Low-confidence findings are printed, never prompted, and the same
rule and route is only ever raised once per session.

**Codex transcripts.** OpenAI agent spend now reads with no setup, exactly as
Claude Code's does: `~/.codex/sessions` is picked up automatically by `scan`,
`why`, `recommend` and the rest. Two vendors, one dataset, directly comparable.

**Gemini, built but switched off.** The catalogue, `usageMetadata` parsing, the
`generateContent` wrapper surface and a Gemini dialect for `verify` are all
implemented and tested, but the rate cards have not been checked against
Google's published pricing, and no Gemini replay has run against the live API.
So it ships dark. Turn it on with `OPTIMAIZR_GEMINI=1` or
`"experimental": { "gemini": true }` in `optimaizr.config.json`, and verify the
rates before trusting a figure. While it is off, a Google client is left
entirely untouched rather than recorded at $0.

**Reports are self-contained.** The HTML dashboard no longer pulls webfonts
from a CDN, so opening one makes no network request at all.

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
npx optimaizr scan
```

Reads Claude Code transcripts straight from `~/.claude/projects` and Codex
sessions from `~/.codex/sessions`. No instrumentation, no config, no production
changes, and both land in one dataset, so Anthropic and OpenAI agent spend sit
in the same report.

---

## Commands

|                             |                                                                 |
| --------------------------- | --------------------------------------------------------------- |
| `optimaizr audit`           | The savings audit: what you spend, what is recoverable, and why |
| `optimaizr profile`         | One-screen snapshot: usage, waste, and your biggest bottleneck  |
| `optimaizr scan`            | Spend, savings, and what to do about it                         |
| `optimaizr why`             | Drill into where the money actually goes                        |
| `optimaizr live`            | Watch calls as they happen and surface fixes interactively      |
| `optimaizr recommend`       | Ranked actions with impact and confidence                       |
| `optimaizr show <rule>`     | The individual requests a recommendation touches                |
| `optimaizr simulate <rule>` | What the change would cost, arithmetically                      |
| `optimaizr waste`           | Just the opportunities                                          |
| `optimaizr tokens`          | Token analytics and the priciest individual calls               |
| `optimaizr verify <rule>`   | Prove a fix against your quality bar before applying it         |
| `optimaizr apply <rule>`    | Get the exact change, gated on a passing verification           |
| `optimaizr import <file>`   | Load a CSV or JSON usage export you already have                |
| `optimaizr report`          | Write a shareable HTML dashboard                                |
| `optimaizr guide`           | Which model for which job, with the arithmetic                  |
| `optimaizr providers`       | What can be read, and from where                                |
| `optimaizr privacy`         | What is collected, stored and sent                              |
| `optimaizr metrics`         | How much has been analysed, and how much found                  |

Flags: `--why` (show every calculation and assumption), `--days N`,
`--project STR`, `--source all|agents|sdk`, `--tz utc|local|<IANA>`, `--json`.

`live` also takes `--backfill N` (replay recorded history first), `--window N`,
`--min-usd N`, `--source all|agents|sdk`, and `--no-prompt` (print
recommendations instead of asking). With `--json` it never prompts.

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

## Your profile at a glance

```bash
npx optimaizr profile
```

```
  optimAIzr | profile
  2026-09-01 to 2026-09-28  (27.0 days)

  AI usage

  Spend                      $0.993  $1.10/month at this rate
  Calls                          50
  Tokens                       4.2M  4.2M in / 5.2K out

  Optimization

  Flagged calls                  50  100.0% of calls
  Potential waste            $0.858  in this window
  Potential savings       $0.954/mo  $11.60/year

  Biggest opportunity

  ! Oversized context

    Small jobs are inheriting a whole session's context to do
    their work.
    10 calls affected.

    Estimated savings $0.881/month | medium confidence, inferred

  Top opportunities

  1. Oversized context           $0.881/mo  oversized-input
  2. Model mismatch              $0.073/mo  model-fit

  Next step
    optimaizr simulate oversized-input
```

Every figure is the same one `scan`, `audit` and `recommend` report; `profile`
only picks the three things worth seeing first. It is read-only and fully
local, and takes the same `--days`, `--project`, `--source` and `--json` flags.

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

```bash
optimaizr profile --plan pro       # or "plan": "pro" in config
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
a little low. Two plans have no session view, and `--plan` says so:

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
  Your session limit        ~$26.90  learned from 3 recorded hits
  This session               $12.40  since 20:00, resets 01:00 · ~46% of it
```

**Teaching it your limit.** Anthropic does not publish the limit, and Claude
Code does not write it to its transcripts. When Claude says the limit is
reached, run:

```bash
optimaizr limit             # now
optimaizr limit --at 15:10  # after the fact
optimaizr limit undo        # remove the last one
```

Each hit records what that session had used by then. The median over your hits
is your limit, and `optimaizr live --plan pro` warns at 80% and 95% of it, once
each per session.

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

Until a plan is set, `profile` ends with a one-line reminder that `--plan`
exists. If you pay per token, `{ "plan": "api" }` in config turns it off.

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

---

## Every opportunity carries its own economics

A savings number with nothing behind it is a guess with a dollar sign on it.
So each finding reports:

```
MEDIUM  441 mechanical calls ran on an over-specified model
        $5.76/mo est.  |  $70.12/yr  |  needs verification  |  model-selection

        now    $14.07  ->  after     $6.75  (441 calls, 12% of spend)
        confidence medium   quality impact medium   basis estimated
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
      "model": "claude-opus-5",
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

Cache reads bill at 10% of the input rate, 5-minute writes at 125%, 1-hour
writes at 200%, and batch traffic at 50%, all per-provider policy, all
overridable per model.

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
which optimAIzr never stores or logs) and in Jev, if you enable it. See
[SECURITY.md](../SECURITY.md).

Prompt contents are not stored unless you explicitly enable capture, which is
sampled, capped, redacted before it touches disk, and local-only. Nothing in
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
npm test    # 85 tests, including integration against the real SDK
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
