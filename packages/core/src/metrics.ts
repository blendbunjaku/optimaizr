import type { Dataset, OptimizationFinding, Recommendation } from "./domain/types.js";
import { recoverableAnnual, recoverableMonthly } from "./analyze/rules.js";
import { summarize } from "./analyze/summary.js";

/**
 * Product metrics: how much has been analysed and found. Computed from data
 * the user already has; nothing is collected or sent. Savings found are always
 * reported next to savings acted on, so the gap stays visible.
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
  recommendationsAccepted: number;
  recommendationsRejected: number;

  /** Monthly savings attached to recommendations the user simulated. */
  simulatedSavingsUsd: number;
  /** Monthly savings on recommendations actually applied: the only money saved, not just found. */
  realisedSavingsUsd: number;

  findingsByEvidence: { measured: number; inferred: number; estimated: number };
  findingsByCategory: Record<string, number>;
}

export function computeMetrics(
  data: Dataset,
  findings: OptimizationFinding[],
  recommendations: Recommendation[],
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
    recommendationsAccepted: withStatus("applied").length,
    recommendationsRejected: withStatus("rejected").length,

    simulatedSavingsUsd: sumMonthly(withStatus("simulated")),
    realisedSavingsUsd: sumMonthly(withStatus("applied")),

    findingsByEvidence: byEvidence,
    findingsByCategory: byCategory,
  };
}
