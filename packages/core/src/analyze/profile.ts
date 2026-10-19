import {
  COMPACT_AT,
  likelyMonthly,
  recoverableAnnual,
  recoverableMonthly,
  recoverableWindow,
  savingsOverlap,
} from "./rules.js";
import { budgetStatus, type BudgetOptions, type BudgetStatus } from "./budget.js";
import { sessionStats, type SessionStats } from "./sessions.js";
import { planView, type PlanView } from "./plan.js";
import { buildTasks, contextOf } from "./tasks.js";
import { priceFor } from "../pricing.js";
import { codexPlanView, type CodexPlanView } from "./codex-plan.js";
import { coveredRules, type AppliedChange, type ChangeResult } from "./results.js";
import { toRecommendations } from "../recommend/recommendations.js";
import type { Dataset, OptimizationFinding, Recommendation, UsageEvent } from "../domain/types.js";
import type { Summary } from "./summary.js";

/**
 * `optimaizr profile`: a one-screen snapshot of usage and the biggest lever.
 * No new calculations, only figures from `summarize`, the de-overlapped savings
 * and `toRecommendations`, so it can't disagree with the commands it points to.
 */
export interface Profile {
  window: Summary["window"];
  windowDays: Summary["windowDays"];

  spendUsd: number;
  perMonthUsd: number;
  pace: Summary["pace"];
  calls: number;
  tokens: { input: number; output: number; total: number };

  /** Calls a `fix` finding counted: clear waste. Advisories excluded. */
  flaggedCalls: number;
  flaggedShare: number;
  /** Clear waste observed in the window, each call counted once. The headline. */
  wasteWindowUsd: number;
  savingsMonthlyUsd: number;
  savingsAnnualUsd: number;
  /** What `try` findings would likely save on top, each call counted once. */
  likelyMonthlyUsd: number;
  /** True when the listed opportunities add up to more than the headline. */
  overlapping: boolean;

  /** Up to three `fix` then two `try` recommendations, clear waste first. */
  opportunities: Recommendation[];
  /** The first of them, or null when nothing recoverable was found. */
  bottleneck: Recommendation | null;
  /** `test` levers, each an "up to" on its own. Never added to anything. */
  levers: Recommendation[];
  /** The single largest opportunity in any tier, for the top of the screen. */
  biggestWin: BiggestWin | null;
  /** The measured facts behind the savings, each linked to the finding that saves on it. */
  habits: Habit[];
  /** What the spend went on, as shares of it. */
  breakdown: SpendBreakdown;
  /** The command to run next to investigate the bottleneck. */
  nextCommand: string;
  /** What the sessions look like, measured: see `optimaizr sessions`. */
  sessions: SessionStats;

  /** Present when a monthly cap was given. */
  budget: BudgetStatus | null;
  /** Present when a Claude subscription was named. */
  plan: PlanView | null;
  /** Present when Codex reported a ChatGPT plan's meter in the last 30 days. */
  codex: CodexPlanView | null;

  /** How each change still in place is going, newest first. */
  applied: ChangeResult[];
  /** Rules those changes cover, left out of every figure above. */
  appliedRules: string[];
  /** Before anything was applied: one fact from your own logs and where to start. */
  firstLook: FirstLook | null;
}

export interface FirstLook {
  fact: string;
  command: string;
  why: string;
}

export interface BiggestWin {
  recommendation: Recommendation;
  /** Its monthly figure as a share of monthly spend. */
  share: number;
  /**
   * On a plan, how much more work the same window holds once it's done:
   * cutting a share s of usage leaves room for 1 / (1 - s) as much.
   */
  moreWork: number;
}

export interface Habit {
  key: "waste" | "context" | "model-fit";
  label: string;
  /** The one measured share behind it. */
  share: number;
  /** That share in words, e.g. "48% of calls carry over 200K of conversation". */
  note: string;
  /** The finding that saves money on it, when there is one. */
  rule?: string;
}

function pctOf(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * The measured facts behind the savings: the clear-waste share, the share of
 * agent calls carrying over COMPACT_AT, and the share of frontier-model spend
 * on finished tasks without heavy reasoning. Facts, not grades: there is no
 * population to rank anyone against.
 */
function habitsOf(
  events: UsageEvent[],
  wasteShare: number,
  bottleneck: Recommendation | null,
): Habit[] {
  const habits: Habit[] = [
    {
      key: "waste",
      label: "Clear waste",
      share: wasteShare,
      note:
        wasteShare < 0.005
          ? "almost none of your usage is clear waste"
          : `${pctOf(wasteShare)} of your usage is clear waste`,
      ...(bottleneck ? { rule: bottleneck.rule } : {}),
    },
  ];

  // The agents with enough calls to judge, the same rule the compaction lever uses,
  // so its "48% of calls" and this one always agree.
  const enough = (["claude-code", "codex"] as const).filter(
    (a) => events.filter((e) => e.source === a).length >= 50,
  );
  const agent = events.filter((e) => enough.some((a) => a === e.source));
  const pool = agent.length > 0 ? agent : events;
  if (pool.length > 0) {
    const long = pool.filter((e) => contextOf(e) > COMPACT_AT).length / pool.length;
    habits.push({
      key: "context",
      label: "Long conversations",
      share: long,
      note: `${pctOf(long)} of calls carry over ${Math.round(COMPACT_AT / 1000)}K of conversation`,
      rule: "context-compaction",
    });
  }

  const frontier = buildTasks(events).filter((t) => priceFor(t.model)?.tier === "frontier");
  const spend = frontier.reduce((s, t) => s + t.costUsd, 0);
  if (spend > 0) {
    const light = frontier
      .filter((t) => t.done && t.kind !== "reasoning" && t.kind !== "debugging")
      .reduce((s, t) => s + t.costUsd, 0);
    const bySpend = new Map<string, number>();
    for (const t of frontier) bySpend.set(t.model, (bySpend.get(t.model) ?? 0) + t.costUsd);
    const top = [...bySpend]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 1)
      .map(([m]) => priceFor(m)?.label ?? m)
      .join("");
    habits.push({
      key: "model-fit",
      label: "Light work on big models",
      share: light / spend,
      note: `${pctOf(light / spend)} of ${top} spend is light work`,
      rule: "model-default",
    });
  }
  return habits;
}

export interface SpendBreakdown {
  /** Re-reading context already in the cache: the conversation so far. */
  reread: number;
  /** Output: answers, code and thinking. */
  output: number;
  /** Writing context into the cache. */
  cacheWrite: number;
  /** Fresh input. */
  input: number;
  /** Per-request tools such as web search. */
  tools: number;
}

export function buildProfile(
  data: Dataset,
  summary: Summary,
  found: OptimizationFinding[],
  /**
   * A monthly cap to project against. `events` overrides the dataset when the
   * caller filtered it to fewer days than the month needs (`--days 7`).
   */
  budget?: Omit<BudgetOptions, "savingsShare"> & { events?: UsageEvent[] },
  plan?: Parameters<typeof planView>[2],
  /** Changes you made, so what they cover stops being suggested. */
  applied?: { changes: readonly AppliedChange[]; results: readonly ChangeResult[] },
): Profile {
  const changes = applied?.changes ?? [];
  const covered = coveredRules(found, data.events, changes);
  // The window still holds the days before the change, so its finding would
  // keep suggesting the change you already made.
  const findings = found.filter((f) => !covered.has(f.rule));
  const waste = findings.filter((f) => !f.advisory && f.tier === "fix");
  const c = summary.cost;
  const of = (n: number) => (c.total > 0 ? n / c.total : 0);
  const flaggedCalls = data.events.filter((e) => waste.some((f) => f.affects(e))).length;
  const recs = toRecommendations(findings, data.events.length);
  const actionable = recs.filter((r) => r.tier !== "test");
  const bottleneck = actionable[0] ?? null;
  const share = (usd: number) => (summary.perMonth > 0 ? usd / summary.perMonth : 0);
  const biggestWin = biggestOf(recs, share);
  // The screen leads with the biggest win, so the next step follows it.
  const next = biggestWin?.recommendation ?? bottleneck;
  // A coding agent's calls have no request to replay, so `apply` prints the
  // steps for them; `simulate` is for SDK traffic.
  const nextFinding = next ? findings.find((f) => f.rule === next.id) : undefined;
  const byAgent = nextFinding
    ? data.events
        .filter(nextFinding.affects)
        .every((e) => e.source === "claude-code" || e.source === "codex" || e.source === "opencode")
    : false;
  // With no recommendation, the drill-down is the most useful place to look.
  // Compaction writes the agents' settings, so its step is the preview.
  const nextCommand = !next
    ? "optimaizr why"
    : !byAgent
      ? `optimaizr simulate ${next.id}`
      : next.id === "context-compaction"
        ? "optimaizr apply context-compaction --dry-run"
        : `optimaizr apply ${next.id}`;
  const savingsMonthlyUsd = recoverableMonthly(findings);
  const breakdown: SpendBreakdown = {
    reread: of(c.cacheRead),
    output: of(c.output),
    cacheWrite: of(c.cacheWrite),
    input: of(c.input),
    tools: of(c.serverTools),
  };
  const sessions = sessionStats(data);

  return {
    window: summary.window,
    windowDays: summary.windowDays,
    spendUsd: summary.totalCost,
    perMonthUsd: summary.perMonth,
    pace: summary.pace,
    calls: summary.calls,
    tokens: {
      // Same "in" side renderSummary reports: fresh, cached and cache writes.
      input: summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens,
      output: summary.outputTokens,
      total: summary.totalTokens,
    },
    flaggedCalls,
    flaggedShare: summary.calls > 0 ? flaggedCalls / summary.calls : 0,
    wasteWindowUsd: recoverableWindow(findings),
    savingsMonthlyUsd,
    savingsAnnualUsd: recoverableAnnual(findings),
    likelyMonthlyUsd: likelyMonthly(findings),
    overlapping: savingsOverlap(findings).removedWindowUsd > 0,
    opportunities: [
      ...actionable.filter((r) => r.tier === "fix").slice(0, 3),
      ...actionable.filter((r) => r.tier === "try").slice(0, 2),
    ],
    bottleneck,
    levers: recs.filter((r) => r.tier === "test"),
    biggestWin,
    habits: habitsOf(data.events, share(savingsMonthlyUsd), bottleneck),
    breakdown,
    nextCommand,
    sessions,
    budget: budget
      ? budgetStatus(budget.events ?? data.events, {
          ...budget,
          savingsShare: summary.perMonth > 0 ? savingsMonthlyUsd / summary.perMonth : 0,
        })
      : null,
    plan: plan ? planView(data.events, findings, plan) : null,
    codex: codexPlanView(data.events, findings, { now: plan?.now }),
    applied: (applied?.results ?? []).filter((r) => !r.change.until),
    appliedRules: [...covered],
    firstLook: changes.length === 0 ? firstLookOf(breakdown, sessions, recs, biggestWin) : null,
  };
}

/**
 * The fact most people don't expect, tied to what fixes it: coming back to a
 * cold cache when that is the biggest win, else how much is re-reading.
 */
function firstLookOf(
  b: SpendBreakdown,
  sessions: SessionStats,
  recs: Recommendation[],
  win: BiggestWin | null,
): FirstLook | null {
  const cold = sessions.coldResumes;
  const times = cold.warmUsd > 0 ? cold.costUsd / cold.warmUsd : 0;
  if (win?.recommendation.rule === "cold-resume" && cold.count >= 5 && times >= 2) {
    return {
      fact: `${cold.count} times you came back to a conversation after its cache expired, and loading it again cost ${Math.round(times)}x what a warm return does.`,
      command: "optimaizr apply cold-resume",
      why: "what to do about it",
    };
  }
  if (b.reread < 0.3) return null;
  const answers = b.output >= 0.01 ? `; the answers themselves were ${pctOf(b.output)}` : "";
  const fact = `${pctOf(b.reread)} of your spend went on re-reading the conversation so far${answers}.`;
  if (recs.some((r) => r.rule === "context-compaction")) {
    return {
      fact,
      command: "optimaizr apply context-compaction",
      why: "compact sooner, so there is less to re-read",
    };
  }
  if (win) {
    return { fact, command: `optimaizr apply ${win.recommendation.rule}`, why: "the biggest win" };
  }
  return { fact, command: "optimaizr sessions", why: "where in a conversation it happens" };
}

/** The largest opportunity of any tier; clear waste wins a tie. */
function biggestOf(recs: Recommendation[], share: (usd: number) => number): BiggestWin | null {
  let best: Recommendation | null = null;
  for (const r of recs) {
    if (!best || r.savings.monthlyUsd > best.savings.monthlyUsd) best = r;
  }
  if (!best || best.savings.monthlyUsd <= 0) return null;
  const s = Math.min(0.95, share(best.savings.monthlyUsd));
  return { recommendation: best, share: s, moreWork: 1 / (1 - s) };
}
