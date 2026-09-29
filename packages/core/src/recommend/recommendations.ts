import { priceFor, usd } from "../pricing.js";
import { verificationModeOf } from "../verify/state.js";
import type {
  OptimizationFinding,
  Recommendation,
  RecommendationAction,
  RecommendationStatus,
  UsageEvent,
  VerificationMode,
} from "../domain/types.js";

/**
 * Findings to recommendations. A finding says what's true; a recommendation
 * proposes a change and tracks the decision about it, which persists across runs.
 */

/** Turn a finding's fix into an imperative action line. */
function actionFor(f: OptimizationFinding): string {
  const c = f.candidate;
  if (c?.kind === "swap-model" && c.to) {
    const from = f.affected.models.map((m) => priceFor(m)?.label ?? m).join(" / ");
    const to = priceFor(c.to)?.label ?? c.to;
    return `Switch eligible requests from ${from} to ${to}`;
  }
  if (c?.kind === "lower-effort") return "Lower reasoning effort on shallow-output requests";
  if (c?.kind === "enable-cache") return "Stabilise and cache the request prefix";
  if (c?.kind === "trim-prompt") return "Trim the system prompt";
  // Rules without a mechanical candidate still need an imperative line.
  if (f.rule === "oversized-input") return "Give mechanical steps their own short context";
  if (f.rule === "oversized-output") return "Cap response length on outlier requests";
  if (f.rule === "oversized-tool-output") return "Filter oversized tool output at the source";
  if (f.rule === "error-loops") return "Stop retrying identical failing calls";
  return f.title;
}

/**
 * One sentence answering "why is this being suggested to me?", phrased in
 * terms of the user's own traffic rather than the rule's internals.
 */
function rationaleFor(f: OptimizationFinding, totalCalls: number): string {
  const share = totalCalls > 0 ? (f.affected.calls / totalCalls) * 100 : 0;
  switch (f.rule) {
    case "model-fit":
      return `${share.toFixed(0)}% of your requests use a model whose capabilities exceed the detected workload requirements.`;
    case "reasoning-effort":
      return `${f.affected.calls} requests spent more on deliberation than on the answer they produced.`;
    case "cache-churn":
    case "repeated-context":
      return `Input that could be served from cache at a tenth of the rate is being paid for in full.`;
    case "repeat-tool-calls":
      return `Content already present in the session is being fetched and re-billed on every later call.`;
    case "prompt-bloat":
      return `A large system prompt is charged on every single request.`;
    case "oversized-output":
      return `Output tokens cost roughly five times input tokens, and these responses are outliers.`;
    case "oversized-input":
      return `Small jobs are inheriting a whole session's context to do their work.`;
    case "oversized-tool-output":
      return `Oversized tool results stay in context and are re-billed for the rest of the session.`;
    case "error-loops":
      return `Identical failing calls were retried without changing anything.`;
    default:
      return f.detail.split(". ")[0] + ".";
  }
}

/**
 * What the user can do with a recommendation now. `simulate` works for every
 * one (it's arithmetic on recorded tokens); `verify` only where a replay can
 * settle the question.
 */
function actionsFor(f: OptimizationFinding): RecommendationAction[] {
  const actions: RecommendationAction[] = ["view-affected", "simulate"];
  if (verificationModeOf(f) === "replay") actions.push("verify");
  actions.push("apply");
  return actions;
}

/* ------------------------------------------------------------------ *
 * Decision state, persisted between runs
 * ------------------------------------------------------------------ */

interface StoredDecision {
  id: string;
  status: RecommendationStatus;
  at: string;
  note?: string;
}

/**
 * Where decisions persist. Findings are recomputed every run, but decisions
 * belong to the user and must outlive it. The host injects the store (the CLI
 * uses a JSON file); core's in-memory default keeps it usable in any runtime.
 */
export interface DecisionStore {
  load(): Record<string, StoredDecision>;
  save(all: Record<string, StoredDecision>): void;
}

function memoryStore(): DecisionStore {
  let state: Record<string, StoredDecision> = {};
  return {
    load: () => state,
    save: (all) => {
      state = all;
    },
  };
}

let store: DecisionStore = memoryStore();

/** Install the host's decision store. Called once at startup. */
export function setDecisionStore(next: DecisionStore): void {
  store = next;
}

export function loadDecisions(): Record<string, StoredDecision> {
  try {
    return store.load();
  } catch {
    return {};
  }
}

/** Record a decision about a recommendation. Never throws. */
export function setStatus(id: string, status: RecommendationStatus, note?: string): void {
  try {
    const all = { ...loadDecisions() };
    all[id] = { id, status, at: new Date().toISOString(), note };
    store.save(all);
  } catch {
    /* a lost decision must not break the run */
  }
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export function toRecommendations(
  findings: OptimizationFinding[],
  totalCalls: number,
): Recommendation[] {
  const decisions = loadDecisions();

  return (
    findings
      // Advisories are information, not proposals: nothing to accept.
      .filter((f) => !f.advisory)
      .map((f) => ({
        id: f.rule,
        rule: f.rule,
        category: f.category,
        action: actionFor(f),
        rationale: rationaleFor(f, totalCalls),
        savings: f.savings,
        affected: f.affected,
        impact: f.impact,
        risk: f.risk,
        verification: verificationModeOf(f),
        actions: actionsFor(f),
        status: decisions[f.rule]?.status ?? "new",
      }))
  );
}

/* ------------------------------------------------------------------ *
 * Simulate
 * ------------------------------------------------------------------ */

export interface Simulation {
  recommendation: string;
  action: string;
  /** Supplied events this finding covers (its `affected.calls` on the same dataset). */
  matchedCalls: number;
  currentUsd: number;
  simulatedUsd: number;
  windowSaving: number;
  monthlySaving: number;
  annualSaving: number;
  /** Per-model movement the change would cause. */
  shifts: Array<{ model: string; calls: number; from: number; to: number }>;
  /**
   * True when none of the supplied events belong to the finding, so the money
   * below doesn't describe the traffic given. Callers must say so.
   */
  stale: boolean;
  /** How this finding's quality question can be settled, for the caveat. */
  verification: VerificationMode;
  caveat: string;
}

/**
 * Model the change arithmetically from recorded tokens, without calling the
 * API. Says what it would cost, not whether the output stays good (`verify`).
 */
export function simulate(
  rec: Recommendation,
  finding: OptimizationFinding,
  events: UsageEvent[],
  windowDays: number,
): Simulation {
  // The finding's own events, the ones its dollar figures came from.
  const matched = events.filter(finding.affects ?? (() => false));
  const days = Math.max(1, windowDays);

  const byModel = new Map<string, { calls: number; from: number }>();
  for (const e of matched) {
    const agg = byModel.get(e.model) ?? { calls: 0, from: 0 };
    agg.calls++;
    agg.from += e.cost.total;
    byModel.set(e.model, agg);
  }

  const ratio =
    finding.savings.currentUsd > 0 ? finding.savings.optimizedUsd / finding.savings.currentUsd : 1;

  const shifts = [...byModel.entries()].map(([model, v]) => ({
    model,
    calls: v.calls,
    from: v.from,
    to: v.from * ratio,
  }));

  const windowSaving = finding.savings.windowUsd;
  const mode = verificationModeOf(finding);
  // A finding always counts at least one event, so an empty intersection means
  // the events supplied are not the ones it was computed from.
  const stale = matched.length === 0 && finding.affected.calls > 0;

  return {
    recommendation: rec.id,
    action: rec.action,
    matchedCalls: matched.length,
    currentUsd: finding.savings.currentUsd,
    simulatedUsd: finding.savings.optimizedUsd,
    windowSaving,
    monthlySaving: (windowSaving / days) * 30,
    annualSaving: (windowSaving / days) * 365,
    shifts,
    stale,
    verification: mode,
    caveat: stale
      ? "None of the requests supplied belong to this finding, so these figures come from the finding alone and could not be re-derived here. Re-run the analysis over the window the finding was found in."
      : mode === "not-required"
        ? "This change removes waste without altering model output."
        : mode === "replay"
          ? `This is arithmetic on your recorded tokens, not evidence about quality. Run 'optimaizr verify ${rec.id}' before acting on it.`
          : "This is arithmetic on your recorded tokens, not evidence about quality. No replay can settle this one, so validate it on your own evals before acting on it.",
  };
}

export function formatSimulation(s: Simulation): string[] {
  const lines: string[] = [];
  lines.push(`${s.action}`);
  lines.push(`${s.matchedCalls} matching calls in the window`);
  lines.push(`${usd(s.currentUsd)} -> ${usd(s.simulatedUsd)}`);
  lines.push(`${usd(s.monthlySaving)}/month, ${usd(s.annualSaving)}/year`);
  return lines;
}
