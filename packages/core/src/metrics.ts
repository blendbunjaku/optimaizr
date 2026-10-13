import type { Dataset, OptimizationFinding, Recommendation } from "./domain/types.js";
import type { AppliedChange, ChangeResult } from "./analyze/results.js";
import { recoverableAnnual, recoverableMonthly } from "./analyze/rules.js";
import { summarize } from "./analyze/summary.js";

/**
 * Product metrics: how much has been analysed and found. Computed from data
 * the user already has; nothing is collected or sent. Savings found are always
 * reported next to savings measured, so the gap stays visible.
 */

export interface ProductMetrics {
  /** Distinct projects seen. Stands in for connected organisations locally. */
  projects: number;
  providers: number;
  models: number;

  analyzedRequests: number;
  analyzedTokens: number;
  analyzedSpendUsd: number;

  /** The core product metric: savings identified across all findings. */
  totalPotentialSavingsMonthlyUsd: number;
  totalPotentialSavingsAnnualUsd: number;
  /** Share of analysed spend that was identified as recoverable. */
  identifiedSavingsRate: number;

  recommendations: number;
  recommendationsViewed: number;
  recommendationsSimulated: number;
  recommendationsVerified: number;
  /** Recommendations with a change in place for their rule, from the change journal. */
  recommendationsAccepted: number;
  recommendationsRejected: number;

  /** Changes made by optimAIzr or recorded by hand that are still in place. */
  changesInPlace: number;
  /** Changes with enough days before and after them to measure. */
  changesMeasured: number;

  /** Monthly savings attached to recommendations the user simulated. */
  simulatedSavingsUsd: number;
  /**
   * Saved since each change went in, before against after at the measured rate.
   * A total, not monthly, and negative when the changes cost more.
   */
  realisedSavingsUsd: number;

  findingsByEvidence: { measured: number; inferred: number; estimated: number };
  findingsByCategory: Record<string, number>;
}

export function computeMetrics(
  data: Dataset,
  findings: OptimizationFinding[],
  recommendations: Recommendation[],
  applied: { changes: readonly AppliedChange[]; results: readonly ChangeResult[] } = {
    changes: [],
    results: [],
  },
): ProductMetrics {
  const summary = summarize(data);
  const byEvidence = { measured: 0, inferred: 0, estimated: 0 };
  const byCategory: Record<string, number> = {};
  for (const f of findings) {
    byEvidence[f.savings.evidence.kind]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }

  const withStatus = (s: Recommendation["status"]) => recommendations.filter((r) => r.status === s);
  const sumMonthly = (rs: Recommendation[]) => rs.reduce((t, r) => t + r.savings.monthlyUsd, 0);

  const monthly = recoverableMonthly(findings);
  const inPlace = applied.changes.filter((c) => !c.until);
  const measured = applied.results.filter((r) => r.measuredSavingUsd !== null);

  return {
    projects: summary.byProject.length,
    providers: summary.byProvider.length,
    models: summary.byModel.length,

    analyzedRequests: summary.calls,
    analyzedTokens: summary.totalTokens,
    analyzedSpendUsd: summary.totalCost,

    totalPotentialSavingsMonthlyUsd: monthly,
    totalPotentialSavingsAnnualUsd: recoverableAnnual(findings),
    identifiedSavingsRate: summary.perMonth > 0 ? monthly / summary.perMonth : 0,

    recommendations: recommendations.length,
    recommendationsViewed: recommendations.filter((r) => r.status !== "new").length,
    recommendationsSimulated: withStatus("simulated").length,
    recommendationsVerified: withStatus("verified").length,
    recommendationsAccepted: recommendations.filter((r) => inPlace.some((c) => c.rule === r.rule))
      .length,
    recommendationsRejected: withStatus("rejected").length,

    changesInPlace: inPlace.length,
    changesMeasured: measured.length,

    simulatedSavingsUsd: sumMonthly(withStatus("simulated")),
    realisedSavingsUsd: measured.reduce((t, r) => t + (r.measuredSavingUsd ?? 0), 0),

    findingsByEvidence: byEvidence,
    findingsByCategory: byCategory,
  };
}
