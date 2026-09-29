import {
  recoverableAnnual,
  recoverableMonthly,
  recoverableWindow,
  savingsOverlap,
} from "./rules.js";
import { budgetStatus, type BudgetOptions, type BudgetStatus } from "./budget.js";
import { planView, type PlanId, type PlanView } from "./plan.js";
import { codexPlanView, type CodexPlanView } from "./codex-plan.js";
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

  /** Calls at least one recoverable finding counted. Advisories excluded. */
  flaggedCalls: number;
  flaggedShare: number;
  /** Recoverable spend observed in the window, each call counted once. */
  wasteWindowUsd: number;
  savingsMonthlyUsd: number;
  savingsAnnualUsd: number;
  /** True when the listed opportunities add up to more than the headline. */
  overlapping: boolean;

  /** Up to three, largest monthly saving first. */
  opportunities: Recommendation[];
  /** The largest opportunity, or null when nothing recoverable was found. */
  bottleneck: Recommendation | null;
  /** The command to run next to investigate the bottleneck. */
  nextCommand: string;

  /** Present when a monthly cap was given. */
  budget: BudgetStatus | null;
  /** Present when a Claude subscription was named. */
  plan: PlanView | null;
  /** Present when Codex reported a ChatGPT plan's meter in the last 30 days. */
  codex: CodexPlanView | null;
}

export function buildProfile(
  data: Dataset,
  summary: Summary,
  findings: OptimizationFinding[],
  /**
   * A monthly cap to project against. `events` overrides the dataset when the
   * caller filtered it to fewer days than the month needs (`--days 7`).
   */
  budget?: Omit<BudgetOptions, "savingsShare"> & { events?: UsageEvent[] },
  plan?: { plan: PlanId; limitHits?: string[]; now?: Date },
): Profile {
  const recoverable = findings.filter((f) => !f.advisory);
  const flaggedCalls = data.events.filter((e) => recoverable.some((f) => f.affects(e))).length;
  const recs = toRecommendations(findings, data.events.length);
  const bottleneck = recs[0] ?? null;
  const savingsMonthlyUsd = recoverableMonthly(findings);

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
    overlapping: savingsOverlap(findings).removedWindowUsd > 0,
    opportunities: recs.slice(0, 3),
    bottleneck,
    // Every recommendation can be simulated; with none, the drill-down is the
    // most useful place to look instead.
    nextCommand: bottleneck ? `optimaizr simulate ${bottleneck.id}` : "optimaizr why",
    budget: budget
      ? budgetStatus(budget.events ?? data.events, {
          ...budget,
          savingsShare: summary.perMonth > 0 ? savingsMonthlyUsd / summary.perMonth : 0,
        })
      : null,
    plan: plan ? planView(data.events, findings, plan) : null,
    codex: codexPlanView(data.events, findings, { now: plan?.now }),
  };
}
