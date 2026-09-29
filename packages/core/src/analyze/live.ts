import { analyze } from "./rules.js";
import { toRecommendations } from "../recommend/recommendations.js";
import { trafficOf, type Traffic } from "../recommend/actions.js";
import type { Dataset, OptimizationFinding, Recommendation, UsageEvent } from "../domain/types.js";

/**
 * Live analysis: the same rules as the batch commands, re-run over a rolling
 * window as calls arrive, announcing a finding when it first crosses its
 * threshold. Rules are population statistics (some need 20 or 50 calls), so
 * "live" can't mean analysing one call at a time.
 *
 * Rules with a longer horizon (`pricingChange`, `costSpike`) never fire live.
 * Savings are reported as observed over the window, never projected to a
 * month: minutes of traffic can't be annualised. No network or disk access;
 * the clock is injected.
 */

/** Sensible defaults, exported so a host can show them in `--help`. */
export const LIVE_DEFAULTS = {
  /** Calls held in memory. Enough for the 50-event rules to reach quorum. */
  maxEvents: 500,
  /** Floor on re-analysis, so a burst of calls cannot spin the rule engine. */
  minIntervalMs: 2_000,
  /** Also re-analyse after this many calls, however fast they arrive. */
  everyNEvents: 25,
  /** Don't announce trivia. Matches the rules' own $0.01 floor. */
  minUsd: 0.01,
  /** Re-announce a standing finding only once its cost has grown this much. */
  regrowth: 2,
  /** Above this probability, the judge's "needs a big model" wins. */
  frontierThreshold: 0.6,
} as const;

/**
 * A semantic opinion the rules can't form. `isMechanical()` judges from call
 * shape alone, so a judge that looked at the work can veto its false positives.
 * Synchronous on purpose (a cache lookup, filled in the background);
 * `undefined` means no opinion, which must always be safe.
 */
export type FrontierJudge = (event: UsageEvent) => number | undefined;

/** Rules that only claim "a cheaper model would have done", so a judge can veto them. */
const JUDGEABLE_RULES = new Set(["model-fit", "reasoning-effort", "thinking-spend"]);

export interface LiveOptions {
  maxEvents?: number;
  minIntervalMs?: number;
  everyNEvents?: number;
  minUsd?: number;
  regrowth?: number;
  frontierThreshold?: number;
  /** Optional semantic veto. Absent means fully local, rules-only. */
  judge?: FrontierJudge;
  /** Injectable clock, so tests don't have to sleep. */
  now?: () => number;
}

/** A finding that just crossed its threshold, with the call that pushed it over. */
export interface LiveRecommendation {
  /** The existing recommendation, built by the existing engine. */
  recommendation: Recommendation;
  finding: OptimizationFinding;
  /** Savings observed over the live window, never projected forward. */
  observedUsd: number;
  /** True span of the window this was observed over, so the figure can be read in context. */
  windowMs: number;
  windowEvents: number;
  /** The call whose arrival tipped the rule over its threshold. */
  trigger: { id: string; model: string; route?: string | undefined; ts: string };
  /**
   * Where the affected calls came from (sources, services, routes, models), so
   * accepting a finding changes only that traffic.
   */
  traffic: Traffic;
  /** Set when a standing finding is re-announced because its cost grew. */
  repeatOf?: number;
  /** Set when the judge had an opinion on this finding's affected traffic. */
  judged?: { needsFrontierShare: number; sampled: number };
  /**
   * Set when the judge vetoed this finding: it's reported, not proposed, so the
   * user can see the veto. A host must never prompt on one.
   */
  withheld?: { by: string; needsFrontierShare: number; sampled: number };
}

export interface LiveAnalyzer {
  /**
   * Record a call and return anything newly worth saying. Returns rather than
   * calling back, so the caller owns all output.
   */
  push(event: UsageEvent): LiveRecommendation[];
  /** Force a re-analysis regardless of the interval (used on shutdown). */
  flush(): LiveRecommendation[];
  /** The current window, for a host that wants to render context. */
  window(): readonly UsageEvent[];
  /** Forget everything, including what has already been announced. */
  reset(): void;
}

function datasetOf(events: UsageEvent[]): Dataset {
  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days =
    from && to ? Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) : 0;
  return { events, window: { from, to, days }, sources: ["live"], warnings: [] };
}

/** Ask the judge about exactly the calls the finding counted (its `affects` predicate). */
function consult(
  finding: OptimizationFinding,
  events: readonly UsageEvent[],
  judge: FrontierJudge,
): { needsFrontierShare: number; sampled: number } | undefined {
  let sampled = 0;
  let needs = 0;
  for (const e of events) {
    if (!finding.affects(e)) continue;
    const p = judge(e);
    if (p === undefined) continue;
    sampled++;
    needs += p;
  }
  if (sampled === 0) return undefined;
  return { needsFrontierShare: needs / sampled, sampled };
}

export function createLiveAnalyzer(opts: LiveOptions = {}): LiveAnalyzer {
  const maxEvents = opts.maxEvents ?? LIVE_DEFAULTS.maxEvents;
  const minIntervalMs = opts.minIntervalMs ?? LIVE_DEFAULTS.minIntervalMs;
  const everyNEvents = opts.everyNEvents ?? LIVE_DEFAULTS.everyNEvents;
  const minUsd = opts.minUsd ?? LIVE_DEFAULTS.minUsd;
  const regrowth = opts.regrowth ?? LIVE_DEFAULTS.regrowth;
  const frontierThreshold = opts.frontierThreshold ?? LIVE_DEFAULTS.frontierThreshold;
  const now = opts.now ?? Date.now;

  const events: UsageEvent[] = [];
  /** rule -> observedUsd when it was last announced. */
  const announced = new Map<string, number>();
  let lastRun = 0;
  let sinceRun = 0;

  function run(trigger: UsageEvent | null): LiveRecommendation[] {
    lastRun = now();
    sinceRun = 0;
    if (events.length === 0) return [];

    const data = datasetOf(events);
    // The batch engine, unmodified. `analyze` reports rule errors separately,
    // so a broken detector can't take the live stream down.
    const { findings } = analyze(data);
    if (findings.length === 0) return [];

    // Reuse the existing action/rationale wording rather than inventing a
    // second vocabulary for the same findings. Keyed by rule, as `id` is.
    const recs = new Map(toRecommendations(findings, events.length).map((r) => [r.rule, r]));

    const out: LiveRecommendation[] = [];
    for (const finding of findings) {
      if (finding.advisory) continue; // a rate change is news, not an action

      const observedUsd = finding.savings.windowUsd;
      if (observedUsd < minUsd) continue;

      const recommendation = recs.get(finding.rule);
      if (!recommendation) continue; // advisory-filtered upstream; nothing to propose

      let judged: LiveRecommendation["judged"];
      let withheld: LiveRecommendation["withheld"];
      if (opts.judge && JUDGEABLE_RULES.has(finding.rule)) {
        judged = consult(finding, events, opts.judge);
        // The judge says this traffic needs its model: report the finding
        // without proposing it, so the user can still overrule.
        if (judged && judged.needsFrontierShare >= frontierThreshold) {
          withheld = { by: "jev", ...judged };
        }
      }

      const before = announced.get(finding.rule);
      // Repeat a finding only when it has grown materially.
      if (before !== undefined && observedUsd < before * regrowth) continue;
      announced.set(finding.rule, observedUsd);

      const first = events[0];
      const last = events[events.length - 1];
      const windowMs =
        first && last ? new Date(last.ts).getTime() - new Date(first.ts).getTime() : 0;
      const at = trigger ?? last;

      out.push({
        recommendation,
        finding,
        observedUsd,
        windowMs: Math.max(0, windowMs),
        windowEvents: events.length,
        trigger: {
          id: at?.id ?? "",
          model: at?.model ?? "",
          route: at?.route,
          ts: at?.ts ?? "",
        },
        traffic: trafficOf(finding, events),
        ...(before !== undefined ? { repeatOf: before } : {}),
        ...(judged ? { judged } : {}),
        ...(withheld ? { withheld } : {}),
      });
    }
    return out;
  }

  return {
    push(event: UsageEvent): LiveRecommendation[] {
      events.push(event);
      // Drop from the front so a long-running process stays bounded in memory.
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);

      sinceRun++;
      const due = now() - lastRun >= minIntervalMs || sinceRun >= everyNEvents;
      if (!due) return [];
      return run(event);
    },
    flush(): LiveRecommendation[] {
      return run(null);
    },
    window(): readonly UsageEvent[] {
      return events;
    },
    reset(): void {
      events.length = 0;
      announced.clear();
      lastRun = 0;
      sinceRun = 0;
    },
  };
}
