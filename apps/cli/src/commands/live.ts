import fs from "node:fs";

import {
  accept,
  BIG_CONVERSATION,
  blue,
  bold,
  type BiggestNow,
  type BudgetStatus,
  budgetStatus,
  callActivity,
  type CallEvent,
  codexPlanView,
  COMPACT_AT,
  contextOf,
  createBudgetTracker,
  createCacheWatch,
  createContextWatch,
  createCodexLimitTracker,
  createSessionTracker,
  dim,
  endsTurn,
  green,
  LIVE_DEFAULTS,
  liveChecks,
  type LiveNextStep,
  type LiveRecommendation,
  liveStep,
  localTime,
  loadSqlite,
  modelLabel,
  monthDay,
  PLANS,
  OPENCODE_SQLITE_WARNING,
  OPENCODE_V2_WARNING,
  opencodeDbPath,
  opencodeSchema,
  planView,
  red,
  renderBudgetCrossing,
  renderCacheExpiring,
  renderCodexCrossing,
  renderColdReturn,
  renderGuardCatch,
  renderContextNotice,
  renderLiveChecks,
  renderLiveRecommendation,
  renderNextStep,
  renderSessionCrossing,
  renderTurnDone,
  rereadFloor,
  resetTime,
  turnCalls,
  usd,
  windowLabel,
  workLabel,
  workMs,
  wrap as wrapText,
  yellow,
} from "@optimaizr/core";
import {
  activeModSessions,
  applyCompaction,
  applyGuard,
  autoEligible,
  canNotify,
  type CompactAgent,
  compactionApplied,
  compactionStatus,
  undoCompaction,
  claudeModRewriter,
  claudeSettingsRewriter,
  createLiveSession,
  describeClaudeOverride,
  latestClaudeWindows,
  type ModelOverride,
  guardApplied,
  notify,
  openChanges,
  overrideEntry,
  overridesPath,
  ownCommand,
  readOverrides,
  recordChange,
  recordUndo,
  removeOverrides,
  sdkOverrideRewriter,
  statuslineApplied,
  tailReceipts,
  tailCodex,
  tailLedger,
  tailOpencode,
  tailTranscripts,
} from "@optimaizr/local";
import { Args, num } from "../args.js";
import { budgetOf, planNote, resolvePlan } from "../config.js";
import { load, readLimitHits, summaryOptions } from "../data.js";
import { createLivePrompt } from "../live-prompt.js";
import {
  createStatusLine,
  andList,
  emptyStatus,
  mostSpent,
  nameOf,
  QUORUM,
  recordCall,
  renderRunSummary,
} from "../live-status.js";
import { shareRate } from "../share.js";
import { guardOff } from "./guard.js";
import { statuslineOff } from "./statusline.js";

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

  // The line at the bottom that says it is working, and what it has seen.
  const status = emptyStatus();
  status.keys = interactive;
  const statusLine = createStatusLine(status, { enabled: !json });
  // The findings shown this run, by rule, for the next step under `?`.
  const shown = new Map<string, LiveRecommendation>();

  // --auto: a confident model or effort finding about Claude Code is applied
  // through the mod with no question. Everything else still asks.
  const auto = Boolean(args.flags.auto);
  // --notify: a system notification for what matters when nobody is watching.
  const notifyOn = Boolean(args.flags.notify) && canNotify();
  const autoRewriter = claudeModRewriter({ auto: true });
  const autoTried = new Set<string>();
  const autoApply = (rec: LiveRecommendation): boolean => {
    if (!auto || !autoEligible(rec, activeModSessions().length)) return false;
    const key = `${rec.finding.rule}::${rec.trigger.route ?? rec.trigger.model}`;
    if (autoTried.has(key)) return true;
    autoTried.add(key);
    const outcome = accept(rec.finding, {
      rewriters: [autoRewriter],
      traffic: rec.traffic,
      dryRun,
    });
    if (outcome.kind !== "applied") {
      // Say why it asks after all, so --auto never looks like it did nothing.
      const why = outcome.kind === "queued" ? outcome.reason : outcome.detail;
      if (!json) console.log(`\n  ${dim(`auto: not applied, ${why}. Asking instead.`)}`);
      return false;
    }
    if (json) {
      console.log(JSON.stringify({ auto: { rule: rec.finding.rule, detail: outcome.detail } }));
    } else {
      console.log("");
      console.log(
        `  ${yellow("⚡")} ${bold("optimAIzr")} ${dim("auto ·")} ${rec.recommendation.action}`,
      );
      for (const line of wrapText(outcome.detail, 66)) console.log(`  ${dim(line)}`);
    }
    return true;
  };

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
        onAsk: () => {
          keys.off();
          statusLine.hold();
        },
        onAnswered: () => {
          statusLine.release();
          keys.on();
        },
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
      const rule = rec.finding.rule;
      if (rec.observedUsd >= (status.found.get(rule) ?? 0)) {
        status.found.set(rule, rec.observedUsd);
        status.perCall.set(rule, rec.observedUsd / Math.max(1, rec.windowEvents));
      }
      shown.set(rule, rec);
      if (autoApply(rec)) return;
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
  const planChoice = resolvePlan(args);
  const plan = planChoice.plan;
  const dayOpts = summaryOptions(args);
  const seedData =
    limitUsd !== null || plan !== null || watchesAgents
      ? await load({ ...args, flags: { ...args.flags, days: "46" } })
      : null;
  const seed = seedData?.events ?? [];
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
    planNow = planView(seed, [], {
      plan,
      source: planChoice.source ?? undefined,
      limitHits: readLimitHits(),
      windows: latestClaudeWindows(),
    });
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

  // A line after each finished Claude Code turn: how long it worked, what it
  // cost, its own share of the 5h window, and the conversation so far.
  const showTurns = watchesAgents && !args.flags["no-turns"];
  const rate = showTurns ? shareRate(seed, { limitUsd: planNow?.limit?.usd }) : null;
  const titles = new Map(Object.entries(seedData?.titles ?? {}));
  status.titleOf = (id) => titles.get(id);
  const convos = new Map<string, CallEvent[]>();
  // The size line comes when a conversation is first seen big, then again
  // each 50K it grows, so it says something new each time it shows.
  const sizeSaid = new Map<string, number>();
  const sayNext = (id: string, next: TurnNext | undefined): TurnNext | undefined => {
    // Compacted below the line: the next time it is big counts as the first.
    if (!next) {
      sizeSaid.delete(id);
      return undefined;
    }
    const step = Math.floor(next.context / SIZE_STEP);
    const said = sizeSaid.get(id);
    sizeSaid.set(id, step);
    return said === undefined || step > said ? next : undefined;
  };
  const onTurn = (event: CallEvent): void => {
    if (!showTurns || event.source !== "claude-code") return;
    let list = convos.get(event.sessionId);
    if (!list) {
      list = seed.filter((e) => e.sessionId === event.sessionId);
      convos.set(event.sessionId, list);
    }
    list.push(event);
    if (!endsTurn(event)) return;
    const turn = turnCalls(list, event);
    const costUsd = turn.reduce((s, e) => s + e.cost.total, 0);
    if (costUsd < 0.005) return;
    const done = {
      event,
      title: titles.get(event.sessionId),
      workMs: workMs(turn),
      costUsd,
      conversation: { costUsd: list.reduce((s, e) => s + e.cost.total, 0), workMs: workMs(list) },
      usdPerPercent: rate?.usdPerPercent ?? null,
      next: nextMessage(list, event),
    };
    if (notifyOn && done.workMs >= DONE_ALERT_MS) {
      notify(
        `Claude is done: worked ${workLabel(done.workMs)}, ${usd(costUsd)}`,
        done.title ?? `Claude Code in ${projectOf(event)}`,
      );
    }
    if (json) {
      const of5h = (usd: number) => (rate ? usd / rate.usdPerPercent : null);
      console.log(
        JSON.stringify({
          turn: {
            sessionId: event.sessionId,
            title: done.title ?? null,
            workMs: done.workMs,
            costUsd,
            windowPercent: of5h(costUsd),
            conversation: { ...done.conversation, windowPercent: of5h(done.conversation.costUsd) },
            next: done.next ?? null,
          },
        }),
      );
    } else {
      console.log(`\n${renderTurnDone({ ...done, next: sayNext(event.sessionId, done.next) })}`);
    }
  };

  // A conversation that jumps, or grows past the compaction line, is said once;
  // crossing the line also offers to compact earlier from now on, once per agent.
  const watch = createContextWatch();
  const offered = new Set<CompactAgent>();
  const onContext = (event: CallEvent): void => {
    for (const n of watch.push(event)) {
      if (json) {
        console.log(
          JSON.stringify({
            context: {
              kind: n.kind,
              tokens: n.contextTokens,
              added: n.added,
              sessionId: event.sessionId,
            },
          }),
        );
        continue;
      }
      // Compaction settings are written for Claude Code and Codex only.
      if (event.source === "opencode") {
        console.log(`\n${renderContextNotice(n)}`);
        continue;
      }
      const agent = event.source as CompactAgent;
      const set = compactionStatus()[agent];
      if (n.kind !== "long" || offered.has(agent) || set !== null) {
        console.log(`\n${renderContextNotice(n)}`);
        continue;
      }
      offered.add(agent);
      const card = ["", renderContextNotice(n), "", ...compactQuestion(agent)].join("\n");
      if (!prompt || !interactive) {
        console.log(card);
        console.log(`  ${dim("Apply with:")} ${blue("optimaizr apply context-compaction")}`);
        continue;
      }
      prompt.confirm(card, () => {
        if (dryRun) return `  ${dim("Dry run: nothing was changed.")}`;
        return applyCompaction([agent])
          .map((r) => `  ${r.ok ? green("Applied") : red("Could not apply")} ${dim(r.detail)}`)
          .join("\n");
      });
    }
  };

  // Each long conversation's cache: a warning before it expires, and what
  // coming back cost once it had. Seeded quietly with the last two hours.
  const cache = createCacheWatch();
  const recentFrom = new Date(Date.now() - 2 * 3_600_000).toISOString();
  for (const e of seed.filter((x) => x.ts >= recentFrom).sort((a, b) => a.ts.localeCompare(b.ts))) {
    cache.push(e);
  }
  status.cache = cache;
  const onCache = (event: CallEvent): void => {
    const cold = cache.push(event);
    if (!cold) return;
    status.cold.count++;
    status.cold.usd += cold.rewriteUsd;
    if (notifyOn) {
      notify(
        `Cold cache: ${usd(cold.rewriteUsd)}`,
        `${titles.get(event.sessionId) ?? projectOf(event)} came back after the cache expired and wrote it again.`,
      );
    }
    if (json) {
      console.log(
        JSON.stringify({
          cache: {
            kind: "cold",
            sessionId: event.sessionId,
            gapMinutes: Math.round(cold.gapMinutes),
            ttlMinutes: cold.ttlMinutes,
            tokens: cold.rewriteTokens,
            paidUsd: cold.rewriteUsd,
            warmUsd: cold.warmUsd,
          },
        }),
      );
    } else {
      console.log(`\n${renderColdReturn(cold, titles.get(event.sessionId))}`);
    }
  };
  const expiryTimer = setInterval(() => {
    const now = Date.now();
    for (const s of cache.expiring(now)) {
      if (json) {
        console.log(
          JSON.stringify({
            cache: {
              kind: "expiring",
              sessionId: s.event.sessionId,
              tokens: s.context,
              expiresAt: new Date(s.expiresAt ?? now).toISOString(),
              againUsd: s.rewriteUsd,
              readUsd: s.readUsd,
            },
          }),
        );
      } else {
        console.log(`\n${renderCacheExpiring(s, now, titles.get(s.event.sessionId))}`);
      }
      if (notifyOn) {
        const left = Math.max(1, Math.round(((s.expiresAt ?? now) - now) / 60_000));
        notify(
          `Cache expires in ${left} min`,
          `${titles.get(s.event.sessionId) ?? projectOf(s.event)}: coming back after that costs ${usd(s.rewriteUsd)}.`,
        );
      }
    }
  }, 15_000);
  expiryTimer.unref();

  // What guard holds in Claude Code, from its log, as it happens.
  const guardLog = watchesAgents ? tailReceipts() : null;
  const guardTimer = setInterval(() => {
    for (const r of guardLog?.poll() ?? []) {
      if (json) console.log(JSON.stringify({ guard: r }));
      else console.log(`\n${renderGuardCatch(r, { title: (id) => titles.get(id) })}`);
    }
  }, 3_000);
  guardTimer.unref();

  // What every check saw over the rules' window, and a step for each finding.
  // The last hour from before the run counts too, so `?` has an answer at once.
  const checksNow = (): string => {
    const set = compactionStatus();
    const at = (v: string | null) => (v && Number(v) > 0 ? Number(v) : null);
    const window = session.window();
    const inWindow = new Set(window.map((e) => e.id));
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const before = seed.filter((e) => e.ts >= hourAgo && !inWindow.has(e.id));
    const checks = liveChecks([...before, ...window], {
      minUsd: num(args.flags["min-usd"], LIVE_DEFAULTS.minUsd),
      compactAt: { "claude-code": at(set["claude-code"]), codex: at(set.codex) },
      warm: cache.warm(Date.now()),
      cold: status.cold,
      shown: {
        count: status.found.size,
        usd: [...status.found.values()].reduce((t, v) => t + v, 0),
      },
    });
    return renderLiveChecks(checks, { steps: stepsNow().slice(0, 2), keys: interactive });
  };

  // The findings shown this run, biggest first, each with its step. What is
  // set already is read each time, so a step `a` just made is not offered again.
  const stepsNow = (): LiveNextStep[] => {
    const set = compactionStatus();
    const ctx = {
      guard: guardApplied(),
      compacts: { "claude-code": set["claude-code"] !== null, codex: set.codex !== null },
    };
    return [...shown.values()]
      .sort((a, b) => b.observedUsd - a.observedUsd)
      .map((rec) => ({
        rule: rec.finding.rule,
        paidUsd: rec.observedUsd,
        calls: rec.windowEvents,
        spanMs: rec.windowMs,
        step: liveStep(rec.finding, rec.traffic, ctx),
      }));
  };

  // The conversation that cost this run the most, for `n` when nothing was found.
  const biggestNow = (): BiggestNow | null => {
    const top = mostSpent(status);
    if (!top) return null;
    const { id, convo } = top;
    const list = convos.get(id);
    const last = list?.filter((e) => !e.isSubagent).at(-1);
    const next = list && last ? nextMessage(list, last) : undefined;
    return {
      sessionId: id,
      name: nameOf(status, id, convo),
      source: convo.source,
      usd: convo.runUsd,
      runUsd: status.spendUsd,
      context: convo.context,
      perMessageUsd: next ? next.floorUsd * (next.callsPerMessage ?? 1) : null,
    };
  };

  // `a`: make the setting the top step names, after a yes. Anything else is
  // something to do, not to set, and `a` says so.
  const applyStep = (): void => {
    const s = stepsNow().find((x) => x.step.apply);
    if (!s) {
      console.log(
        `\n  ${dim(shown.size > 0 ? "No setting to make for these; n shows what to do instead." : "Nothing to apply yet; n shows a step once a finding comes up.")}`,
      );
      return;
    }
    if (!prompt) {
      const cmd =
        s.step.apply === "guard" ? "optimaizr guard on" : "optimaizr apply context-compaction";
      console.log(`\n  ${dim("Apply with:")} ${blue(cmd)}`);
      return;
    }
    if (s.step.apply === "guard") {
      prompt.confirm(guardQuestion(), () => {
        if (dryRun) return `  ${dim("Dry run: nothing was changed.")}`;
        const r = applyGuard(ownCommand("guard hook"));
        const tag = !r.ok ? red("Not applied") : r.changed ? green("Applied") : green("Already on");
        return `  ${tag} ${dim(r.detail)}`;
      });
      return;
    }
    const agent = s.step.agent === "codex" ? "codex" : "claude-code";
    prompt.confirm(["", ...compactQuestion(agent)].join("\n"), () => {
      if (dryRun) return `  ${dim("Dry run: nothing was changed.")}`;
      return applyCompaction([agent])
        .map((r) => `  ${r.ok ? green("Applied") : red("Could not apply")} ${dim(r.detail)}`)
        .join("\n");
    });
  };

  // Between questions `?` prints the checks, `n` the next step and `a` makes
  // its setting. Raw mode, so Ctrl-C arrives here as a key and is passed on.
  const onKey = (buf: Buffer): void => {
    const key = buf.toString("utf8");
    if (key === "\u0003" || key === "\u0004") return requestExit();
    if (key === "?" || key === "/") console.log(`\n${checksNow()}`);
    if (key === "n" || key === "N") {
      const top = stepsNow()[0] ?? null;
      console.log(`\n${renderNextStep(top, { keys: true, biggest: top ? null : biggestNow() })}`);
    }
    if (key === "a" || key === "A") applyStep();
  };
  let listening = false;
  const keys = {
    on(): void {
      if (!interactive || listening) return;
      listening = true;
      try {
        process.stdin.setRawMode?.(true);
      } catch {
        /* not a tty after all */
      }
      process.stdin.on("data", onKey);
      process.stdin.resume();
    },
    off(): void {
      if (!listening) return;
      listening = false;
      process.stdin.off("data", onKey);
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
    },
  };

  const onEvent = (event: CallEvent): void => {
    session.onEvent(event);
    if (counted.has(event.id)) return;
    counted.add(event.id);
    recordCall(status, event);
    // Once there is enough to judge, say once what was checked, found or not.
    if (status.calls === QUORUM && !json) console.log(`\n${checksNow()}`);
    onTurn(event);
    onContext(event);
    onCache(event);
    statusLine.update();
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

  // The opencode tail opens its database once it appears, so opencode is
  // watched wherever SQLite can read it, history here or not.
  const opencodeFile = opencodeDbPath();
  const sqlite = watchesAgents ? await loadSqlite() : null;
  const watchesOpencode = sqlite !== null;
  if (watchesAgents && fs.existsSync(opencodeFile)) {
    let v2 = false;
    if (sqlite) {
      try {
        const db = new sqlite.DatabaseSync(opencodeFile, { readOnly: true });
        try {
          v2 = opencodeSchema(db).v2;
        } finally {
          db.close();
        }
      } catch {
        /* the tail retries a database it can't open yet */
      }
    }
    const note = !sqlite ? OPENCODE_SQLITE_WARNING : v2 ? OPENCODE_V2_WARNING : null;
    if (note) (json ? console.error : console.log)(`  ${dim(note)}`);
  }

  const watched = [
    ...(watchesAgents ? ["Claude Code", "Codex", ...(watchesOpencode ? ["opencode"] : [])] : []),
    ...(source === "all" || source === "sdk" ? ["API calls made through optimAIzr"] : []),
  ];
  status.watched = watched;

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
        ? `${usd(c.usd)} this 5h window, resets ${localTime(c.end)}${
            c.limitShare === null ? "" : ` (~${Math.round(c.limitShare * 100)}% of your limit)`
          }`
        : "no 5h window open";
      const five = planNow.windows?.fiveHour;
      const week = planNow.windows?.sevenDay;
      const limit = five
        ? dim(
            `5h ${Math.round(five.percentUsed)}%${five.resetsAt ? `, resets ${resetTime(five.resetsAt)}` : ""}${week ? ` · weekly ${Math.round(week.percentUsed)}%` : ""} (Claude Code's meter)`,
          )
        : planNow.limit
          ? dim(`warns at 80% and 95% of ~${usd(planNow.limit.usd)}`)
          : rate?.basis === "meter"
            ? dim(
                `~${Math.round((c?.usd ?? 0) / rate.usdPerPercent)}% of a full window (~${usd(rate.usdPerPercent * 100)}, learned from the meter)`,
              )
            : statuslineApplied()
              ? dim("limit unknown until the status line sees Claude Code's meter")
              : dim("limit unknown: optimaizr statusline on reads it from Claude Code");
      const detected = planNow.source === "detected" ? dim(" (detected)") : "";
      console.log(
        `  ${bold(PLANS[planNow.plan].label.toLowerCase())}${detected} ${dim(where)} ${dim("·")} ${limit}`,
      );
    } else if (watchesAgents) {
      for (const line of planNote(planChoice, seed) ?? []) {
        console.log(`  ${line}`);
      }
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
    // What is watched, and how to read what comes: a legend, not a manual.
    const privacy = useJev
      ? "Jev gets route metadata only, never prompts or replies."
      : "Nothing leaves it.";
    console.log(`  Watching ${andList(watched)} on this machine. ${dim(privacy)}`);
    if (showTurns) {
      const share = !rate
        ? ""
        : `, and its share of your 5h limit (${usd(rate.usdPerPercent)} per 1%, ${
            rate.basis === "meter"
              ? `learned from ${rate.windows} windows`
              : "from your plan's estimated limit"
          })`;
      console.log(
        `  ${dim(`Each finished turn shows below: how long Claude worked, what it cost${share}.`)}`,
      );
    }
    const asks = interactive ? " (the clear ones ask Y/N)" : "";
    console.log(
      `  ${yellow("⚠")} ${dim(`worth a look${asks} ·`)} ${yellow("⏸")} ${dim("guard stepped in ·")} ${yellow("⏳")} ${dim("a cache about to expire")}`,
    );
    if (process.stdout.isTTY) {
      console.log(
        `  ${dim("At the bottom: each open conversation, working or idle, and how long its cache stays warm.")}`,
      );
    }
    if (watchesAgents) {
      console.log(
        `  ${dim(
          guardApplied()
            ? "Guard is on: what it holds in Claude Code shows here."
            : "Guard is off: optimaizr guard on holds a message to an expired cache before it is paid.",
        )}`,
      );
    }
    if (notifyOn) {
      console.log(
        `  ${dim("Notifications: a cache about to expire, a cold return, and a turn done after 45s or more.")}`,
      );
    } else if (args.flags.notify) {
      console.log(
        `  ${dim("Notifications are not available here; they need macOS, or notify-send on Linux.")}`,
      );
    }
    const mods = watchesAgents ? activeModSessions().length : 0;
    if (watchesAgents && auto) {
      console.log(
        `  ${dim("auto: confident model and effort switches apply to Claude Code sessions running the mod, no question; p or /optimaizr off undoes")}`,
      );
    } else if (interactive && mods > 0) {
      console.log(
        `  ${dim(`optimAIzr mod in ${mods} Claude Code session${mods === 1 ? "" : "s"}: Y switches them from the next request`)}`,
      );
    }
    // Overrides from earlier runs are still active, so list them up front.
    for (const o of readOverrides()) {
      console.log(`  ${dim(`override ${describeOverride(o)} · optimaizr undo ${o.rule}`)}`);
    }
    console.log(
      `  ${dim(interactive ? "Keys: ? what was checked · n next step · a apply it · Ctrl-C stop" : "Ctrl-C to stop")}`,
    );
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
      tailTranscripts(onEvent, {
        keepAlive: true,
        ...(backfill > 0 ? { backfill } : {}),
        onTitle: (id, title) => titles.set(id, title),
      }),
    );
    tails.push(tailCodex(onEvent, { keepAlive: true, ...(backfill > 0 ? { backfill } : {}) }));
    tails.push(
      tailOpencode(onEvent, {
        keepAlive: true,
        ...(backfill > 0 ? { backfill } : {}),
        onTitle: (id, title) => titles.set(id, title),
      }),
    );
  }

  const detach = statusLine.attach();
  keys.on();
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      keys.off();
      clearInterval(expiryTimer);
      clearInterval(guardTimer);
      for (const t of tails) t.stop();
      // Emit the response still in flight, so the settle delay doesn't lose it.
      for (const t of tails) t.flush?.();
      // One last pass, so a finding that was one call short of its threshold
      // when the stream ended is still reported.
      session.flush();
      // Let any prompt already on screen be answered before exiting.
      void (prompt?.drain() ?? Promise.resolve()).then(() => {
        statusLine.stop();
        detach();
        if (!json) {
          console.log("");
          console.log(renderRunSummary(status));
          if (status.calls > 0) console.log(checksNow());
          console.log("");
        }
        resolve();
      });
    };
    requestExit = stop;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** A turn this long gets a notification with --notify: long enough to have looked away. */
const DONE_ALERT_MS = 45_000;

/** The size line under a turn comes back each time a conversation grows this much. */
const SIZE_STEP = 50_000;

const projectOf = (e: CallEvent) => e.project.split(/[\\/]/).pop() || e.project;

/**
 * In a big conversation, what the next message pays before any work: one call
 * re-reading it, and the usual number of calls a message takes here.
 */
function nextMessage(conversation: readonly CallEvent[], last: CallEvent): TurnNext | undefined {
  const floor = rereadFloor(last);
  const context = contextOf(last);
  if (floor === null || context < BIG_CONVERSATION) return undefined;
  const main = conversation.filter((e) => !e.isSubagent);
  const turns = main.filter(endsTurn).length;
  return { context, floorUsd: floor, callsPerMessage: turns >= 2 ? main.length / turns : null };
}
type TurnNext = { context: number; floorUsd: number; callsPerMessage: number | null };

function compactQuestion(agent: CompactAgent): string[] {
  const name = agent === "claude-code" ? "Claude Code" : "Codex";
  return [
    `  ${bold(`Compact ${name} conversations at ${Math.round(COMPACT_AT / 1000)}K from now on?`)}`,
    `  ${dim(
      agent === "claude-code"
        ? `Sets CLAUDE_CODE_AUTO_COMPACT_WINDOW in ~/.claude/settings.json, from the next session.`
        : `Sets model_auto_compact_token_limit in ~/.codex/config.toml, from the next session.`,
    )}`,
    `  ${dim("A summary can drop early details. Undo any time: optimaizr undo context-compaction")}`,
  ];
}

function guardQuestion(): string {
  return [
    "",
    `  ${bold("Turn guard on?")}`,
    `  ${dim("Sets optimAIzr's hooks in ~/.claude/settings.json, next to your own; new Claude Code")}`,
    `  ${dim("conversations pick them up. It holds a message to an expired cache, a whole big file")}`,
    `  ${dim("read and a retry of a failing command, once each. Undo any time: optimaizr guard off")}`,
  ].join("\n");
}

export function describeOverride(o: ModelOverride): string {
  if (o.source === "claude-code") return `claude code ${describeClaudeOverride(o)}`;
  const where = `${o.project}${o.route ? `/${o.route}` : ""}`;
  return `${where}: ${modelLabel(o.from)} -> ${modelLabel(o.to)}`;
}

/**
 * A change made by hand is put back by hand; optimAIzr only notes when, so
 * `results` stops counting it. False when there was none to note.
 */
function recordByHandUndo(rule: string): boolean {
  if (!openChanges(rule).some((c) => c.how === "by-hand")) return false;
  recordChange({ kind: "undo", rule, at: new Date().toISOString() });
  console.log(
    `  ${green("Recorded")} ${dim(`${rule} as undone today, so results stop counting it here.`)}`,
  );
  console.log(`  ${dim("Put the change itself back the way you made it.")}`);
  return true;
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

  if (rule === "context-compaction") {
    const results = undoCompaction();
    if (results.length === 0 && !recordByHandUndo(rule))
      console.log(`  ${dim("optimAIzr has not changed when anything compacts.")}`);
    for (const r of results) {
      console.log(`  ${r.ok ? green("Reverted") : red("Could not revert")} ${r.detail}`);
    }
    console.log("");
    return;
  }

  if (rule === "statusline") return statuslineOff();
  if (rule === "guard") return guardOff();

  if (!rule) {
    if (statuslineApplied()) {
      console.log(
        `  Claude Code shows the optimAIzr status line ${dim("· optimaizr statusline off")}`,
      );
    }
    if (guardApplied()) {
      console.log(`  Guard's hooks are set in Claude Code ${dim("· optimaizr guard off")}`);
    }
    const set = compactionStatus();
    for (const agent of compactionApplied()) {
      const name = agent === "claude-code" ? "Claude Code" : "Codex";
      // What the file says now, which `--at` may have moved off the default.
      const tokens = Number(set[agent] ?? COMPACT_AT) || COMPACT_AT;
      console.log(
        `  ${name} is set to compact at ${Math.round(tokens / 1000)}K ${dim("· optimaizr undo context-compaction")}`,
      );
    }
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
  if (removed.length > 0) recordUndo(rule, removed.map(overrideEntry));
  if (removed.length === 0) {
    if (!recordByHandUndo(rule)) {
      console.log(`  ${dim(`No live override from ${rule} is active.`)}`);
      // The Claude Code change lives in the user's own settings file.
      console.log(`  ${dim("A Claude Code change is undone in ~/.claude/settings.json.")}`);
    }
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
