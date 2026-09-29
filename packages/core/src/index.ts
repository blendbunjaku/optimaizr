/**
 * @optimaizr/core: the analysis engine. No storage, network or UI: every export
 * is a pure function over data the caller supplies, and anything that needs to
 * persist takes an injected store (see DecisionStore).
 */

// Domain vocabulary: the one shape everything downstream reads.
export * from "./domain/types.js";

// Pricing and the model catalogue.
export * from "./pricing.js";

// Analysis.
export * from "./analyze/classify.js";
export * from "./analyze/summary.js";
export * from "./analyze/rules.js";
export * from "./analyze/drilldown.js";
export * from "./analyze/profile.js";
export * from "./analyze/budget.js";
export * from "./analyze/plan.js";
export * from "./analyze/codex-plan.js";
// Live analysis: the same rules over a rolling window, for streaming hosts.
export * from "./analyze/live.js";

// Findings -> recommendations (decision persistence is injected).
export * from "./recommend/recommendations.js";
// Accepting a recommendation, and the pre-request seam that applies one.
export * from "./recommend/actions.js";

// Ingestion parsers.
export * from "./ingest/images.js";
export * from "./ingest/claudecode.js";
export * from "./ingest/codex.js";
export * from "./ingest/import.js";

// Provider registry (adapters register themselves from the host package).
export * from "./providers/registry.js";

// Quality bar + checks. Replay lives in the host, because it makes network calls.
export * from "./verify/quality.js";
// Verification state: what verify wrote and apply reads (persistence injected).
export * from "./verify/state.js";
export * from "./verify/dialect.js";

// Rendering.
export * from "./report/terminal.js";
export * from "./report/html.js";
export * from "./report/card.js";

// Product metrics computed from analysed data.
export * from "./metrics.js";
