import type { CostBreakdown } from "../pricing.js";

/**
 * The domain model. Every provider adapter produces `UsageEvent`s, and
 * everything downstream (analysis, recommendations, reports) reads only these
 * types, so nothing above this file knows how a provider formats its usage.
 */

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * How a number came to exist, shown on every figure:
 * - `measured`: read directly from provider-reported usage.
 * - `inferred`: derived from measured data by a stated rule.
 * - `estimated`: a projection that rests on assumptions.
 */
export type EvidenceClass = "measured" | "inferred" | "estimated";

export interface Evidence {
  kind: EvidenceClass;
  /** One line on where the number came from. */
  basis: string;
}

/* ------------------------------------------------------------------ *
 * Organisation and projects
 * ------------------------------------------------------------------ */

/** The billing entity. Single-tenant today; the shape is ready for more. */
export interface Organization {
  id: string;
  name: string;
  /** Providers this organisation has data for. */
  providers: string[];
  projects: Project[];
}

/** A unit of work spend is attributed to: an app, a service, a repo. */
export interface Project {
  id: string;
  name: string;
  /** Where the events came from, e.g. a repo path or a service name. */
  source: string;
}

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/** A model vendor. */
export interface Provider {
  id: string;
  label: string;
  /** How this provider prices cache traffic and batch work. */
  cachePolicy: {
    read: number;
    write5m: number;
    write1h: number;
    batch: number;
    /** True when the provider's reported input count includes cache reads. */
    inputIncludesCacheReads?: boolean;
  };
  /** Docs link for where a user finds their usage export. */
  usageExportHint?: string;
}

/**
 * Turns one provider's raw usage into `UsageEvent`s. The only place
 * provider-specific knowledge lives.
 */
export interface ProviderAdapter {
  /**
   * A registered `Provider` id, or `"any"` for adapters (the SDK ledger, usage
   * exports) that let the model catalogue decide.
   */
  provider: string;
  /** Human label for the ingestion source, e.g. "Claude Code transcripts". */
  label: string;
  /** Whether this adapter can read the given source. */
  canRead(source: AdapterSource): boolean;
  /** Normalise. Must never throw on malformed input; report via warnings. */
  read(source: AdapterSource): Promise<AdapterResult>;
}

export type AdapterSource =
  | { kind: "local-transcripts"; root?: string; days?: number; project?: string }
  | { kind: "ledger"; days?: number; project?: string }
  | { kind: "file"; path: string; service?: string };

export interface AdapterResult {
  events: UsageEvent[];
  /** Files or stores actually read. */
  sources: string[];
  /** Non-fatal problems: unparseable rows, unknown models. */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Usage
 * ------------------------------------------------------------------ */

/** One rolling usage window on a subscription, as the provider reports it. */
export interface RateLimitWindow {
  /** 0-100, the provider's own figure. */
  usedPercent: number;
  /** 300 is the five-hour window, 10080 the weekly one. */
  windowMinutes: number;
  /** ISO time the window resets. */
  resetsAt: string;
}

export interface RateLimitSnapshot {
  /** The plan as the provider names it: "plus", "pro", "free", "team"... */
  planType: string | null;
  /** Primary first. */
  windows: RateLimitWindow[];
}

/** One model call, normalised across providers. */
export interface UsageEvent {
  /** Stable id. The provider's message/request id where one exists. */
  id: string;
  /** Which adapter produced this. */
  source: "sdk" | "claude-code" | "codex" | "import";
  provider: string;
  /** ISO 8601. */
  ts: string;
  model: string;

  /** Groups related calls: a session, a trace, a conversation. */
  sessionId: string;
  /** Repo path for agents, or the service name passed to `wrap()`. */
  project: string;
  /** Call-site label, e.g. `summarise-ticket`. Drives per-route advice. */
  route?: string;
  /** Coarse workload class for the drill-down. Derived, not reported. */
  category?: WorkloadCategory;

  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Server-side web searches, billed per request ($10 per 1,000), not per token. */
  webSearches?: number;

  /**
   * The plan's own limit meter, as the provider reported it with this call.
   * Codex writes one on every `token_count`, so ChatGPT plans need no `--plan`.
   */
  rateLimits?: RateLimitSnapshot;

  /** Wall-clock latency in ms. Absent for transcript-derived calls. */
  latencyMs?: number;
  stopReason?: string | null;
  effort?: string | null;
  speed?: string | null;
  serviceTier?: string | null;
  batch?: boolean;
  isSubagent?: boolean;

  tools: ToolCall[];

  /** Size of the system prompt in characters, when known. */
  systemChars?: number;
  /** Number of tool definitions sent on the request. */
  toolDefCount?: number;
  /** Hash of the cacheable prefix, to spot cache-defeating churn. */
  prefixHash?: string;

  cost: CostCalculation;
}

/** Older name for `UsageEvent`. */
export type CallEvent = UsageEvent;

/** What a call was doing, inferred from token counts and tool use (not intent). */
export type WorkloadCategory =
  | "reasoning" // spent real thinking tokens
  | "tool-orchestration" // drove several tools
  | "generation" // produced substantial prose
  | "mechanical" // short output, no thinking, at most one tool
  | "unknown";

export interface ToolCall {
  id: string;
  name: string;
  /** Normalised signature used to detect repeats, e.g. `Read:/path/to/file`. */
  signature: string;
  /** Characters returned by the tool, when the result was captured. */
  resultChars?: number;
  /** What the result cost: estimated from length for text, from pixel size for images. */
  resultTokens?: number;
  imageCount?: number;
  isError?: boolean;
}

/** The money a call cost, broken out by what drove it. */
export type CostCalculation = CostBreakdown;

/* ------------------------------------------------------------------ *
 * Findings and recommendations
 * ------------------------------------------------------------------ */

export type Category =
  | "model-selection"
  | "context-bloat"
  | "caching"
  | "reasoning"
  | "retries"
  | "concentration"
  | "anomaly"
  | "pricing";

/** How much a fix could change model behaviour. */
export type Impact = "none" | "low" | "medium" | "high";

/**
 * How much to trust a finding's dollar figure. Ordinal on purpose: nothing
 * calibrates it, so a percentage would claim precision we don't have.
 * - `high`: recorded tokens, a large sample, and a fix that keeps token counts.
 * - `medium`: measured, but a thin sample or a fix that changes the output.
 * - `low`: modelled rather than measured, or too few calls.
 */
export type ConfidenceLevel = "low" | "medium" | "high";

/** Ordering for `ConfidenceLevel`, so callers can compare without a percentage. */
export const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** A projected saving, with everything needed to check it. Never a guarantee. */
export interface SavingsEstimate {
  /** Observed cost of the affected traffic over the analysed window. */
  currentUsd: number;
  /** Estimated cost of that same traffic after the change. */
  optimizedUsd: number;
  /** currentUsd - optimizedUsd, over the window. */
  windowUsd: number;
  monthlyUsd: number;
  annualUsd: number;
  /** Days `windowUsd` was observed over, so findings can be combined and re-projected. */
  windowDays: number;
  /**
   * Days `windowUsd` is divided by for a daily rate. Usually `windowDays`; see
   * `projectionDays` for when the recent pace differs.
   */
  projectionDays?: number;
  /** How far the dollar figure can be trusted. Ordinal, never a percentage. */
  confidence: ConfidenceLevel;
  /** Why the confidence is what it is. */
  confidenceBasis: string;
  /** Every assumption the estimate rests on, in plain language. */
  assumptions: string[];
  /** How the number was computed, so it can be checked. */
  calculation: string;
  evidence: Evidence;
}

/** What traffic an opportunity touches. */
export interface AffectedTraffic {
  calls: number;
  models: string[];
  projects: string[];
  routes: string[];
  /** Affected spend as a share of total spend in the window. */
  share: number;
  /** Ids of the priciest affected calls, for drill-down. */
  sampleEventIds: string[];
}

/** A detected inefficiency. Produced by the rules engine. */
export interface OptimizationFinding {
  rule: string;
  category: Category;
  title: string;
  /** What is happening and why it costs money. */
  detail: string;

  savings: SavingsEstimate;
  affected: AffectedTraffic;

  /** Expected effect on output quality if the fix is applied. */
  impact: Impact;
  severity: "high" | "medium" | "low";
  /** `safe` fixes are pure waste removal; others must clear the quality bar. */
  risk: "safe" | "needs-verification";
  /**
   * How the quality question can be settled, derived once in `build()` from
   * `risk` and `candidate`. `risk` alone isn't enough: `oversized-input`
   * changes output but has no request rewrite a replay could run.
   */
  verification: VerificationMode;
  /** A real cost you absorb (like a rate change), not waste. Never in headline savings. */
  advisory?: boolean;

  /** Concrete instances, most expensive first. */
  observations: string[];
  /** What to change. */
  fix: string;
  /** The exact events this finding counted. Every finding has one, candidate or not. */
  affects: (e: UsageEvent) => boolean;
  /**
   * `savings.windowUsd` split across the counted events by cost, keyed by event
   * id. Findings overlap, so totals are combined per event (`recoverableWindow`)
   * rather than summed. A Map, so it stays out of JSON output.
   */
  claimByEvent: ReadonlyMap<string, number>;
  candidate?: VerifyCandidate;
}

/**
 * How a finding's effect on output quality can be established:
 * - `not-required`: the fix can't change output (e.g. dropping a duplicate read).
 * - `replay`: a request rewrite, provable on recorded traffic via `candidate`.
 * - `manual`: can change output but can't be replayed; the user must sign off.
 */
export type VerificationMode = "not-required" | "replay" | "manual";

/** What is known about a finding's quality question. `verify` writes it, `apply` reads it. */
export type VerificationState =
  /** Nothing to establish: the change cannot alter output. Safe to apply. */
  | "not_required"
  /** A replay ran against the quality bar and cleared it. Safe to apply. */
  | "passed"
  /** A replay ran and did not clear the bar. The saving is not free. */
  | "failed"
  /** A replay ran but had too few samples to decide. */
  | "inconclusive"
  /** Verification is required and has not established anything yet. */
  | "unverified";

/** A persisted verification result for one rule. `apply` gates on it. */
export interface VerificationRecord {
  rule: string;
  /** ISO timestamp of the verification attempt. */
  at: string;
  state: VerificationState;
  /** The mode in force when this was recorded. */
  mode: VerificationMode;
  /** The replay's raw verdict, when a replay ran. */
  verdict?: "PASS" | "FAIL" | "INCONCLUSIVE";
  /** How many recorded samples were replayed. */
  samples?: number;
  /** Projected monthly saving the replay measured. */
  monthlySaving?: number;
  /** What was verified, in the candidate's own words. */
  description?: string;
  /** When the user signed off a `manual` finding: the only way one becomes appliable. */
  acceptedRiskAt?: string;
  /** Why the state is what it is, in one line. */
  note?: string;
}

export interface VerifyCandidate {
  kind: "swap-model" | "trim-prompt" | "enable-cache" | "lower-effort";
  from?: string;
  to?: string;
  /**
   * The target for a given model when a finding spans providers (Anthropic
   * traffic needs an Anthropic target). Falls back to `to`.
   */
  targetFor?: (modelId: string) => string | undefined;
  matches: (e: UsageEvent) => boolean;
  description: string;
}

/** A finding turned into a proposed change, with the state of that decision. */
export interface Recommendation {
  id: string;
  /** The finding this came from. */
  rule: string;
  category: Category;
  /** Imperative, e.g. "Switch eligible requests from Sonnet 5 to Haiku 4.5". */
  action: string;
  /** One sentence answering "why is this being suggested to me?". */
  rationale: string;
  savings: SavingsEstimate;
  affected: AffectedTraffic;
  impact: Impact;
  risk: OptimizationFinding["risk"];
  /** How this recommendation's quality question can be settled. */
  verification: VerificationMode;
  /** What a user can do with it right now. */
  actions: RecommendationAction[];
  status: RecommendationStatus;
}

export type RecommendationAction = "view-affected" | "simulate" | "verify" | "apply";

export type RecommendationStatus =
  "new" | "viewed" | "simulated" | "verified" | "rejected" | "applied";

/* ------------------------------------------------------------------ *
 * Datasets
 * ------------------------------------------------------------------ */

export interface Window {
  from: string;
  to: string;
  days: number;
}

export interface Dataset {
  events: UsageEvent[];
  window: Window;
  sources: string[];
  warnings: string[];
  /**
   * Sources that could not be read at all (`"<adapter label>: <error>"`). Each
   * one means missing data, so it must be shown where it can't be missed.
   */
  failures?: string[];
}

/** A detector that threw. Reported so a crashed rule never looks like a clean $0. */
export interface AnalysisError {
  /** The rule that failed, by the name it registers under. */
  rule: string;
  /** The error message, as thrown. */
  message: string;
}
