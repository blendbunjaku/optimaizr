import {
  allModels,
  cardFor,
  modelLabel,
  priceFor,
  ratesFor,
  usd,
  tokens as fmtTokens,
  PROVIDERS,
  type ModelPrice,
} from "../pricing.js";
import type {
  AnalysisError,
  Category,
  ConfidenceLevel,
  Dataset,
  Evidence,
  EvidenceClass,
  Impact,
  OptimizationFinding,
  FindingTier,
  UsageEvent,
} from "../domain/types.js";
import { classifyAll } from "./classify.js";
import {
  buildTasks,
  commandOf,
  contextOf,
  isEdit,
  isMutating,
  MECHANICAL_TASKS,
  QUICK_MAX_CALLS,
  QUICK_MAX_FILES,
  stampTasks,
  TASK_REASONING_TOKENS,
  TASK_KIND_LABEL,
  type Task,
} from "./tasks.js";
import { inputRateOf, projectionDays, summarize } from "./summary.js";

/**
 * The waste-detection rules. Each rule is a pure function from a context to at
 * most one finding, registered in `RULES` at the bottom.
 *
 * Every finding says how its window figure was derived (`measured`, `inferred`
 * or `estimated`, see `EvidenceClass`). Monthly and annual figures are always
 * projections on top of that.
 */

const CHARS_PER_TOKEN = 4;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;
const M = 1_000_000;

/** Tools whose results are pure context, so re-reading them is almost always waste. */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "NotebookRead"]);

function resultTokensOf(t: { resultTokens?: number; resultChars?: number }): number {
  if (typeof t.resultTokens === "number") return t.resultTokens;
  return (t.resultChars ?? 0) / CHARS_PER_TOKEN;
}

function cachePolicyOf(e: UsageEvent) {
  return PROVIDERS[e.provider] ?? PROVIDERS.anthropic!;
}

interface Ctx {
  data: Dataset;
  /** What projections divide by: the recent pace, see `projectionDays`. */
  days: number;
  totalCost: number;
  sessions: Map<string, UsageEvent[]>;
  /** Agent calls grouped by prompt. */
  tasks: Task[];
  taskOf: Map<string, Task>;
}

function buildCtx(data: Dataset): Ctx {
  classifyAll(data.events);
  const tasks = buildTasks(data.events);
  const taskOf = stampTasks(tasks);
  const sessions = new Map<string, UsageEvent[]>();
  let totalCost = 0;
  for (const e of data.events) {
    totalCost += e.cost.total;
    let arr = sessions.get(e.sessionId);
    if (!arr) {
      arr = [];
      sessions.set(e.sessionId, arr);
    }
    arr.push(e);
  }
  for (const arr of sessions.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return { data, days: projectionDays(data), totalCost, sessions, tasks, taskOf };
}

const perMonth = (ctx: Ctx, observed: number) => (observed / ctx.days) * MONTH_DAYS;
const perYear = (ctx: Ctx, observed: number) => (observed / ctx.days) * YEAR_DAYS;

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : p;
}

/** Below this many calls, an average is an anecdote rather than a rate. */
const SAMPLE_THIN = 10;
/** At or above this, one unusual call cannot meaningfully move the figure. */
const SAMPLE_SOLID = 50;

/**
 * How far a dollar figure can be trusted, from three mechanical inputs: was the
 * cost measured, how many calls it averages over, and whether the fix keeps
 * token counts the same (a model swap doesn't; deleting a duplicate read does).
 */
function confidenceOf(input: { measured: boolean; sample: number; tokenProfileStable: boolean }): {
  level: ConfidenceLevel;
  basis: string;
} {
  const reasons: string[] = [
    input.measured
      ? "costed from recorded tokens at the rate in force"
      : "modelled rather than measured",
    `${input.sample} affected call${input.sample === 1 ? "" : "s"}`,
    input.tokenProfileStable
      ? "token counts unchanged by the fix"
      : "the replacement model's token counts are assumed to match",
  ];

  // Either weakness caps the level on its own. `high` means the only thing
  // assumed is that the traffic continues.
  let level: ConfidenceLevel;
  if (!input.measured) {
    level = "low";
    reasons.push("low because the cost was never measured");
  } else if (input.sample < SAMPLE_THIN) {
    level = "low";
    reasons.push(`low because fewer than ${SAMPLE_THIN} calls is too thin to average`);
  } else if (!input.tokenProfileStable) {
    level = "medium";
    reasons.push("medium because the fix changes how the model responds");
  } else if (input.sample < SAMPLE_SOLID) {
    level = "medium";
    reasons.push(`medium because the sample is under ${SAMPLE_SOLID} calls`);
  } else {
    level = "high";
    reasons.push("high because only future traffic is assumed");
  }

  return { level, basis: reasons.join("; ") };
}

/** Shared assembly, so every finding carries the same fields. */
function build(
  ctx: Ctx,
  base: {
    rule: string;
    category: Category;
    title: string;
    detail: string;
    why: string;
    /** Defaults from impact: a fix that can't change output (or barely) is `fix`. */
    tier?: FindingTier;
    currentUsd: number;
    optimizedUsd: number;
    events: UsageEvent[];
    evidence: Evidence;
    confidence: { level: ConfidenceLevel; basis: string };
    impact: Impact;
    risk: "safe" | "needs-verification";
    assumptions: string[];
    calculation: string;
    observations: string[];
    fix: string;
    advisory?: boolean;
    candidate?: OptimizationFinding["candidate"];
    severityOverride?: OptimizationFinding["severity"];
  },
): OptimizationFinding {
  // An advisory carries a real monthly figure but nothing recoverable: you
  // absorb a rate rise, you do not cut it.
  const claimedUsd = base.advisory ? 0 : Math.max(0, base.currentUsd - base.optimizedUsd);

  // You can't recover more than the affected calls cost. Rules that model waste
  // forward (repeat-tool-calls charges every later call that carries a
  // duplicate) can overshoot, so every rule is clamped here.
  const affectedSpend = base.events.reduce((s, e) => s + e.cost.total, 0);
  const windowUsd = Math.min(claimedUsd, affectedSpend);
  const capped = claimedUsd - windowUsd > 1e-9;

  const optimizedUsd = base.advisory ? base.optimizedUsd : Math.max(0, base.currentUsd - windowUsd);
  const projected = base.advisory ? base.currentUsd : windowUsd;

  // Say when the clamp fired.
  const assumptions = capped
    ? [
        ...base.assumptions,
        `This detector modelled ${usd(claimedUsd)} of waste over the window, which is more than the affected calls cost (${usd(affectedSpend)}). The figure has been capped at what was actually spent.`,
      ]
    : base.assumptions;

  // Pin the finding to exactly the events it counted, so `simulate`, `show` and
  // `verify` always act on the same calls the finding reported.
  const affectedIds = new Set(base.events.map((e) => e.id));
  const affects = (e: UsageEvent) => affectedIds.has(e.id);
  const candidate = base.candidate ? { ...base.candidate, matches: affects } : undefined;

  // Derived here, not declared per rule, so a rule can't ask for verification
  // while offering nothing to verify.
  const verification: OptimizationFinding["verification"] =
    base.risk === "safe" ? "not-required" : candidate ? "replay" : "manual";

  // Split the window saving across its calls, weighted by cost, so overlapping
  // findings can be combined per call without billing the same dollar twice.
  const claimByEvent = new Map<string, number>();
  if (windowUsd > 0 && base.events.length > 0) {
    for (const e of base.events) {
      // Unpriced traffic has no cost to weight by, so split evenly.
      const share = affectedSpend > 0 ? e.cost.total / affectedSpend : 1 / base.events.length;
      claimByEvent.set(e.id, (claimByEvent.get(e.id) ?? 0) + windowUsd * share);
    }
  }

  const byCost = [...base.events].sort((a, b) => b.cost.total - a.cost.total);
  const dailyWaste = windowUsd / ctx.days;

  return {
    rule: base.rule,
    category: base.category,
    title: base.title,
    detail: base.detail,
    why: base.why,
    tier: base.tier ?? (base.impact === "none" || base.impact === "low" ? "fix" : "try"),
    savings: {
      currentUsd: base.currentUsd,
      optimizedUsd,
      windowUsd,
      monthlyUsd: perMonth(ctx, projected),
      annualUsd: perYear(ctx, projected),
      windowDays: Math.max(1, ctx.data.window.days || 1),
      projectionDays: ctx.days,
      confidence: base.confidence.level,
      confidenceBasis: base.confidence.basis,
      assumptions,
      calculation: base.calculation,
      evidence: base.evidence,
    },
    affected: {
      calls: base.events.length,
      models: [...new Set(base.events.map((e) => e.model))].sort(),
      projects: [...new Set(base.events.map((e) => e.project))].sort(),
      routes: [...new Set(base.events.map((e) => e.route).filter(Boolean))] as string[],
      share: ctx.totalCost > 0 ? affectedSpend / ctx.totalCost : 0,
      sampleEventIds: byCost.slice(0, 20).map((e) => e.id),
    },
    impact: base.impact,
    severity:
      base.severityOverride ?? (dailyWaste > 0.5 ? "high" : dailyWaste > 0.05 ? "medium" : "low"),
    risk: base.risk,
    verification,
    advisory: base.advisory,
    observations: base.observations,
    fix: base.fix,
    affects,
    claimByEvent,
    candidate,
  };
}

const evidence = (kind: EvidenceClass, basis: string): Evidence => ({ kind, basis });

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/**
 * The calls that share one context: the main conversation between compactions,
 * or one subagent run. A subagent starts empty, so reading what the main
 * conversation read is not a repeat; neither is re-reading after a compaction.
 */
function contexts(ctx: Ctx): UsageEvent[][] {
  const out = new Map<string, UsageEvent[]>();
  for (const events of ctx.sessions.values()) {
    for (const e of events) {
      const who = e.isSubagent ? `sub:${e.turnId ?? ""}` : "main";
      const key = `${e.sessionId}|${who}|${e.contextEpoch ?? 0}`;
      const arr = out.get(key);
      if (arr) arr.push(e);
      else out.set(key, [e]);
    }
  }
  return [...out.values()];
}

/**
 * The same read-only tool call repeated in one context, with nothing changed in
 * between. The duplicate is written into the cacheable prefix and re-read by
 * every later call, so it compounds. An edit to the file, or any change for a
 * search, makes the next read a fresh one.
 */
function repeatToolCalls(ctx: Ctx): OptimizationFinding | null {
  let wasted = 0;
  const perSignature = new Map<string, { count: number; cost: number; tokens: number }>();
  const touched = new Set<UsageEvent>();

  for (const events of contexts(ctx)) {
    const seen = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const remaining = events.length - i - 1;
      const rate = inputRateOf(e);
      const policy = cachePolicyOf(e);
      for (const t of e.tools) {
        if (!t.isError && isMutating(t)) {
          // A change retires reads of the file it touched, and every search.
          for (const sig of [...seen.keys()]) {
            const file = sig.startsWith("Read:") ? sig.slice(5).replace(/#[^#]*$/, "") : null;
            if (file === null ? !sig.startsWith("WebFetch:") : !t.target || t.target === file) {
              seen.delete(sig);
            }
          }
          continue;
        }
        if (!READ_ONLY_TOOLS.has(t.name)) continue;
        const prior = seen.get(t.signature) ?? 0;
        seen.set(t.signature, prior + 1);
        if (prior === 0) continue;

        const tk = resultTokensOf(t);
        if (tk < 50) continue;

        const cost = (tk * rate * (policy.write5m + remaining * policy.read)) / M;
        wasted += cost;
        touched.add(e);

        const agg = perSignature.get(t.signature) ?? { count: 0, cost: 0, tokens: 0 };
        agg.count++;
        agg.cost += cost;
        agg.tokens += tk;
        perSignature.set(t.signature, agg);
      }
    }
  }

  if (wasted < 0.01) return null;
  const top = [...perSignature.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
  const totalRepeats = [...perSignature.values()].reduce((s, v) => s + v.count, 0);
  const events = [...touched];
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);

  return build(ctx, {
    rule: "repeat-tool-calls",
    why: "A repeat is written into the conversation again and re-read by every later call, so it keeps costing until the conversation ends or is compacted.",
    category: "context-bloat",
    title: `${totalRepeats} redundant re-reads of content already in context`,
    detail:
      "The same file or search was fetched again in the same conversation, with nothing edited in between. Re-reads after an edit, after a compaction or by a subagent are not counted. Each duplicate is re-written into the cacheable prefix and then re-read by every later call, so the cost compounds with conversation length.",
    currentUsd,
    optimizedUsd: currentUsd - wasted,
    events,
    evidence: evidence(
      "measured",
      "Duplicate results were counted directly and priced at the rate in force",
    ),
    confidence: confidenceOf({ measured: true, sample: totalRepeats, tokenProfileStable: true }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "A duplicate read returns the same content the conversation already had: no edit to that file, and no change at all for a search, came in between.",
      "The duplicate stays in the prefix until the conversation ends or is compacted.",
      "Removing it changes nothing else about the call.",
    ],
    calculation:
      "For each duplicate: result tokens x input rate x (cache-write multiplier + remaining calls in session x cache-read multiplier).",
    observations: top.map(
      ([sig, v]) =>
        `${shortPath(sig).slice(0, 60)}: ${v.count} duplicate${v.count === 1 ? "" : "s"}, ${fmtTokens(v.tokens)} tok, ${usd(v.cost)}`,
    ),
    fix: "Keep a per-session record of what has already been read and serve repeats from it. In agent harnesses, prefer a targeted re-read (offset/limit) over refetching a whole file.",
  });
}

/** Calls that did no reasoning and produced little output, on an expensive model. */
const OVERSPEC_TIERS = new Set(["frontier", "balanced"]);

/**
 * One independent request (SDK, imports) judged by its own shape. Agent calls
 * are judged by their task instead: one step of a hard task looks like this too.
 */
function isMechanicalCall(e: UsageEvent): boolean {
  return (
    OVERSPEC_TIERS.has(priceFor(e.model)?.tier ?? "") &&
    e.thinkingTokens === 0 &&
    e.outputTokens < 600 &&
    e.tools.length <= 1
  );
}

/** Current list rate, blended, used only to rank candidates against each other. */
function blendedRate(price: ModelPrice): number {
  const card = cardFor(price);
  return card.inputPerM + card.outputPerM;
}

// One tier down: a frontier model's mechanical calls go to a balanced model
// people trust (Opus to Sonnet), a balanced model's to a fast one.
const STEP_DOWN: Record<string, string[]> = {
  frontier: ["balanced", "fast"],
  balanced: ["fast"],
};

/**
 * The cheapest cheaper model one tier down from the same provider, or the tier
 * below that when there is none. Crossing vendors is a migration (SDK, auth,
 * limits, data terms), not a config change, so it's never proposed.
 */
function downgradeTargetFor(modelId: string): ModelPrice | null {
  const from = priceFor(modelId);
  if (!from) return null;
  const ceiling = blendedRate(from);
  for (const tier of STEP_DOWN[from.tier] ?? []) {
    let best: ModelPrice | null = null;
    let sibling: ModelPrice | null = null;
    for (const m of allModels()) {
      if (m.provider !== from.provider || m.tier !== tier) continue;
      const rate = blendedRate(m);
      if (rate >= ceiling) continue;
      // The model's own smaller variant (gpt-5.4 to gpt-5.4-mini) beats a
      // cheaper one from an older generation.
      if (m.id.startsWith(`${from.id}-`) && !sibling) sibling = m;
      // Ties keep the first listed, which is the newest.
      if (!best || rate < blendedRate(best)) best = m;
    }
    if (sibling ?? best) return sibling ?? best;
  }
  return null;
}

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A call's recorded tokens priced on another model, on the rate card of its day. */
function repriced(e: UsageEvent, from: ModelPrice, to: ModelPrice) {
  const now = ratesFor(from, { at: e.ts, speed: e.speed, batch: e.batch });
  const then = ratesFor(to, { at: e.ts, batch: e.batch });
  const priceWith = (r: typeof now) =>
    (e.inputTokens * r.inputPerM +
      e.outputTokens * r.outputPerM +
      e.cacheReadTokens * r.cachedInputPerM +
      e.cacheWrite5mTokens * r.cacheWrite5mPerM +
      e.cacheWrite1hTokens * r.cacheWrite1hPerM) /
    M;
  return { before: priceWith(now), after: priceWith(then) };
}

/**
 * What switching the main conversation to `to` costs up front: its cache is
 * the old model's, so the first call writes the whole context again instead of
 * reading it. A subagent starts empty and writes its cache on either model.
 */
function reloadCost(to: ModelPrice, contextTokens: number, at: string): number {
  const r = ratesFor(to, { at });
  return (contextTokens * (Math.max(r.inputPerM, r.cacheWrite5mPerM) - r.cachedInputPerM)) / M;
}

/** "23 quick edits and 14 lookups". */
function kindMix(tasks: Task[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
  return listOf(
    [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${TASK_KIND_LABEL[k as Task["kind"]]}${n === 1 ? "" : "s"}`),
  );
}

function modelFit(ctx: Ctx): OptimizationFinding | null {
  let currentUsd = 0;
  let optimizedUsd = 0;
  const events: UsageEvent[] = [];
  const samples: { desc: string; saved: number }[] = [];
  // Targets and sources actually used, so the advice can name them rather than guess.
  const targets = new Map<string, ModelPrice>();
  const sources = new Set<string>();
  // "Opus 5.5 to Sonnet 5.5": each source with its own step down.
  const pairs = new Map<string, string>();
  let calls = 0;

  // Independent requests, one at a time.
  for (const e of ctx.data.events) {
    if (ctx.taskOf.has(e.id) || !isMechanicalCall(e)) continue;
    const price = priceFor(e.model);
    const target = downgradeTargetFor(e.model);
    if (!price || !target || contextOf(e) > target.contextTokens * 0.9) continue;
    const { before, after } = repriced(e, price, target);
    if (after >= before) continue;
    currentUsd += before;
    optimizedUsd += after;
    events.push(e);
    calls++;
    targets.set(target.id, target);
    sources.add(price.label);
    pairs.set(price.label, target.label);
    if (samples.length < 5) {
      samples.push({
        desc: `${modelLabel(e.model)} -> ${target.label} · ${fmtTokens(contextOf(e))} ctx · ${e.outputTokens} out · ${e.tools[0]?.name ?? "no tool"}`,
        saved: before - after,
      });
    }
  }

  // Agent work, by finished task. Consecutive quick tasks in one conversation
  // switch together and pay one reload; a subagent pays none.
  const counted: Task[] = [];
  const taskSamples: { desc: string; saved: number }[] = [];
  const eligible = (t: Task): ModelPrice | null => {
    const price = priceFor(t.model);
    if (!t.done || !MECHANICAL_TASKS.has(t.kind) || !price || !OVERSPEC_TIERS.has(price.tier)) {
      return null;
    }
    const target = downgradeTargetFor(t.model);
    return target && t.maxContext <= target.contextTokens * 0.9 ? target : null;
  };
  const runs: Task[][] = [];
  const open = new Map<string, Task[]>();
  for (const t of ctx.tasks) {
    const fits = eligible(t) !== null;
    if (t.isSubagent) {
      if (fits) runs.push([t]);
      continue;
    }
    const run = open.get(t.sessionId);
    if (!fits) open.delete(t.sessionId);
    else if (run) run.push(t);
    else {
      const fresh = [t];
      open.set(t.sessionId, fresh);
      runs.push(fresh);
    }
  }
  for (const run of runs) {
    const first = run[0]!;
    const target = eligible(first)!;
    let before = 0;
    let after = 0;
    const perTask: { t: Task; saved: number }[] = [];
    for (const t of run) {
      let b = 0;
      let a = 0;
      for (const e of t.events) {
        const fromPrice = priceFor(e.model);
        const to = downgradeTargetFor(e.model);
        if (!fromPrice || !to) continue;
        const r = repriced(e, fromPrice, to);
        b += r.before;
        a += Math.min(r.after, r.before);
      }
      before += b;
      after += a;
      perTask.push({ t, saved: b - a });
    }
    const reload = first.isSubagent ? 0 : reloadCost(target, first.firstContext, first.start);
    if (before - after - reload <= 0) continue;

    currentUsd += before;
    optimizedUsd += after + reload;
    for (const { t, saved } of perTask) {
      events.push(...t.events);
      counted.push(t);
      targets.set(eligible(t)!.id, eligible(t)!);
      sources.add(priceFor(t.model)!.label);
      pairs.set(priceFor(t.model)!.label, eligible(t)!.label);
      taskSamples.push({
        desc: `${TASK_KIND_LABEL[t.kind]} · ${t.calls} call${t.calls === 1 ? "" : "s"}${t.filesEdited ? ` · ${t.filesEdited} file${t.filesEdited === 1 ? "" : "s"}` : ""} · ${fmtTokens(t.firstContext)} ctx${t.isSubagent ? " · subagent" : ""} · ${modelLabel(t.model)} -> ${eligible(t)!.label}`,
        saved,
      });
    }
  }

  const saving = currentUsd - optimizedUsd;
  const tasks = counted.length;
  if (saving < 0.01 || (calls < 5 && tasks < 5)) return null;

  const names = listOf([...targets.values()].map((t) => t.label));
  const from = listOf([...sources]);
  const pairText = listOf([...pairs].map(([a, b]) => `${a} to ${b}`));
  const subagents = counted.filter((t) => t.isSubagent).length;
  const what =
    tasks > 0
      ? `${tasks} quick task${tasks === 1 ? "" : "s"}${calls >= 5 ? ` and ${calls} simple calls` : ""}`
      : `${calls} simple calls`;
  const shapeNote =
    tasks > 0
      ? `Each task took at most ${QUICK_MAX_CALLS} calls, edited at most ${QUICK_MAX_FILES} files, failed at most once, thought for under ${fmtTokens(TASK_REASONING_TOKENS)} tokens and ended with a short answer (${kindMix(counted)}${subagents ? `; ${subagents} in subagents` : ""}).`
      : "Each call had no reasoning tokens, a short output and at most one tool call.";

  return build(ctx, {
    rule: "model-fit",
    why: `These jobs were within reach of a model one tier down, so the bigger model's price bought nothing extra: the same work costs ${currentUsd > 0 ? Math.round((1 - optimizedUsd / currentUsd) * 100) : 0}% less there.`,
    category: "model-selection",
    title: `${what} ran on ${from}`,
    detail: `${shapeNote} Re-priced on ${names}${tasks > 0 ? ", including reloading a conversation into its cache where it would switch mid-way" : ""}, the same work costs ${usd(optimizedUsd)} instead of ${usd(currentUsd)}.`,
    currentUsd,
    optimizedUsd,
    events,
    evidence: evidence(
      "estimated",
      `Recorded tokens re-priced on ${names}; assumes a comparable token profile`,
    ),
    confidence: confidenceOf({
      measured: true,
      sample: tasks + calls,
      tokenProfileStable: false,
    }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      "The cheaper model produces a comparable token profile. A different model may be more or less verbose.",
      ...(tasks > 0
        ? [
            "A task is judged by its shape (calls, files edited, failures, output), never by what was asked. Tasks still running are left out.",
            "Switching back afterwards finds the bigger model's cache still warm.",
          ]
        : []),
      "Similar work keeps arriving at the same rate.",
      "Every affected call fits inside the context window of the model it would move to.",
      "Quality is unverified until `optimaizr verify model-fit` replays this traffic.",
    ],
    calculation: `Each call re-priced one tier down on the cheapest model from its own provider (${names}) using its recorded token counts and the rate cards in force on the day of the call.${tasks > 0 ? " Consecutive quick tasks in one conversation switch together and pay one cache reload of the context the first one started with; a run whose reload outweighs its saving is left out. Subagents pay no reload." : ""}`,
    observations: [...taskSamples, ...samples]
      .sort((a, b) => b.saved - a.saved)
      .slice(0, 5)
      .map((s) => `${s.desc}, would save ${usd(s.saved)}`),
    fix:
      tasks > 0
        ? `Move quick edits and lookups one model down (${pairText}) and keep the bigger model for planning, debugging and multi-step work: /model before a run of small tasks, or a subagent for them.`
        : `Route mechanical steps to ${names} and keep the bigger model for planning and multi-step reasoning.`,
    candidate: {
      kind: "swap-model",
      // A single target collapses to `to`; mixed-provider traffic resolves
      // per call instead, so nothing is ever re-routed across vendors.
      to: targets.size === 1 ? [...targets.keys()][0] : undefined,
      targetFor: (modelId: string) => downgradeTargetFor(modelId)?.id,
      matches: (e) => {
        const task = ctx.taskOf.get(e.id);
        return task ? counted.includes(task) : isMechanicalCall(e);
      },
      description: `Route ${tasks > 0 ? "quick tasks" : "mechanical calls"} to ${names}`,
    },
  });
}

/** Prompt caching only pays off if the cacheable prefix is byte-stable. */
function cacheChurn(ctx: Ctx): OptimizationFinding | null {
  const summary = summarize(ctx.data);
  const inputSide = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  if (inputSide < 100_000) return null;
  if (summary.cacheHitRate >= 0.7) return null;

  let saving = 0;
  let currentUsd = 0;
  const events: UsageEvent[] = [];
  const offenders = new Map<string, { calls: number; prefixes: Set<string>; cost: number }>();

  for (const e of ctx.data.events) {
    const rate = inputRateOf(e);
    const policy = cachePolicyOf(e);
    if (e.inputTokens > 2000) {
      saving += ((e.inputTokens - 2000) * rate * (1 - policy.read)) / M;
      currentUsd += e.cost.total;
      events.push(e);
    }
    if (e.prefixHash) {
      const key = e.route ?? e.project;
      const agg = offenders.get(key) ?? { calls: 0, prefixes: new Set<string>(), cost: 0 };
      agg.calls++;
      agg.prefixes.add(e.prefixHash);
      agg.cost += e.cost.total;
      offenders.set(key, agg);
    }
  }

  if (saving < 0.01) return null;
  const churny = [...offenders.entries()]
    .filter(([, v]) => v.prefixes.size > Math.max(3, v.calls * 0.5))
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 5);

  return build(ctx, {
    rule: "cache-churn",
    why: "Input served from cache costs a fraction of the normal rate; this traffic pays full price for a prefix it has sent before.",
    category: "caching",
    title: `Only ${(summary.cacheHitRate * 100).toFixed(0)}% of input tokens are served from cache`,
    detail:
      "Cache reads bill at a tenth of the input rate, so a stable prefix is the single largest lever on input cost. A hit rate this low means the cacheable prefix is changing between calls or cache_control breakpoints are missing.",
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence(
      "inferred",
      "Uncached input was measured; that it could be cached is inferred from prefix stability",
    ),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true,
    }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "The prefix could be made stable enough to hit cache on repeat calls.",
      "A 2,000-token tail is genuinely per-call and excluded from the estimate.",
      "Cache writes are already being paid for, so only the read discount is counted.",
    ],
    calculation:
      "For each call: (fresh input tokens - 2,000) x input rate x (1 - cache-read multiplier).",
    observations: churny.length
      ? churny.map(
          ([k, v]) =>
            `${k}: ${v.prefixes.size} distinct prefixes across ${v.calls} calls (${usd(v.cost)})`,
        )
      : [
          `Cache hit rate ${(summary.cacheHitRate * 100).toFixed(1)}% across ${fmtTokens(inputSide)} input tokens`,
        ],
    fix: "Put everything stable (tools, then system prompt) at the very front and mark the last stable block with cache_control. Move timestamps, request ids and user-specific text below the breakpoint. Keep tool definitions in a fixed order.",
    candidate: {
      kind: "enable-cache",
      matches: (e) => e.inputTokens > 2000,
      description: "Stabilise and cache the request prefix",
    },
  });
}

/** The same large prefix re-sent across separate sessions, at full input rate each time. */
function repeatedContext(ctx: Ctx): OptimizationFinding | null {
  const byPrefix = new Map<string, { events: UsageEvent[]; sessions: Set<string> }>();
  for (const e of ctx.data.events) {
    if (!e.prefixHash) continue;
    const agg = byPrefix.get(e.prefixHash) ?? { events: [], sessions: new Set<string>() };
    agg.events.push(e);
    agg.sessions.add(e.sessionId);
    byPrefix.set(e.prefixHash, agg);
  }

  // Only interesting when a prefix recurs across *different* sessions.
  const recurring = [...byPrefix.entries()].filter(
    ([, v]) => v.sessions.size >= 3 && v.events.length >= 10,
  );
  if (recurring.length === 0) return null;

  let saving = 0;
  const events: UsageEvent[] = [];
  const rows: string[] = [];

  for (const [hash, v] of recurring) {
    const uncached = v.events.reduce((s, e) => s + e.inputTokens, 0);
    if (uncached < 20_000) continue;
    const rate = inputRateOf(v.events[0]!);
    const policy = cachePolicyOf(v.events[0]!);
    const delta = (uncached * rate * (1 - policy.read)) / M;
    saving += delta;
    // A loop, not a spread: one hot prefix can recur across 100k+ calls.
    for (const e of v.events) events.push(e);
    rows.push(
      `prefix ${hash}: ${v.events.length} calls across ${v.sessions.size} sessions, ${fmtTokens(uncached)} uncached (${usd(delta)})`,
    );
  }

  if (saving < 0.01 || events.length === 0) return null;
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);

  return build(ctx, {
    rule: "repeated-context",
    why: "Context that recurs across requests could be cached at a fraction of the price, but is paid in full every time.",
    category: "caching",
    title: `The same context is re-sent across ${recurring.length} recurring prompt pattern${recurring.length === 1 ? "" : "s"}`,
    detail:
      "An identical cacheable prefix appears in many separate sessions, but is being paid for at full input rate each time. A prefix that recurs across sessions is exactly what a longer cache TTL is for.",
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence(
      "inferred",
      "Prefix fingerprints are measured; that a longer TTL would capture them is inferred",
    ),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true,
    }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "The recurring prefix is stable enough to hit a cache entry written by an earlier session.",
      "Calls recur inside the cache TTL you configure.",
    ],
    calculation:
      "Uncached input tokens on recurring prefixes x input rate x (1 - cache-read multiplier).",
    observations: rows.slice(0, 5),
    fix: "Mark the recurring prefix with a 1-hour cache_control breakpoint so it survives between sessions. The write costs twice the input rate once, then every later read costs a tenth.",
    candidate: {
      kind: "enable-cache",
      matches: (e) => Boolean(e.prefixHash),
      description: "Extend cache TTL for recurring prefixes",
    },
  });
}

/** An oversized system prompt paid for on every call. */
function promptBloat(ctx: Ctx): OptimizationFinding | null {
  const withSystem = ctx.data.events.filter(
    (e) => typeof e.systemChars === "number" && e.systemChars > 0,
  );
  if (withSystem.length < 20) return null;

  const avgChars = withSystem.reduce((s, e) => s + (e.systemChars ?? 0), 0) / withSystem.length;
  const avgTokens = avgChars / CHARS_PER_TOKEN;
  if (avgTokens < 4000) return null;

  const TRIM_SHARE = 0.25;
  let saving = 0;
  let currentUsd = 0;
  for (const e of withSystem) {
    const rate = inputRateOf(e);
    const policy = cachePolicyOf(e);
    const sysTokens = (e.systemChars ?? 0) / CHARS_PER_TOKEN;
    const effectiveRate = e.cacheReadTokens > 0 ? rate * policy.read : rate;
    saving += (sysTokens * TRIM_SHARE * effectiveRate) / M;
    currentUsd += e.cost.total;
  }
  if (saving < 0.01) return null;

  return build(ctx, {
    rule: "prompt-bloat",
    why: "The system prompt is billed on every request, so its size is multiplied across all of your traffic.",
    category: "context-bloat",
    title: `System prompt averages ${fmtTokens(avgTokens)} tokens on every call`,
    detail:
      "A large system prompt is paid for on every single request. Where it is cached the cost is a tenth, but it still occupies context and still bills, and most long prompts carry restated instructions and dead examples.",
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events: withSystem,
    evidence: evidence(
      "estimated",
      "Prompt size is measured; the trimmable share is a heuristic, not a measurement",
    ),
    confidence: confidenceOf({
      measured: false,
      sample: withSystem.length,
      tokenProfileStable: true,
    }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      "A quarter of the prompt is trimmable. This is a heuristic, not a measurement.",
      "Characters are converted at roughly four per token.",
      "Cached prompts are credited at the cache-read rate, not the full input rate.",
    ],
    calculation: `Average system prompt of ${fmtTokens(avgTokens)} tokens x ${TRIM_SHARE * 100}% x the effective input rate, summed over ${withSystem.length} calls.`,
    observations: [
      `${withSystem.length} calls carried a system prompt averaging ${Math.round(avgChars).toLocaleString()} characters`,
      `Largest observed: ${withSystem.reduce((m, e) => Math.max(m, e.systemChars ?? 0), 0).toLocaleString()} characters`,
    ],
    fix: "Cut restated instructions and stale examples, then measure. Move anything request-specific out of the system prompt and below the cache breakpoint.",
    candidate: {
      kind: "trim-prompt",
      matches: (e) => (e.systemChars ?? 0) / CHARS_PER_TOKEN > 4000,
      description: "Trim the system prompt",
    },
  });
}

/** Below this many quick tasks there is no "typical" to compare against. */
const CONTEXT_BASELINE_TASKS = 20;

/**
 * Small jobs that carried far more context than similar small jobs usually do:
 * a long conversation's history dragged into a quick edit or lookup. Agent work
 * is compared task to task; independent requests by their own top decile.
 */
function oversizedInput(ctx: Ctx): OptimizationFinding | null {
  let saving = 0;
  const events: UsageEvent[] = [];
  const observations: string[] = [];

  // Agent tasks, against the quick tasks around them.
  const quick = ctx.tasks.filter((t) => t.done && MECHANICAL_TASKS.has(t.kind));
  let flagged: Task[] = [];
  let baseline = 0;
  if (quick.length >= CONTEXT_BASELINE_TASKS) {
    const starts = quick.map((t) => t.firstContext).sort((a, b) => a - b);
    baseline = starts[Math.floor(starts.length / 2)]!;
    const bar = Math.max(50_000, baseline * 3, baseline + 50_000);
    flagged = quick.filter((t) => t.firstContext >= bar);
    if (flagged.length < 5) flagged = [];
    for (const t of flagged) {
      for (const e of t.events) {
        // Most of it is cached, so credit it at the cache-read rate.
        saving +=
          (Math.max(0, contextOf(e) - baseline) * inputRateOf(e) * cachePolicyOf(e).read) / M;
      }
      events.push(...t.events);
    }
    observations.push(
      ...[...flagged]
        .sort((a, b) => b.firstContext - a.firstContext)
        .slice(0, 5)
        .map(
          (t) =>
            `${TASK_KIND_LABEL[t.kind]} · started at ${fmtTokens(t.firstContext)} ctx · ${t.calls} call${t.calls === 1 ? "" : "s"} · ${modelLabel(t.model)} · ${usd(t.costUsd)}`,
        ),
    );
  }

  // Independent requests in the top decile that did mechanical work.
  const loose = ctx.data.events.filter((e) => !ctx.taskOf.has(e.id));
  const sizes = loose.map(contextOf).sort((a, b) => a - b);
  let heavy: UsageEvent[] = [];
  let p90 = 0;
  let median = 0;
  if (sizes.length >= 20) {
    p90 = sizes[Math.floor(sizes.length * 0.9)]!;
    median = sizes[Math.floor(sizes.length * 0.5)]!;
    if (p90 >= 50_000) {
      heavy = loose.filter((e) => contextOf(e) >= p90 && e.category === "mechanical");
      if (heavy.length < 5) heavy = [];
    }
    for (const e of heavy) {
      saving += (Math.max(0, contextOf(e) - median) * inputRateOf(e) * cachePolicyOf(e).read) / M;
    }
    events.push(...heavy);
    observations.push(
      ...[...heavy]
        .sort((a, b) => contextOf(b) - contextOf(a))
        .slice(0, Math.max(0, 5 - observations.length))
        .map(
          (e) =>
            `${modelLabel(e.model)} · ${fmtTokens(contextOf(e))} ctx → ${e.outputTokens} out · ${usd(e.cost.total)}`,
        ),
    );
  }

  if (saving < 0.01 || events.length === 0) return null;
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  const tasks = flagged.length;
  const typicalStart = tasks
    ? [...flagged].sort((a, b) => a.firstContext - b.firstContext)[Math.floor(tasks / 2)]!
        .firstContext
    : 0;

  return build(ctx, {
    rule: "oversized-input",
    why: "Every call in those tasks re-reads the whole history, so a small job costs as much as a big one.",
    category: "context-bloat",
    title: tasks
      ? `${tasks} small tasks started with ~${fmtTokens(typicalStart)} of context; similar tasks start near ${fmtTokens(baseline)}`
      : `${heavy.length} mechanical calls carried ${fmtTokens(p90)}+ of context`,
    detail: tasks
      ? `Quick edits and lookups in your usage typically start with about ${fmtTokens(baseline)} of context. These ${tasks} started with ${fmtTokens(typicalStart)} or more: history from earlier work in the same conversation, carried into a small job that did not use it. Long conversations doing substantial work are not counted.${heavy.length ? ` ${heavy.length} independent API calls show the same pattern.` : ""}`
      : `These requests sit in the top 10% by context size but did mechanical work: short output, no reasoning, at most one tool. They are paying to carry a whole session's history to do a small job.`,
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence(
      "inferred",
      "Context sizes are measured; that the excess was unnecessary is inferred from what the task did",
    ),
    confidence: confidenceOf({
      measured: true,
      sample: tasks + heavy.length,
      tokenProfileStable: true,
    }),
    impact: "low",
    risk: "needs-verification",
    assumptions: [
      tasks
        ? `Context above what similar small tasks start with (${fmtTokens(baseline)}) was not needed for these tasks.`
        : `Context above the median (${fmtTokens(median)}) was not needed for these specific calls.`,
      "The excess is served from cache, so it is credited at the cache-read rate.",
      "What a task was doing is inferred from its shape (calls, files edited, output), not from what was asked.",
    ],
    calculation: tasks
      ? `For each call of a flagged task: (context tokens - ${fmtTokens(baseline)}, the median start of ${quick.length} quick tasks) x input rate x cache-read multiplier. A task is flagged when it started at 3x that median or more, and at least 50K.`
      : `For each top-decile mechanical call: (context tokens - median ${fmtTokens(median)}) x input rate x cache-read multiplier.`,
    observations,
    fix: tasks
      ? "Start small, unrelated jobs in a fresh conversation (/clear), or /compact when you change topic. A subagent also starts with an empty context."
      : "Split long-running sessions, or dispatch mechanical steps to a fresh short context instead of inheriting the whole conversation. In agent harnesses this is a sub-agent with its own context.",
  });
}

/** Rule: unusually large model outputs. */
function oversizedOutput(ctx: Ctx): OptimizationFinding | null {
  // A call that wrote a file put the file in its output: that length is the work.
  const prose = ctx.data.events.filter((e) => !e.tools.some(isEdit));
  const outputs = prose.map((e) => e.outputTokens).sort((a, b) => a - b);
  if (outputs.length < 20) return null;
  const p95 = outputs[Math.floor(outputs.length * 0.95)]!;
  if (p95 < 4000) return null;

  const big = prose.filter((e) => e.outputTokens >= p95);
  if (big.length < 5) return null;

  const median = outputs[Math.floor(outputs.length * 0.5)]!;
  let saving = 0;
  for (const e of big) {
    const price = priceFor(e.model);
    if (!price) continue;
    const r = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
    // Measure the excess against the median, not p95: when the outliers are all
    // the same size, p95 equals them and the excess would be zero. Reasoning
    // tokens are excluded (see reasoning-effort).
    const visibleExcess = Math.max(0, e.outputTokens - e.thinkingTokens - median);
    saving += (visibleExcess * r.outputPerM) / M;
  }
  if (saving < 0.01) return null;

  const currentUsd = big.reduce((s, e) => s + e.cost.total, 0);
  const truncated = big.filter((e) => e.stopReason === "max_tokens").length;

  return build(ctx, {
    rule: "oversized-output",
    why: "Output tokens are the most expensive tokens, around five times the input rate, and these answers are outliers in length.",
    category: "context-bloat",
    title: `${big.length} responses exceeded ${fmtTokens(p95)} output tokens`,
    detail: `Output tokens are the most expensive tokens you buy, typically five times the input rate. These responses are in the top 5% by length against a median of ${fmtTokens(median)}.${truncated > 0 ? ` ${truncated} hit the max_tokens ceiling, so they were cut off mid-answer and paid for in full.` : ""}`,
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events: big,
    evidence: evidence("measured", "Output tokens and rates are both recorded"),
    confidence: confidenceOf({ measured: true, sample: big.length, tokenProfileStable: false }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      `Output beyond the median (${fmtTokens(median)}) was longer than the task required.`,
      "Reasoning tokens are excluded here; they are covered by the reasoning-effort rule.",
      "Calls that wrote or edited a file are left out: their output is the file.",
      "A shorter response would still have satisfied the request.",
    ],
    calculation: `Responses above the 95th percentile (${fmtTokens(p95)}) are selected, then charged (visible output tokens - median ${fmtTokens(median)}) x the model's output rate.`,
    observations: big
      .sort((a, b) => b.outputTokens - a.outputTokens)
      .slice(0, 5)
      .map(
        (e) =>
          `${modelLabel(e.model)} · ${fmtTokens(e.outputTokens)} out${e.stopReason === "max_tokens" ? " (truncated)" : ""} · ${usd(e.cost.total)}`,
      ),
    fix: "Set an explicit length budget in the prompt and a max_tokens that matches it. Where output is truncated, the request is too broad: split it rather than raising the ceiling.",
  });
}

/** Fewer blind retries than this across the window reads as bad luck, not a habit. */
const MIN_BLIND_RETRIES = 3;

/**
 * Rule: a failed tool call run again unchanged, with nothing changed in between
 * (no edit, no command that changes state), so it could only fail the same way.
 * Fix-and-rerun is normal debugging and is not counted.
 */
function errorLoops(ctx: Ctx): OptimizationFinding | null {
  let wasted = 0;
  const loops = new Map<
    string,
    { repeats: number; streak: number; label: string; sessions: Set<string> }
  >();
  const touched = new Set<UsageEvent>();

  for (const events of contexts(ctx)) {
    let changes = 0;
    const failed = new Map<string, { at: number; streak: number }>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const remaining = events.length - i - 1;
      const rate = inputRateOf(e);
      const policy = cachePolicyOf(e);
      for (const t of e.tools) {
        if (!t.isError) {
          if (isMutating(t)) changes++;
          failed.delete(t.signature);
          continue;
        }
        const prev = failed.get(t.signature);
        if (!prev || prev.at !== changes) {
          failed.set(t.signature, { at: changes, streak: 1 });
          continue;
        }
        prev.streak++;
        const tk = resultTokensOf(t);
        wasted +=
          (tk * rate * (policy.write5m + remaining * policy.read)) / M + e.cost.output * 0.25;
        const agg = loops.get(t.signature) ?? {
          repeats: 0,
          streak: 0,
          label: commandOf(t) ?? `${t.name} ${shortPath(t.target ?? t.signature)}`,
          sessions: new Set<string>(),
        };
        agg.repeats++;
        agg.streak = Math.max(agg.streak, prev.streak);
        agg.sessions.add(e.sessionId);
        loops.set(t.signature, agg);
        touched.add(e);
      }
    }
  }

  const total = [...loops.values()].reduce((a, b) => a + b.repeats, 0);
  if (wasted < 0.005 || total < MIN_BLIND_RETRIES) return null;
  const events = [...touched];
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  const top = [...loops.values()].sort((a, b) => b.repeats - a.repeats).slice(0, 5);
  const worst = top[0]!;

  return build(ctx, {
    rule: "error-loops",
    why: "A blind retry can only fail the same way: you pay for the error and for the turn that produced it, and both stay in context.",
    category: "retries",
    title: `${total} retries of a failing command with nothing changed in between`,
    detail: `A command failed and was run again exactly as before, with no edit or other change in between, so it could only fail the same way. The worst ran ${worst.streak} times in a row. Retrying after a fix is normal debugging and is not counted. Each blind retry pays for the error output entering context and for the turn that produced it.`,
    currentUsd,
    optimizedUsd: currentUsd - wasted,
    events,
    evidence: evidence("measured", "Failed results were counted directly from the transcript"),
    confidence: confidenceOf({ measured: true, sample: total, tokenProfileStable: true }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "A retry with the same arguments and nothing changed since the last failure was avoidable.",
      "A quarter of the retry turn's output tokens are attributable to the retry.",
    ],
    calculation:
      "Per blind retry: error tokens x input rate x (cache-write + remaining calls x cache-read), plus 25% of that turn's output cost.",
    observations: top.map(
      (l) =>
        `${l.label.slice(0, 60)}: ${l.repeats} blind retr${l.repeats === 1 ? "y" : "ies"}, up to ${l.streak} in a row${l.sessions.size > 1 ? `, in ${l.sessions.size} sessions` : ""}`,
    ),
    fix: "When something fails twice, stop and change the approach: read the error, fix the cause, or ask Claude to try a different route. Starting a fresh conversation also clears the failed attempts from context. The optimAIzr mod holds a third identical attempt automatically.",
  });
}

/** Rule: individual tool results large enough to distort the rest of the session. */
function oversizedResults(ctx: Ctx): OptimizationFinding | null {
  const THRESHOLD_TOKENS = 10_000;
  let wasted = 0;
  const offenders: { sig: string; tokens: number; cost: number }[] = [];
  const touched = new Set<UsageEvent>();

  for (const events of ctx.sessions.values()) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const remaining = events.length - i - 1;
      const rate = inputRateOf(e);
      const policy = cachePolicyOf(e);
      for (const t of e.tools) {
        const tk = resultTokensOf(t);
        if (tk < THRESHOLD_TOKENS) continue;
        const excess = tk - THRESHOLD_TOKENS;
        const cost = (excess * rate * (policy.write5m + remaining * policy.read)) / M;
        wasted += cost;
        offenders.push({ sig: t.signature, tokens: tk, cost });
        touched.add(e);
      }
    }
  }

  if (wasted < 0.01) return null;
  offenders.sort((a, b) => b.cost - a.cost);
  const events = [...touched];
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);

  return build(ctx, {
    rule: "oversized-tool-output",
    why: "A huge tool result stays in context and is re-read by every call after it.",
    category: "context-bloat",
    title: `${offenders.length} tool results larger than 10K tokens`,
    detail:
      "Large tool output is paid for once on the way in and then on every subsequent call in the session. A single unfiltered log dump or full-file read can dominate a session's input bill.",
    currentUsd,
    optimizedUsd: currentUsd - wasted,
    events,
    evidence: evidence("measured", "Result sizes were measured, images by pixel area"),
    confidence: confidenceOf({
      measured: true,
      sample: offenders.length,
      tokenProfileStable: true,
    }),
    impact: "low",
    risk: "safe",
    assumptions: [
      "A 10,000-token result is a reasonable ceiling; only the excess is counted as waste.",
      "The oversized result could have been filtered at the source without losing what mattered.",
    ],
    calculation:
      "Per result: (result tokens - 10,000) x input rate x (cache-write + remaining calls x cache-read).",
    observations: offenders
      .slice(0, 5)
      .map((o) => `${shortPath(o.sig).slice(0, 60)}: ${fmtTokens(o.tokens)} tok, ${usd(o.cost)}`),
    fix: "Filter at the source: grep instead of cat, head/tail on logs, offset+limit on large files. Cap tool output and return a pointer to the full result rather than the result itself.",
  });
}

/** Rule: reasoning spend on turns that did no real reasoning work. */
function thinkingSpend(ctx: Ctx): OptimizationFinding | null {
  let thinkingCost = 0;
  let shallowCost = 0;
  const events: UsageEvent[] = [];

  for (const e of ctx.data.events) {
    if (e.thinkingTokens <= 0 || e.outputTokens <= 0) continue;
    const cost = e.cost.output * (e.thinkingTokens / e.outputTokens);
    thinkingCost += cost;
    const visible = e.outputTokens - e.thinkingTokens;
    // An agent thinks before most steps; that is waste only if the whole task
    // turned out to be a quick job.
    const task = ctx.taskOf.get(e.id);
    const quickJob = task ? task.done && MECHANICAL_TASKS.has(task.shape) : true;
    if (quickJob && e.thinkingTokens > 500 && visible < 150 && e.tools.length <= 1) {
      shallowCost += cost;
      events.push(e);
    }
  }

  if (shallowCost < 0.01 || events.length < 5) return null;
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);

  return build(ctx, {
    rule: "reasoning-effort",
    why: "Thinking is billed as output, the most expensive tokens, and here it led to a short answer.",
    category: "reasoning",
    title: `${events.length} calls spent heavy reasoning on trivial output`,
    detail: `Reasoning tokens bill at the output rate. These calls thought for 500+ tokens and then produced under 150 tokens of visible output with at most one tool call: deliberation that did not change what the model did. Total reasoning spend in the window was ${usd(thinkingCost)}.`,
    currentUsd,
    optimizedUsd: currentUsd - shallowCost,
    events,
    evidence: evidence(
      "estimated",
      "Reasoning tokens are measured; that they were unnecessary is an assumption",
    ),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: false,
    }),
    impact: "high",
    risk: "needs-verification",
    assumptions: [
      "Lowering effort removes the reasoning tokens without changing the visible answer.",
      "These calls stay shallow in future traffic. Some may have needed the reasoning.",
      "Reasoning tokens are billed at the model's output rate.",
    ],
    calculation:
      "Per call: output cost x (reasoning tokens / total output tokens), summed over calls with 500+ reasoning tokens and under 150 visible output tokens.",
    observations: [
      `${events.length} shallow-output reasoning calls costing ${usd(shallowCost)}`,
      `Reasoning is ${((thinkingCost / Math.max(1e-9, ctx.totalCost)) * 100).toFixed(1)}% of total spend`,
    ],
    fix: "Lower the effort level for this class of call, or route it to a model without always-on reasoning. Reserve high effort for turns that plan multi-step work.",
    candidate: {
      kind: "lower-effort",
      from: "high",
      to: "low",
      matches: (e) =>
        e.thinkingTokens > 500 && e.outputTokens - e.thinkingTokens < 150 && e.tools.length <= 1,
      description: "Reduce reasoning effort on shallow-output calls",
    },
  });
}

/**
 * Spend concentrated in a few sessions. Not waste but a targeting signal, so
 * it's an advisory with no saving claimed.
 */
function spendConcentration(ctx: Ctx): OptimizationFinding | null {
  if (ctx.data.events.length < 50) return null;

  const bySession = new Map<string, { cost: number; project: string; calls: number }>();
  for (const e of ctx.data.events) {
    const agg = bySession.get(e.sessionId) ?? { cost: 0, project: e.project, calls: 0 };
    agg.cost += e.cost.total;
    agg.calls++;
    bySession.set(e.sessionId, agg);
  }

  const ranked = [...bySession.entries()].sort((a, b) => b[1].cost - a[1].cost);
  if (ranked.length < 5) return null;

  // How few workloads make up 80% of spend?
  const target = ctx.totalCost * 0.8;
  let running = 0;
  let count = 0;
  for (const [, v] of ranked) {
    running += v.cost;
    count++;
    if (running >= target) break;
  }

  const shareOfWorkloads = count / ranked.length;
  // Only worth reporting when it's lopsided.
  if (shareOfWorkloads > 0.35) return null;

  const topIds = ranked.slice(0, count).map(([id]) => id);
  const events = ctx.data.events.filter((e) => topIds.includes(e.sessionId));

  return build(ctx, {
    rule: "spend-concentration",
    why: "A few workloads decide most of your bill, so that is where any change moves it.",
    category: "concentration",
    title: `${(shareOfWorkloads * 100).toFixed(0)}% of your workloads drive 80% of spend`,
    detail: `${count} of ${ranked.length} sessions account for ${usd(running)} of ${usd(ctx.totalCost)}. That is not waste: it is where optimisation effort actually pays back. A fix applied to these sessions is worth several times the same fix applied anywhere else.`,
    currentUsd: running,
    optimizedUsd: running,
    events,
    advisory: true,
    evidence: evidence("measured", "Spend per session summed directly from recorded costs"),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true,
    }),
    impact: "none",
    risk: "safe",
    severityOverride: "low",
    assumptions: ["Sessions are a reasonable proxy for a workload."],
    calculation:
      "Sessions ranked by total cost; counted until the running total reaches 80% of spend.",
    observations: ranked
      .slice(0, 5)
      .map(
        ([id, v]) =>
          `${v.project.split("/").slice(-1)[0]} · ${id.slice(0, 8)}: ${usd(v.cost)} across ${v.calls} calls`,
      ),
    fix: "Target the findings above at these workloads first. Optimising the long tail is rarely worth the engineering time.",
  });
}

/**
 * A day whose spend jumped well above the median without a matching jump in
 * calls. An anomaly, never waste: the spike may be legitimate.
 */
function costSpike(ctx: Ctx): OptimizationFinding | null {
  const summary = summarize(ctx.data);
  const days = summary.byDay;
  if (days.length < 5) return null;

  const costs = days.map((d) => d.cost.total);
  const median = [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)]!;
  if (median <= 0) return null;

  // A spike is a day well above the median that is not simply more calls.
  const spikes = days.filter((d) => d.cost.total > median * 2.5);
  if (spikes.length === 0) return null;

  const worst = spikes.sort((a, b) => b.cost.total - a.cost.total)[0]!;
  const medianCalls =
    [...days.map((d) => d.calls)].sort((a, b) => a - b)[Math.floor(days.length / 2)]! || 1;
  const callRatio = worst.calls / medianCalls;
  const costRatio = worst.cost.total / median;
  // If cost rose roughly in line with volume, it is explained.
  const explainedByVolume = callRatio > 0 && costRatio / callRatio < 1.4;
  if (explainedByVolume) return null;

  const events = ctx.data.events.filter((e) => e.ts.slice(0, 10) === worst.key);
  const perCall = worst.calls > 0 ? worst.cost.total / worst.calls : 0;
  const overallPerCall = summary.avgCostPerCall;

  return build(ctx, {
    rule: "cost-spike",
    why: "A spike usually has one cause, such as a runaway loop or a huge input, and it recurs until that cause is found.",
    category: "anomaly",
    title: `Spend on ${worst.key} was ${costRatio.toFixed(1)}x the daily median`,
    detail: `${usd(worst.cost.total)} against a median day of ${usd(median)}, but only ${callRatio.toFixed(1)}x the usual call volume, so the cost per call rose to ${usd(perCall)} against ${usd(overallPerCall)} overall. Volume does not explain this one. optimAIzr cannot tell you why from usage data alone; it can only tell you it happened.`,
    currentUsd: worst.cost.total - median,
    optimizedUsd: worst.cost.total - median,
    events,
    advisory: true,
    evidence: evidence(
      "inferred",
      "Daily totals are measured; 'unexplained' means unexplained by call volume alone",
    ),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true,
    }),
    impact: "none",
    risk: "safe",
    severityOverride: "medium",
    assumptions: [
      "Call volume is the main thing that should move daily cost.",
      "A single unusual day may be entirely legitimate work.",
    ],
    calculation:
      "Days above 2.5x the median daily cost, excluding those where cost rose roughly in line with call volume.",
    observations: [
      `${worst.key}: ${usd(worst.cost.total)} across ${worst.calls} calls (${usd(perCall)}/call)`,
      `Median day: ${usd(median)} across ${medianCalls} calls`,
      ...spikes
        .filter((s) => s.key !== worst.key)
        .slice(0, 3)
        .map((s) => `${s.key}: ${usd(s.cost.total)} across ${s.calls} calls`),
    ],
    fix: "Check what changed that day: a new model, a longer prompt, a retry loop, or a backfill. `optimaizr show cost-spike` lists that day's priciest calls.",
  });
}

/** Rule: a model's rate changed inside or just after the analysed window. */
function pricingChange(ctx: Ctx): OptimizationFinding | null {
  const summary = summarize(ctx.data);

  for (const bucket of summary.byModel) {
    const price = priceFor(bucket.key);
    if (!price || price.rates.length < 2) continue;

    const events = ctx.data.events.filter((e) => e.model === bucket.key);
    if (events.length === 0) continue;

    let billed = 0;
    let atCurrentRates = 0;
    const now = new Date();

    for (const e of events) {
      const then = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
      const current = ratesFor(price, { at: now, speed: e.speed, batch: e.batch });
      const priceOut = (r: typeof then) =>
        (e.inputTokens * r.inputPerM +
          e.outputTokens * r.outputPerM +
          e.cacheReadTokens * r.cachedInputPerM +
          e.cacheWrite5mTokens * r.cacheWrite5mPerM +
          e.cacheWrite1hTokens * r.cacheWrite1hPerM) /
        M;
      billed += priceOut(then);
      atCurrentRates += priceOut(current);
    }

    const delta = atCurrentRates - billed;
    if (delta < 0.01) continue;

    const oldCard = price.rates[price.rates.length - 2]!;
    const newCard = price.rates[price.rates.length - 1]!;

    return build(ctx, {
      rule: "pricing-change",
      why: "The same traffic now costs a different amount, whatever you do.",
      category: "pricing",
      title: `${price.label} ${oldCard.label ?? "previous pricing"} ended ${oldCard.until ?? newCard.from}`,
      detail: `Your ${price.label} traffic in this window was largely billed at $${oldCard.inputPerM}/$${oldCard.outputPerM} per million. At the current $${newCard.inputPerM}/$${newCard.outputPerM} the same usage costs ${usd(atCurrentRates)} instead of ${usd(billed)}, a ${((delta / billed) * 100).toFixed(0)}% increase that arrives without any change on your side.`,
      currentUsd: delta,
      optimizedUsd: 0,
      events,
      advisory: true,
      evidence: evidence("measured", "Every call re-priced against both rate cards"),
      confidence: confidenceOf({
        measured: true,
        sample: events.length,
        tokenProfileStable: true,
      }),
      impact: "none",
      risk: "safe",
      severityOverride: "medium",
      assumptions: [
        "Future usage resembles the usage in this window.",
        "No further rate change lands in the meantime.",
      ],
      calculation:
        "Every call re-priced at the current rate card and compared with what it was actually billed at the time.",
      observations: [
        `${bucket.calls} calls · ${fmtTokens(bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens)} in / ${fmtTokens(bucket.outputTokens)} out`,
        `Same usage: ${usd(billed)} as billed vs ${usd(atCurrentRates)} at current rates`,
      ],
      fix: "Budget for the higher rate, and re-check the cheap-model and caching findings: they are worth proportionally more once the old rate lapses.",
    });
  }
  return null;
}

/**
 * Every detector. Entries are named so a failure can say which one failed
 * (minification rewrites `Function.name`).
 */
/* ------------------------------------------------------------------ *
 * Levers: trade-offs sized from the user's own usage
 * ------------------------------------------------------------------ */

/** What a lever's figure rests on: the arithmetic is solid, the outcome is untested. */
const LEVER_CONFIDENCE = {
  level: "low" as const,
  basis:
    "the arithmetic uses recorded tokens, but the saving depends on a change in how you work, and its effect on quality is untested; possible until a before/after shows it",
};

/** Compact here: the window Claude Code is set to (it accepts 100K to 1M). */
export const COMPACT_AT = 200_000;
/** What a compacted conversation starts again with: summary, system prompt, re-attached files. */
const AFTER_COMPACT = 40_000;
/** The summary a compaction writes. */
const SUMMARY_TOKENS = 8_000;
/** Below this share of calls over the window, long conversations are not a habit. */
const LONG_CALL_SHARE = 0.2;

/** The agents whose settings a lever can name. */
type Agent = "claude-code" | "codex";
const AGENTS: Agent[] = ["claude-code", "codex"];
const AGENT_NAME: Record<Agent, string> = { "claude-code": "Claude Code", codex: "Codex" };

function compactSetting(agent: Agent): string {
  return agent === "claude-code"
    ? `Claude Code: add "env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "${COMPACT_AT}" } to ~/.claude/settings.json`
    : `Codex: set model_auto_compact_token_limit = ${COMPACT_AT} in ~/.codex/config.toml`;
}

/**
 * Lever: compact earlier. Every call re-reads the conversation so far, and the
 * agents only compact near the model's window, so long sessions get dearer with
 * every call. Simulated per conversation: compact when it passes COMPACT_AT,
 * restart at AFTER_COMPACT, and pay for each compaction's summary and reload.
 */
function contextCompaction(ctx: Ctx): OptimizationFinding | null {
  const compactAt = `${Math.round(COMPACT_AT / 1000)}K`;
  const agents = AGENTS.filter((a) => {
    const calls = ctx.data.events.filter((e) => e.source === a);
    const long = calls.filter((e) => contextOf(e) > COMPACT_AT).length;
    return calls.length >= 50 && long / calls.length >= LONG_CALL_SHARE;
  });
  if (agents.length === 0) return null;
  const mine = ctx.data.events.filter((e) => agents.includes(e.source as Agent));
  const long = mine.filter((e) => contextOf(e) > COMPACT_AT).length;

  let saved = 0;
  let compactionCost = 0;
  let compactions = 0;
  let rereadUsd = 0;
  const events: UsageEvent[] = [];
  for (const conversation of contexts(ctx)) {
    const first = conversation[0];
    if (!first || !agents.includes(first.source as Agent) || first.isSubagent) continue;
    let dropped = 0;
    let last = 0;
    for (const e of conversation) {
      const price = priceFor(e.model);
      if (!price) continue;
      const r = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
      rereadUsd += (e.cacheReadTokens * r.cachedInputPerM) / M;
      const actual = contextOf(e);
      // The agent compacted on its own: the simulation starts over with it.
      if (actual < last * 0.5) dropped = 0;
      last = actual;
      if (actual - dropped > COMPACT_AT) {
        compactions++;
        compactionCost +=
          (COMPACT_AT * r.cachedInputPerM +
            SUMMARY_TOKENS * r.outputPerM +
            AFTER_COMPACT * (Math.max(r.inputPerM, r.cacheWrite5mPerM) - r.cachedInputPerM)) /
          M;
        dropped = actual - AFTER_COMPACT;
      }
      const fewer = Math.max(0, Math.min(dropped, actual - AFTER_COMPACT, e.cacheReadTokens));
      if (fewer > 0) {
        saved += (fewer * r.cachedInputPerM) / M;
        events.push(e);
      }
    }
  }
  const net = saved - compactionCost;
  if (net < 0.5 || events.length === 0) return null;

  const names = listOf(agents.map((a) => AGENT_NAME[a]));
  const sizes = mine.map(contextOf).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)]!;
  const p90 = sizes[Math.floor(sizes.length * 0.9)]!;
  const spend = mine.reduce((t, e) => t + e.cost.total, 0);
  const currentUsd = events.reduce((t, e) => t + e.cost.total, 0);

  return build(ctx, {
    rule: "context-compaction",
    why: `Every call re-reads the whole conversation, so each call costs more than the last: re-reading took ${spend > 0 ? Math.round((rereadUsd / spend) * 100) : 0}% of your ${names} spend.`,
    tier: "test",
    category: "context-bloat",
    title: `${Math.round((long / mine.length) * 100)}% of your ${names} calls carried over ${compactAt} of conversation`,
    detail: `Your median call re-read ${fmtTokens(median)} of conversation and 1 in 10 re-read ${fmtTokens(p90)}: ${agents.length > 1 ? "both agents compact" : `${names} compacts`} only near the model's context window. Compacting at ${compactAt} would have meant about ${compactions} compaction${compactions === 1 ? "" : "s"} and ${usd(net)} less over this window, after paying for them.`,
    currentUsd,
    optimizedUsd: currentUsd - net,
    events,
    evidence: evidence(
      "estimated",
      "Context sizes are measured; the compactions and what they keep are simulated",
    ),
    confidence: LEVER_CONFIDENCE,
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      `A compacted conversation starts again at about ${fmtTokens(AFTER_COMPACT)}: the summary, the system prompt and recently read files.`,
      `Each compaction costs one summary call over ${compactAt} of context, writing about ${fmtTokens(SUMMARY_TOKENS)} tokens, and one uncached reload of what remains.`,
      "The work after a compaction takes as many calls as it did. A summary can lose details from early in the conversation, which can cost calls back.",
      "Subagents are left out: they start with a fresh context.",
    ],
    calculation: `Each main conversation replayed in order: when its context passes ${compactAt}, it compacts to ${fmtTokens(AFTER_COMPACT)} and the compaction is charged; every later call re-reads that much less, priced at its own cache-read rate. Where the agent compacted on its own, the replay starts over from there.`,
    observations: [
      `median call: ${fmtTokens(median)} of conversation, 90th percentile: ${fmtTokens(p90)}`,
      `${compactions} compaction${compactions === 1 ? "" : "s"} at ${compactAt} would have cost ${usd(compactionCost)} and saved ${usd(saved)} of re-reading`,
    ],
    fix: `Compact at ${compactAt}. ${agents.map(compactSetting).join("; ")}. Or compact by hand (/compact) when you change topic. A summary can drop details from early in a long conversation, so try it for a week and compare.`,
  });
}

/** `claude-sonnet-5-5` -> `sonnet`, the alias Claude Code's /model and settings take. */
function familyAlias(modelId: string): string {
  return /haiku|sonnet|opus|fable/.exec(modelId.toLowerCase())?.[0] ?? modelId;
}

function defaultSetting(agent: Agent, target: ModelPrice): string {
  if (agent === "claude-code") {
    const alias = familyAlias(target.id);
    return `Claude Code: /model ${alias}, or "model": "${alias}" in ~/.claude/settings.json`;
  }
  return `Codex: model = "${target.id}" in ~/.codex/config.toml, or /model`;
}

/**
 * Lever: a smaller default model. Agent tasks on a frontier model that did no
 * heavy reasoning and did not get stuck, re-priced one tier down. Whether the
 * smaller model does them as well is the open question, so it is a test.
 */
function modelDefault(ctx: Ctx): OptimizationFinding | null {
  let before = 0;
  let after = 0;
  let frontierSpend = 0;
  const counted: Task[] = [];
  const targets = new Map<string, ModelPrice>();
  const sources = new Set<string>();
  const byAgent = new Map<Agent, ModelPrice>();
  for (const t of ctx.tasks) {
    if (!AGENTS.includes(t.source as Agent)) continue;
    const price = priceFor(t.model);
    if (!price || price.tier !== "frontier") continue;
    frontierSpend += t.costUsd;
    if (!t.done || t.kind === "reasoning" || t.kind === "debugging") continue;
    const target = downgradeTargetFor(t.model);
    if (!target || t.maxContext > target.contextTokens * 0.9) continue;
    for (const e of t.events) {
      const from = priceFor(e.model);
      const to = downgradeTargetFor(e.model);
      if (!from || !to) continue;
      const r = repriced(e, from, to);
      before += r.before;
      after += Math.min(r.after, r.before);
    }
    counted.push(t);
    targets.set(target.id, target);
    sources.add(price.label);
    if (!byAgent.has(t.source as Agent)) byAgent.set(t.source as Agent, target);
  }
  const saving = before - after;
  if (counted.length < 10 || saving < 0.5) return null;

  const events = counted.flatMap((t) => t.events);
  const names = listOf([...targets.values()].map((t) => t.label));
  const from = listOf([...sources]);
  const spentOn = counted.reduce((s, t) => s + t.costUsd, 0);
  const settings = AGENTS.filter((a) => byAgent.has(a)).map((a) =>
    defaultSetting(a, byAgent.get(a)!),
  );

  return build(ctx, {
    rule: "model-default",
    why: `${names} ${targets.size > 1 ? "do" : "does"} the same tokens for ${before > 0 ? Math.round((saving / before) * 100) : 0}% less, and work without heavy reasoning is where a smaller model most often keeps up.`,
    tier: "test",
    category: "model-selection",
    title: `${frontierSpend > 0 ? Math.round((spentOn / frontierSpend) * 100) : 0}% of your ${from} spend went to tasks without heavy reasoning`,
    detail: `${counted.length} tasks on ${from} (${kindMix(counted)}) thought for under ${fmtTokens(TASK_REASONING_TOKENS)} tokens and failed at most once. On ${names} the same tokens cost ${usd(after)} instead of ${usd(before)}, ${before > 0 ? Math.round((saving / before) * 100) : 0}% less, if ${names} does the work as well.`,
    currentUsd: before,
    optimizedUsd: after,
    events,
    evidence: evidence(
      "estimated",
      `Recorded tokens re-priced on ${names}; whether the work comes out as well is untested`,
    ),
    confidence: LEVER_CONFIDENCE,
    impact: "high",
    risk: "needs-verification",
    assumptions: [
      `${names} does these tasks as well, in a similar number of tokens.`,
      "Sessions start on the smaller model, so there is no cache reload; switching up for a hard task costs one.",
      "Tasks with heavy reasoning or repeated failures stay on the bigger model and are not counted.",
    ],
    calculation: `Every finished agent task on ${from} without heavy reasoning or repeated failures, each call re-priced one tier down (${names}) at the rates of its day.`,
    observations: [
      `${counted.length} of your ${from} tasks qualify: ${kindMix(counted)}`,
      `kept on ${from}: tasks with ${fmtTokens(TASK_REASONING_TOKENS)}+ thinking tokens or two or more failures`,
    ],
    fix: `Make the smaller model your default and switch up for debugging, design and hard problems. ${settings.join("; ")}. \`optimaizr verify model-default\` replays a sample of your own calls on it first${byAgent.has("claude-code") ? "; `optimaizr live --auto` with the mod switches Claude Code as you go" : ""}.`,
    candidate: {
      kind: "swap-model",
      to: targets.size === 1 ? [...targets.keys()][0] : undefined,
      targetFor: (modelId: string) => downgradeTargetFor(modelId)?.id,
      matches: (e) => {
        const task = ctx.taskOf.get(e.id);
        return task ? counted.includes(task) : false;
      },
      description: `Make ${names} the default for work without heavy reasoning`,
    },
  });
}

const RULES: Array<{ name: string; run: (ctx: Ctx) => OptimizationFinding | null }> = [
  { name: "pricing-change", run: pricingChange },
  { name: "cost-spike", run: costSpike },
  { name: "spend-concentration", run: spendConcentration },
  { name: "cache-churn", run: cacheChurn },
  { name: "repeated-context", run: repeatedContext },
  { name: "prompt-bloat", run: promptBloat },
  { name: "repeat-tool-calls", run: repeatToolCalls },
  { name: "model-fit", run: modelFit },
  { name: "reasoning-effort", run: thinkingSpend },
  { name: "oversized-input", run: oversizedInput },
  { name: "oversized-output", run: oversizedOutput },
  { name: "oversized-tool-output", run: oversizedResults },
  { name: "error-loops", run: errorLoops },
  { name: "context-compaction", run: contextCompaction },
  { name: "model-default", run: modelDefault },
];

/** What one analysis pass produced, including what went wrong during it. */
export interface AnalysisResult {
  findings: OptimizationFinding[];
  /** Detectors that threw. Empty on a clean run. */
  errors: AnalysisError[];
}

/**
 * Run every detector. A rule that throws is reported in `errors` rather than
 * swallowed, so "found nothing" and "crashed" can't look the same.
 */
export function analyze(data: Dataset): AnalysisResult {
  if (data.events.length === 0) return { findings: [], errors: [] };
  const ctx = buildCtx(data);
  const findings: OptimizationFinding[] = [];
  const errors: AnalysisError[] = [];

  for (const rule of RULES) {
    try {
      const f = rule.run(ctx);
      if (f) findings.push(f);
    } catch (err) {
      errors.push({
        rule: rule.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  findings.sort((a, b) => b.savings.monthlyUsd - a.savings.monthlyUsd);
  return { findings, errors };
}

/** One line naming a detector that failed, for a host's warning channel. */
export function ruleErrorWarning(e: AnalysisError): string {
  return `detector "${e.rule}" failed and was skipped - its findings are missing from this report: ${e.message}`;
}

/**
 * Findings only. Detector failures are added to `data.warnings`, which every
 * host already shows. Use `analyze` to get the errors as data.
 */
export function findWaste(data: Dataset): OptimizationFinding[] {
  const { findings, errors } = analyze(data);
  for (const e of errors) {
    const warning = ruleErrorWarning(e);
    // Analysing the same dataset twice must not stack duplicate warnings.
    if (!data.warnings.includes(warning)) data.warnings.push(warning);
  }
  return findings;
}

/**
 * The total saving once overlapping findings stop double-counting. Two rules
 * often claim the same call, so each call counts once, at its largest claim.
 * Fixing both would save a bit more, so this is a floor.
 */
export function recoverableWindow(
  findings: OptimizationFinding[],
  tiers: FindingTier | FindingTier[] = "fix",
): number {
  const { byEvent, unattributed } = recoverableByEvent(findings, tiers);
  let total = unattributed;
  for (const usd of byEvent.values()) total += usd;
  return total;
}

/**
 * The de-overlapped recoverable amount on each call, keyed by event id: the
 * per-call view of `recoverableWindow`, for totals over any subset of calls.
 * `unattributed` is what findings without call-level attribution claim. One
 * tier at a time: the headline is `fix`, and `test` levers are never totalled.
 */
export function recoverableByEvent(
  findings: OptimizationFinding[],
  tiers: FindingTier | FindingTier[] = "fix",
): {
  byEvent: Map<string, number>;
  unattributed: number;
} {
  const byEvent = new Map<string, number>();
  let unattributed = 0;

  const wanted = new Set(Array.isArray(tiers) ? tiers : [tiers]);
  for (const f of findings) {
    // A finding from before tiers existed is treated as clear waste.
    if (f.advisory || !wanted.has(f.tier ?? "fix")) continue;
    if (f.claimByEvent.size === 0) {
      // No per-call attribution, so nothing can overlap with it: count it whole.
      unattributed += f.savings.windowUsd;
      continue;
    }
    for (const [id, usd] of f.claimByEvent) {
      if (usd > (byEvent.get(id) ?? 0)) byEvent.set(id, usd);
    }
  }
  return { byEvent, unattributed };
}

/** The days window amounts are divided by for a daily rate. Shared by every finding in a pass. */
function windowDaysOf(findings: OptimizationFinding[]): number {
  for (const f of findings) {
    const days = f.savings.projectionDays ?? f.savings.windowDays;
    if (days > 0) return days;
  }
  return 1;
}

/** Total recoverable saving per month for one tier, de-overlapped and excluding advisories. */
export function recoverableMonthly(
  findings: OptimizationFinding[],
  tiers: FindingTier | FindingTier[] = "fix",
): number {
  return (recoverableWindow(findings, tiers) / windowDaysOf(findings)) * MONTH_DAYS;
}

export function recoverableAnnual(
  findings: OptimizationFinding[],
  tiers: FindingTier | FindingTier[] = "fix",
): number {
  return (recoverableWindow(findings, tiers) / windowDaysOf(findings)) * YEAR_DAYS;
}

/**
 * What `try` findings add on top of clear waste, per month: fix and try
 * combined (each call once) minus fix alone, so "+$X" never counts a call twice.
 */
export function likelyMonthly(findings: OptimizationFinding[]): number {
  return Math.max(
    0,
    recoverableMonthly(findings, ["fix", "try"]) - recoverableMonthly(findings, "fix"),
  );
}

/** Where two or more detectors claim the same calls. */
export interface SavingsOverlap {
  /** What the findings come to when simply added up. Not the headline figure. */
  naiveWindowUsd: number;
  /** What survives combining per call. This is what the headline reports. */
  recoverableWindowUsd: number;
  /** The double-count that was removed: naive minus recoverable. */
  removedWindowUsd: number;
  /** Which detectors contend for the same calls, largest removal first. */
  contended: Array<{ rules: string[]; calls: number; windowUsd: number }>;
}

/** Explains the gap between the findings added up and the headline total. */
export function savingsOverlap(
  findings: OptimizationFinding[],
  tiers: FindingTier[] = ["fix", "try"],
): SavingsOverlap {
  const active = findings.filter((f) => !f.advisory && tiers.includes(f.tier ?? "fix"));

  const claimants = new Map<string, OptimizationFinding[]>();
  for (const f of active) {
    for (const id of f.claimByEvent.keys()) {
      const list = claimants.get(id);
      if (list) list.push(f);
      else claimants.set(id, [f]);
    }
  }

  const groups = new Map<string, { rules: string[]; calls: number; windowUsd: number }>();
  for (const [id, contenders] of claimants) {
    if (contenders.length < 2) continue;
    const claims = contenders.map((f) => f.claimByEvent.get(id) ?? 0);
    const dropped = claims.reduce((s, c) => s + c, 0) - Math.max(...claims);
    const rules = contenders.map((f) => f.rule).sort();
    const key = rules.join(" + ");
    const g = groups.get(key) ?? { rules, calls: 0, windowUsd: 0 };
    g.calls++;
    g.windowUsd += dropped;
    groups.set(key, g);
  }

  const naiveWindowUsd = active.reduce((s, f) => s + f.savings.windowUsd, 0);
  const recoverableWindowUsd = recoverableWindow(findings, tiers);

  return {
    naiveWindowUsd,
    recoverableWindowUsd,
    removedWindowUsd: Math.max(0, naiveWindowUsd - recoverableWindowUsd),
    contended: [...groups.values()].sort((a, b) => b.windowUsd - a.windowUsd),
  };
}

export const RULE_COUNT = RULES.length;
