import {
  blue,
  bold,
  type BudgetStatus,
  budgetStatus,
  callActivity,
  type CallEvent,
  codexPlanView,
  createBudgetTracker,
  createCodexLimitTracker,
  createSessionTracker,
  dim,
  green,
  LIVE_DEFAULTS,
  localTime,
  modelLabel,
  monthDay,
  PLANS,
  planView,
  red,
  renderBudgetCrossing,
  renderCodexCrossing,
  renderLiveRecommendation,
  renderSessionCrossing,
  resetTime,
  usd,
  windowLabel,
  yellow,
} from "@optimaizr/core";
import {
  activeModSessions,
  claudeModRewriter,
  claudeProjectsRoot,
  claudeSettingsRewriter,
  codexSessionsRoot,
  createLiveSession,
  describeClaudeOverride,
  ledgerPath,
  type ModelOverride,
  overridesPath,
  readOverrides,
  removeOverrides,
  sdkOverrideRewriter,
  tailCodex,
  tailLedger,
  tailTranscripts,
} from "@optimaizr/local";
import { Args, num } from "../args.js";
import { budgetOf, planOf } from "../config.js";
import { load, readLimitHits, summaryOptions } from "../data.js";
import { createLivePrompt } from "../live-prompt.js";

/**
 * `optimaizr live`: the same rules as `scan`, run continuously over what the
 * ledger and agent transcripts record. Money is reported as observed over the
 * window, never projected to a month.
 */
export async function cmdLive(args: Args): Promise<void> {
  // Jev is off in this version: it needs each user's own TYPESAFE_API_KEY and
  // is early-access. The code and tests stay; OPTIMAIZR_JEV=1 re-enables it.
  const jevAllowed = process.env.OPTIMAIZR_JEV === "1";
  const useJev = Boolean(args.flags.jev) && jevAllowed;
  if (args.flags.jev && !jevAllowed) {
    console.log("");
    console.log(
      `  ${yellow("--jev is disabled in this version")} ${dim("- continuing with the local rules.")}`,
    );
    console.log(
      `  ${dim("It needs your own TYPESAFE_API_KEY; set OPTIMAIZR_JEV=1 to re-enable.")}`,
    );
  }
  const dryRun = Boolean(args.flags["dry-run"]);
  const backfill = num(args.flags.backfill, 0);
  const json = Boolean(args.flags.json);
  const source = String(args.flags.source ?? "all");
  // Ask only when someone can answer: not with --json, a piped stdin, or --no-prompt.
  const interactive = !json && Boolean(process.stdin.isTTY) && !args.flags["no-prompt"];

  if (useJev && !process.env.TYPESAFE_API_KEY && !dryRun) {
    console.log("");
    console.log(
      `  ${yellow("TYPESAFE_API_KEY is not set")} ${dim("- --jev does nothing without it.")}`,
    );
    console.log(
      `  ${dim("Jev is TypeSafe's model (typesafe.ai); the key is yours, not optimAIzr's.")}`,
    );
    console.log(`  ${dim("Everything below is the local rules, which need no key at all.")}`);
  }

  // Assigned once the run loop exists; Ctrl-C inside a prompt routes here so
  // it behaves exactly like Ctrl-C anywhere else.
  let requestExit: () => void = () => {};

  const prompt = json
    ? null
    : createLivePrompt({
        interactive,
        jevEnabled: useJev,
        dryRun,
        // What Y can change. The call on screen is already billed; wrapped apps
        // and Claude Code sessions running the mod switch on their next request.
        // Without the mod, settings.json covers Claude Code's next session.
        rewriters: [
          sdkOverrideRewriter(),
          claudeModRewriter(),
          claudeSettingsRewriter({ unless: () => activeModSessions().length > 0 }),
        ],
        render: (rec) => `\n${renderLiveRecommendation(rec, { replayed: backfill > 0 })}`,
        onExit: () => requestExit(),
      });

  const session = createLiveSession({
    analyzer: {
      maxEvents: num(args.flags.window, LIVE_DEFAULTS.maxEvents),
      minUsd: num(args.flags["min-usd"], LIVE_DEFAULTS.minUsd),
    },
    ...(useJev
      ? {
          jev: {
            dryRun,
            // Print the exact bytes before they leave, never a summary.
            onRequest: (body) => {
              console.log("");
              console.log(
                `  ${yellow("-> api.typesafe.ai")} ${dim(
                  dryRun
                    ? "would send this route metadata (dry run, nothing sent):"
                    : "sending route metadata:",
                )}`,
              );
              for (const line of body.state) console.log(`     ${dim(line)}`);
              console.log("");
            },
            onVerdict: (route, needsFrontier) => {
              // Otherwise a working integration and a broken one look alike.
              const pct = (needsFrontier * 100).toFixed(0);
              console.log(
                `  ${blue("<- jev")} ${dim(`${route}: ${pct}% likely it needs its current model`)}`,
              );
            },
            onError: (err) => {
              console.log(`  ${dim(`jev unavailable: ${err.message} - rules continue alone`)}`);
            },
          },
        }
      : {}),
    onRecommendation: (rec) => {
      if (json) {
        console.log(
          JSON.stringify({
            rule: rec.finding.rule,
            action: rec.recommendation.action,
            rationale: rec.recommendation.rationale,
            observedUsd: rec.observedUsd,
            windowEvents: rec.windowEvents,
            windowMs: rec.windowMs,
            trigger: rec.trigger,
            sessions: rec.sessions,
            examples: rec.examples.map((e) => ({
              id: e.id,
              ts: e.ts,
              sessionId: e.sessionId,
              isSubagent: e.isSubagent ?? false,
              project: e.project,
              model: e.model,
              activity: callActivity(e, 120),
            })),
            risk: rec.finding.risk,
            verification: rec.recommendation.verification,
            judged: rec.judged ?? null,
            withheld: rec.withheld ?? null,
          }),
        );
        return;
      }
      prompt?.offer(rec);
    },
  });

  // The budget, plan and Codex trackers all start from recent history, read
  // once. Seeded ids are remembered so --backfill doesn't count them twice.
  const watchesAgents = source === "all" || source === "agents";
  const limitUsd = budgetOf(args);
  const plan = planOf(args);
  const dayOpts = summaryOptions(args);
  const seed =
    limitUsd !== null || plan !== null || watchesAgents
      ? (await load({ ...args, flags: { ...args.flags, days: "46" } })).events
      : [];
  const counted = new Set(seed.map((e) => e.id));

  // Seed the budget with what the month already used, so a run starting at 83%
  // announces 95%, not 50% and 80%.
  let budget: BudgetStatus | null = null;
  let tracker: ReturnType<typeof createBudgetTracker> | null = null;
  if (limitUsd !== null) {
    budget = budgetStatus(seed, { limitUsd, timeZone: dayOpts.timeZone });
    tracker = createBudgetTracker({
      limitUsd,
      usedUsd: budget.usedUsd,
      month: budget.periodStart.slice(0, 7),
      timeZone: dayOpts.timeZone,
    });
  }

  // A Claude plan is watched per five-hour session against the learned limit.
  let planNow: ReturnType<typeof planView> | null = null;
  let sessionTracker: ReturnType<typeof createSessionTracker> | null = null;
  if (plan !== null) {
    planNow = planView(seed, [], { plan, limitHits: readLimitHits() });
    if (planNow.limit) {
      sessionTracker = createSessionTracker({
        limitUsd: planNow.limit.usd,
        current: planNow.current,
      });
    }
  }

  // ChatGPT plans need no flag: Codex writes OpenAI's meter into every call.
  let codexNow: ReturnType<typeof codexPlanView> = null;
  let codexTracker: ReturnType<typeof createCodexLimitTracker> | null = null;
  if (watchesAgents) {
    codexNow = codexPlanView(seed, []);
    const latest = seed
      .filter((e) => e.source === "codex" && e.rateLimits)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .at(-1);
    codexTracker = createCodexLimitTracker({ seed: latest?.rateLimits ?? null });
  }

  const onEvent = (event: CallEvent): void => {
    session.onEvent(event);
    if (counted.has(event.id)) return;
    counted.add(event.id);
    for (const c of codexTracker?.add(event) ?? []) {
      if (json) console.log(JSON.stringify({ codex: c }));
      else console.log(`\n${renderCodexCrossing(c)}`);
    }
    const nearing = sessionTracker?.add(event);
    if (nearing) {
      if (json) console.log(JSON.stringify({ session: nearing }));
      else console.log(`\n${renderSessionCrossing(nearing)}`);
    }
    if (!tracker) return;
    const crossed = tracker.add(event);
    if (!crossed) return;
    const daysLeft = budgetStatus([], {
      limitUsd: crossed.limitUsd,
      timeZone: dayOpts.timeZone,
    }).daysLeft;
    if (json) console.log(JSON.stringify({ budget: { ...crossed, daysLeft } }));
    else console.log(`\n${renderBudgetCrossing(crossed, daysLeft)}`);
  };

  if (!json) {
    console.log("");
    console.log(`  ${bold("optimAIzr")} ${dim("| live")}`);
    console.log("");
    if (budget) {
      const used = `${usd(budget.usedUsd)} of ${usd(budget.limitUsd)} used this month (${Math.round(budget.usedShare * 100)}%)`;
      const pace = budget.reached
        ? red("cap reached")
        : budget.exhaustsOn
          ? yellow(`at this rate the cap runs out ${monthDay(budget.exhaustsOn)}`)
          : green("on track to last the month");
      console.log(`  ${bold("budget")} ${dim(used)} ${dim("·")} ${pace}`);
    }
    if (planNow) {
      const c = planNow.current;
      const where = c
        ? `${usd(c.usd)} this session, resets ${localTime(c.end)}${
            c.limitShare === null ? "" : ` (~${Math.round(c.limitShare * 100)}% of your limit)`
          }`
        : "no session running";
      const limit = planNow.limit
        ? dim(`warns at 80% and 95% of ~${usd(planNow.limit.usd)}`)
        : dim("limit unknown: run `optimaizr limit` when you hit it");
      console.log(
        `  ${bold(PLANS[planNow.plan].label.toLowerCase())} ${dim(where)} ${dim("·")} ${limit}`,
      );
    }
    if (codexNow) {
      const windows = codexNow.windows
        .map((w) =>
          w.hasReset
            ? `${windowLabel(w.windowMinutes).toLowerCase()} 0%`
            : `${windowLabel(w.windowMinutes).toLowerCase()} ${Math.round(w.usedPercent)}%, resets ${resetTime(w.resetsAt)}`,
        )
        .join(" · ");
      console.log(
        `  ${bold(codexNow.label.toLowerCase())} ${dim(windows)} ${dim("· warns at 80% and 95%")}`,
      );
    }
    const watching: string[] = [];
    if (watchesAgents) {
      watching.push(claudeProjectsRoot());
      watching.push(codexSessionsRoot());
    }
    if (source === "all" || source === "sdk") watching.push(ledgerPath());
    for (const w of watching) console.log(`  ${dim(`watching ${w}`)}`);
    if (watchesAgents && interactive) {
      const mods = activeModSessions().length;
      console.log(
        `  ${dim(
          mods > 0
            ? `optimAIzr mod in ${mods} Claude Code session${mods === 1 ? "" : "s"}: Y switches them from the next request`
            : "Y reaches a running Claude Code session with the optimAIzr mod: optimaizr mod",
        )}`,
      );
    }
    // Overrides from earlier runs are still active, so list them up front.
    for (const o of readOverrides()) {
      console.log(`  ${dim(`override ${describeOverride(o)} · optimaizr undo ${o.rule}`)}`);
    }
    console.log(`  ${dim("Ctrl-C to stop")}`);
    console.log(
      `  ${dim(
        useJev
          ? "jev: on - route metadata only, no prompts or completions leave this machine"
          : "fully local - nothing leaves this machine",
      )}`,
    );
    console.log(`  ${dim("amounts are observed over the live window, not projected to a month")}`);
    if (interactive) {
      console.log(`  ${dim("high-confidence findings will ask; the rest are just printed")}`);
    }
    console.log("");
  }

  // Watch agent transcripts as well as the SDK ledger: the ledger is empty for
  // anyone who has never called `wrap()`, which is every Claude Code user.
  const tails: Array<{ stop: () => void; flush?: () => void }> = [];
  if (source === "all" || source === "sdk") {
    tails.push(tailLedger(onEvent, { keepAlive: true, ...(backfill > 0 ? { backfill } : {}) }));
  }
  if (watchesAgents) {
    tails.push(
      tailTranscripts(onEvent, { keepAlive: true, ...(backfill > 0 ? { backfill } : {}) }),
    );
    tails.push(tailCodex(onEvent, { keepAlive: true, ...(backfill > 0 ? { backfill } : {}) }));
  }

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const t of tails) t.stop();
      // Emit the response still in flight, so the settle delay doesn't lose it.
      for (const t of tails) t.flush?.();
      // One last pass, so a finding that was one call short of its threshold
      // when the stream ended is still reported.
      session.flush();
      // Let any prompt already on screen be answered before exiting.
      void (prompt?.drain() ?? Promise.resolve()).then(() => {
        if (!json) console.log("");
        resolve();
      });
    };
    requestExit = stop;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

export function describeOverride(o: ModelOverride): string {
  if (o.source === "claude-code") return `claude code ${describeClaudeOverride(o)}`;
  const where = `${o.project}${o.route ? `/${o.route}` : ""}`;
  return `${where}: ${modelLabel(o.from)} -> ${modelLabel(o.to)}`;
}

/**
 * `optimaizr undo <rule>`: take back a model override accepted in `live`.
 * Wrapped apps and the mod re-read overrides before every request, so it
 * applies at once.
 */
export function cmdUndo(args: Args): void {
  const rule = args.positional[0];
  const active = readOverrides();
  console.log("");

  if (!rule) {
    if (active.length === 0) {
      console.log(`  ${dim("No live overrides are active.")}`);
    } else {
      console.log(`  ${bold("Active overrides")} ${dim(overridesPath())}`);
      for (const o of active) {
        console.log(`  ${describeOverride(o)} ${dim(`· optimaizr undo ${o.rule}`)}`);
      }
    }
    console.log("");
    return;
  }

  const removed = removeOverrides(rule);
  if (removed.length === 0) {
    console.log(`  ${dim(`No live override from ${rule} is active.`)}`);
    // The Claude Code change lives in the user's own settings file.
    console.log(`  ${dim("A Claude Code change is undone in ~/.claude/settings.json.")}`);
  } else {
    for (const o of removed) console.log(`  ${green("Reverted")} ${describeOverride(o)}`);
    const who = [
      ...(removed.some((o) => o.source !== "claude-code") ? ["Wrapped apps"] : []),
      ...(removed.some((o) => o.source === "claude-code")
        ? ["Claude Code sessions running the mod"]
        : []),
    ].join(" and ");
    console.log(`  ${dim(`${who} send the original model from their next request.`)}`);
  }
  console.log("");
}
