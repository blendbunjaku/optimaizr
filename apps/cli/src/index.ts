/**
 * optimAIzr: spend fewer tokens on the same work.
 *
 * Two ways in, one analysis:
 *
 *   // 1. Your app: one line, no other changes. Anthropic or OpenAI.
 *   import optimaizr from "optimaizr";
 *   const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
 *   const openai = optimaizr.wrap(new OpenAI(), { service: "checkout-api" });
 *
 *   // 2. Your coding agents: nothing to change at all.
 *   $ optimaizr scan
 */

export { wrap, withRoute, record, type WrapOptions } from "@optimaizr/local";
export { ingestClaudeCode, type IngestOptions } from "@optimaizr/core";
export { readLedger, drain, ledgerPath, optimaizrDir } from "@optimaizr/local";
export { summarize, inputRateOf, type Summary, type Bucket } from "@optimaizr/core";
export { findWaste } from "@optimaizr/core";

// Live analysis, plus the `RequestRewriter` seam that accepting a live
// recommendation goes through (a wrapped app's next request, or Claude Code's
// next session).
export {
  createLiveSession,
  tailLedger,
  tailTranscripts,
  tailCodex,
  claudeProjectsRoot,
  codexSessionsRoot,
  claudeSettingsRewriter,
  claudeSettingsPath,
  sdkOverrideRewriter,
  readOverrides,
  removeOverrides,
  overridesPath,
  createJevJudge,
} from "@optimaizr/local";
export type {
  LiveSession,
  TailOptions,
  TranscriptTailOptions,
  JevJudge,
  JevOptions,
  ModelOverride,
} from "@optimaizr/local";
export {
  createLiveAnalyzer,
  LIVE_DEFAULTS,
  accept,
  proposedChange,
  nextCommandFor,
} from "@optimaizr/core";
export type {
  LiveAnalyzer,
  LiveOptions,
  LiveRecommendation,
  FrontierJudge,
  RequestRewriter,
  ProposedChange,
  ApplyOutcome,
  Traffic,
  TrafficSlice,
} from "@optimaizr/core";
export { createLivePrompt, type LivePrompt, type PromptOptions } from "./live-prompt.js";
export {
  createStatusLine,
  emptyStatus,
  recordCall,
  renderRunSummary,
  renderStatus,
  type StatusState,
} from "./live-status.js";
export { newer, updateLines, updatesEnabled, type UpdateState } from "./update.js";
export { changelogSections } from "./commands/changelog.js";
export { verifyCandidate, applyCandidate, type VerifyResult } from "@optimaizr/local";
export {
  DEFAULT_BAR,
  runCheck,
  judgePair,
  type QualityBar,
  type Check,
  type JudgeConfig,
} from "@optimaizr/core";
export { readSamples, defaultRedact, type Sample, type CaptureOptions } from "@optimaizr/local";
export {
  MODELS,
  priceFor,
  costOf,
  costOnModel,
  ratesFor,
  usd,
  tokens,
  CACHE_MULTIPLIER,
  BATCH_MULTIPLIER,
  type ModelPrice,
  type CostBreakdown,
} from "@optimaizr/core";
export type {
  CallEvent,
  Dataset,
  OptimizationFinding,
  ToolCall,
  VerifyCandidate,
  Window,
} from "@optimaizr/core";

import { wrap, withRoute, record } from "@optimaizr/local";
export default { wrap, withRoute, record };
