import { modelLabel } from "../pricing.js";
import type { CompactionRecord, OptimizationFinding, UsageEvent } from "../domain/types.js";
import { coldResumes } from "./cold.js";
import { COMPACT_AT } from "./rules.js";
import { contextOf } from "./tasks.js";

/**
 * Did a change work? Each applied change splits the usage at the moment it was
 * made, and the days after it are compared with the days before. Everything is
 * a rate (per prompt, per call, per active day), so periods of different
 * lengths compare.
 */

export const RESULTS_SCHEMA = "optimaizr.results/1";

const DAY = 86_400_000;
/** The baseline is at least two weeks, so one odd day doesn't set it. */
export const BASELINE_MIN_DAYS = 14;
/** And at most 30: Claude Code deletes transcripts after 30 days by default. */
export const BASELINE_MAX_DAYS = 30;
/** A reading needs this much after the change. */
export const READY_ACTIVE_DAYS = 3;
export const READY_PROMPTS = 100;
/** Apps and imports have no prompts, only calls. */
export const READY_CALLS = 300;
/** Before a week, weekday habits can still swing the number. */
export const SETTLED_DAYS = 7;
/** Shorter baselines checked against the full one. */
const SHORT_BASELINES = [3, 5, 7];
/** Cost per prompt has to move this much either way to count as an effect. */
export const EFFECT = 0.1;

export interface AppliedChange {
  /** Stable across runs: the rule, who it covers and when it was made. */
  id: string;
  rule: string;
  /** Whose calls it touches; absent for every source. */
  source?: UsageEvent["source"];
  /** One project only, the way a model override is scoped. */
  project?: string;
  /** A model override on subagents (true) or the main thread (false) only. */
  subagent?: boolean;
  from?: string;
  to?: string;
  /** What was written, like "200000" for the compaction point. */
  value?: string;
  /** "optimaizr" when optimAIzr made the change, "by-hand" when you said you did. */
  how: "optimaizr" | "by-hand";
  at: string;
  /** When it was undone or replaced, which ends the after period. */
  until?: string;
}

export type ResultVerdict = "too-early" | "no-baseline" | "working" | "no-change" | "worse";

export interface ResultRow {
  key: string;
  label: string;
  unit: "usd" | "share" | "tokens" | "count" | "minutes";
  before: number | null;
  after: number | null;
  /** Relative change, or the difference in points for a share; null without both sides. */
  change: number | null;
  better: "lower" | "higher";
  /** Something the change can cost you, watched apart from the saving. */
  tradeOff?: boolean;
  /** A trade-off that moved the wrong way by enough to mention. */
  worse?: boolean;
}

export interface Period {
  from: string;
  to: string;
  days: number;
  activeDays: number;
  calls: number;
  prompts: number;
  conversations: number;
  costUsd: number;
}

/** Plain counts since the change, true from the first conversation on. */
export interface SinceFact {
  key: string;
  value: number;
  text: string;
}

export interface NextStep {
  command: string;
  why: string;
}

export interface ChangeResult {
  change: AppliedChange;
  verdict: ResultVerdict;
  /** Working, but a trade-off moved the wrong way. */
  withCost: boolean;
  /** Less than a week in: the number can still swing. */
  early: boolean;
  /** What the verdict is judged on: cost per prompt, or per call without prompts. */
  measure: "prompt" | "call";
  headline: ResultRow | null;
  before: Period;
  after: Period;
  rows: ResultRow[];
  since: SinceFact[];
  progress: {
    activeDays: number;
    count: number;
    needActiveDays: number;
    needCount: number;
    /** When there should be enough for a first reading, as a YYYY-MM-DD. */
    readyAround?: string;
  };
  /**
   * The headline against the full baseline and each shorter one inside it,
   * lowest and highest, so a reading that depends on the baseline shows it.
   */
  range: { low: number; high: number; shortest: number; longest: number } | null;
  /** What the change saved since it was made, at the measured rate. Negative when it cost more. */
  measuredSavingUsd: number | null;
  caveats: string[];
  next: NextStep[];
}

export interface ResultsReport {
  schema: typeof RESULTS_SCHEMA;
  generatedAt: string;
  results: ChangeResult[];
}

export interface ResultsInput {
  events: readonly UsageEvent[];
  compactions?: readonly CompactionRecord[];
}

/** How many days of history `measureResults` needs for these changes. */
export function resultsDays(changes: readonly AppliedChange[], now = Date.now()): number {
  const first = Math.min(...changes.map((c) => Date.parse(c.at)), now);
  return Math.ceil((now - first) / DAY) + BASELINE_MAX_DAYS + 1;
}

export function measureResults(
  input: ResultsInput,
  changes: readonly AppliedChange[],
  opts: { now?: number } = {},
): ResultsReport {
  const now = opts.now ?? Date.now();
  const results: ChangeResult[] = [];
  for (const change of [...changes].sort((a, b) => b.at.localeCompare(a.at))) {
    const r = measureChange(input, change, { now, others: changes });
    if (r) results.push(r);
  }
  return { schema: RESULTS_SCHEMA, generatedAt: new Date(now).toISOString(), results };
}

/* ------------------------------------------------------------------ *
 * One change
 * ------------------------------------------------------------------ */

const inScope = (c: AppliedChange) => (e: { source: string; project: string }) =>
  (!c.source || e.source === c.source) && (!c.project || e.project === c.project);

const within = (lo: number, hi: number) => (x: { ts: string }) => {
  const t = Date.parse(x.ts);
  return t >= lo && t < hi;
};

/** Same lever, same agent and place: a later one replaces it. */
export function sameLever(a: AppliedChange, b: AppliedChange): boolean {
  return (
    a.rule === b.rule &&
    a.source === b.source &&
    a.project === b.project &&
    a.subagent === b.subagent &&
    a.from === b.from
  );
}

/**
 * Rules a change still in place already takes care of: most of the spend the
 * finding flagged is on the agent and project the change was made for.
 */
export function coveredRules(
  findings: readonly OptimizationFinding[],
  events: readonly UsageEvent[],
  changes: readonly AppliedChange[],
): Set<string> {
  const covered = new Set<string>();
  for (const f of findings) {
    const open = changes.filter((c) => c.rule === f.rule && !c.until);
    if (open.length === 0) continue;
    const hit = events.filter((e) => f.affects(e));
    const total = hit.reduce((s, e) => s + e.cost.total, 0);
    const inside = hit
      .filter((e) => open.some((c) => inScope(c)(e)))
      .reduce((s, e) => s + e.cost.total, 0);
    if (total <= 0 || inside >= total / 2) covered.add(f.rule);
  }
  return covered;
}

/**
 * Measure one change, or null when its agent has no calls on either side of it
 * (Codex set alongside Claude Code by someone who never runs Codex).
 */
export function measureChange(
  input: ResultsInput,
  change: AppliedChange,
  opts: { now?: number; others?: readonly AppliedChange[] } = {},
): ChangeResult | null {
  const now = opts.now ?? Date.now();
  const others = (opts.others ?? []).filter((o) => o.id !== change.id);
  const at = Date.parse(change.at);
  const end = Math.min(now, change.until ? Date.parse(change.until) : now);
  const afterDays = Math.max(0, (end - at) / DAY);

  // Against the setting it replaced, not a mix of both.
  const replaced = others
    .filter((o) => sameLever(o, change) && Date.parse(o.at) < at)
    .map((o) => Date.parse(o.at));
  const baseDays = Math.min(BASELINE_MAX_DAYS, Math.max(BASELINE_MIN_DAYS, afterDays));
  const lo = Math.max(at - baseDays * DAY, ...replaced);

  const scoped = input.events.filter(inScope(change));
  const before = scoped.filter(within(lo, at));
  const after = scoped.filter(within(at, end));
  if (before.length === 0 && after.length === 0) return null;
  const comps = (input.compactions ?? []).filter(inScope(change));
  const compsBefore = comps.filter(within(lo, at));
  const compsAfter = comps.filter(within(at, end));

  const b = periodOf(before, lo, at);
  const a = periodOf(after, at, end);
  // Agent transcripts have prompts; apps and imports only have calls.
  const measure: "prompt" | "call" = b.prompts + a.prompts > 0 ? "prompt" : "call";
  const countOf = (p: Period) => (measure === "prompt" ? p.prompts : p.calls);
  const need = measure === "prompt" ? READY_PROMPTS : READY_CALLS;

  const rows = markTradeOffs([
    ...generalRows(before, after, b, a, measure),
    ...leverRows(change, scoped, before, after, b, a, compsBefore, compsAfter),
  ]);
  const headline = rows[0] ?? null;

  const ready = a.activeDays >= READY_ACTIVE_DAYS && countOf(a) >= need;
  const baseline = b.activeDays >= READY_ACTIVE_DAYS && countOf(b) >= need / 2;
  const withCost = rows.some((r) => r.worse);
  let verdict: ResultVerdict;
  if (!ready) verdict = "too-early";
  else if (!baseline) verdict = "no-baseline";
  else if (headline?.change == null) verdict = "no-change";
  else if (headline.change <= -EFFECT) verdict = "working";
  else if (headline.change >= EFFECT) verdict = "worse";
  else verdict = "no-change";

  const rate = (p: Period) => (countOf(p) > 0 ? p.costUsd / countOf(p) : null);
  const rb = rate(b);
  const ra = rate(a);
  const measuredSavingUsd =
    ready && baseline && rb !== null && ra !== null ? (rb - ra) * countOf(a) : null;
  const vs = verdict === "too-early" ? [] : againstBaselines(scoped, after, b, lo, at);

  return {
    change,
    verdict,
    withCost: verdict === "working" && withCost,
    early: ready && afterDays < SETTLED_DAYS,
    measure,
    headline,
    before: b,
    after: a,
    rows,
    since: sinceFacts(change, scoped, after, a, compsAfter),
    progress: {
      activeDays: a.activeDays,
      count: countOf(a),
      needActiveDays: READY_ACTIVE_DAYS,
      needCount: need,
      readyAround: ready ? undefined : readyAround(a, countOf(a), need, at, now),
    },
    range: ready && baseline && vs.length > 1 ? rangeOf(vs) : null,
    measuredSavingUsd,
    caveats: verdict === "too-early" ? [] : caveats(change, scoped, vs, b, a, at, lo, end, others),
    next: nextSteps(change, verdict, rows),
  };
}

function periodOf(events: readonly UsageEvent[], lo: number, hi: number): Period {
  const main = events.filter((e) => !e.isSubagent);
  return {
    from: new Date(lo).toISOString(),
    to: new Date(hi).toISOString(),
    days: Math.max(0, (hi - lo) / DAY),
    activeDays: new Set(events.map((e) => e.ts.slice(0, 10))).size,
    calls: events.length,
    prompts: new Set(main.flatMap((e) => (e.turnId ? [e.turnId] : []))).size,
    conversations: new Set(main.map((e) => e.sessionId)).size,
    costUsd: events.reduce((s, e) => s + e.cost.total, 0),
  };
}

function row(
  key: string,
  label: string,
  unit: ResultRow["unit"],
  before: number | null,
  after: number | null,
  better: ResultRow["better"] = "lower",
  tradeOff = false,
): ResultRow {
  let change: number | null = null;
  if (before !== null && after !== null) {
    if (unit === "share") change = after - before;
    else if (before > 0) change = after / before - 1;
  }
  // A share moving 10 points, or anything else 25%, the wrong way.
  const wrongWay = change !== null && (better === "lower" ? change : -change);
  const worse =
    tradeOff && wrongWay !== false && wrongWay >= (unit === "share" ? 0.1 : 0.25)
      ? true
      : undefined;
  return {
    key,
    label,
    unit,
    before,
    after,
    change,
    better,
    ...(tradeOff ? { tradeOff } : {}),
    ...(worse ? { worse } : {}),
  };
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

function errorsOf(events: readonly UsageEvent[]): number {
  return events.reduce((s, e) => s + e.tools.filter((t) => t.isError).length, 0);
}

function generalRows(
  before: readonly UsageEvent[],
  after: readonly UsageEvent[],
  b: Period,
  a: Period,
  measure: "prompt" | "call",
): ResultRow[] {
  const perCall = row(
    "costPerCall",
    "cost per call",
    "usd",
    ratio(b.costUsd, b.calls),
    ratio(a.costUsd, a.calls),
  );
  if (measure === "call") return [perCall];
  return [
    row(
      "costPerPrompt",
      "cost per prompt",
      "usd",
      ratio(b.costUsd, b.prompts),
      ratio(a.costUsd, a.prompts),
    ),
    perCall,
    row(
      "callsPerPrompt",
      "calls per prompt",
      "count",
      ratio(b.calls, b.prompts),
      ratio(a.calls, a.prompts),
    ),
    row(
      "errorsPerPrompt",
      "tool errors per prompt",
      "count",
      ratio(errorsOf(before), b.prompts),
      ratio(errorsOf(after), a.prompts),
    ),
  ];
}

/**
 * Any change can make the agent work harder for the same answer: a smaller
 * model, less effort, or a summary that lost what it had read.
 */
function markTradeOffs(rows: ResultRow[]): ResultRow[] {
  return rows.map((r) =>
    r.key === "callsPerPrompt" || r.key === "errorsPerPrompt"
      ? row(r.key, r.label, r.unit, r.before, r.after, r.better, true)
      : r,
  );
}

/** The point a compaction change set, in tokens. */
export function compactPointOf(change: AppliedChange): number {
  const n = Number(change.value);
  return Number.isFinite(n) && n > 0 ? n : COMPACT_AT;
}

/** File tools by agent: Claude Code's Read and opencode's read. */
const READ_TOOLS = new Set(["Read", "read"]);

/**
 * Files read again after each compaction, one count per compaction: files the
 * conversation had already worked on before the summary and read after it,
 * up to the next one. Main thread only.
 */
export function filesReadAgain(
  events: readonly UsageEvent[],
  comps: readonly CompactionRecord[],
): number[] {
  const bySession = new Map<string, { t: number; target: string; read: boolean }[]>();
  for (const e of events) {
    if (e.isSubagent) continue;
    for (const tool of e.tools) {
      if (!tool.target) continue;
      const list = bySession.get(e.sessionId) ?? [];
      list.push({ t: Date.parse(e.ts), target: tool.target, read: READ_TOOLS.has(tool.name) });
      bySession.set(e.sessionId, list);
    }
  }
  const times = new Map<string, number[]>();
  for (const c of comps)
    times.set(c.sessionId, [...(times.get(c.sessionId) ?? []), Date.parse(c.ts)]);
  return comps.map((c) => {
    const at = Date.parse(c.ts);
    const next = Math.min(...(times.get(c.sessionId) ?? []).filter((t) => t > at), Infinity);
    const uses = bySession.get(c.sessionId) ?? [];
    const known = new Set(uses.filter((u) => u.t < at).map((u) => u.target));
    const again = new Set(
      uses
        .filter((u) => u.read && u.t >= at && u.t < next && known.has(u.target))
        .map((u) => u.target),
    );
    return again.size;
  });
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function leverRows(
  change: AppliedChange,
  scoped: readonly UsageEvent[],
  before: readonly UsageEvent[],
  after: readonly UsageEvent[],
  b: Period,
  a: Period,
  compsBefore: readonly CompactionRecord[],
  compsAfter: readonly CompactionRecord[],
): ResultRow[] {
  const mainB = before.filter((e) => !e.isSubagent);
  const mainA = after.filter((e) => !e.isSubagent);

  if (change.rule === "context-compaction") {
    const point = compactPointOf(change);
    const past = (es: UsageEvent[]) =>
      ratio(es.filter((e) => contextOf(e) > point).length, es.length);
    const rows = [
      row(
        "callsPastPoint",
        `calls past ${Math.round(point / 1000)}K`,
        "share",
        past(mainB),
        past(mainA),
      ),
      row(
        "medianContext",
        "median context",
        "tokens",
        median(mainB.map(contextOf)),
        median(mainA.map(contextOf)),
      ),
    ];
    // Too few compactions on either side and these rows are noise.
    if (compsBefore.length + compsAfter.length >= 3) {
      const midTask = (cs: readonly CompactionRecord[]) =>
        cs.length > 0 ? cs.filter((c) => c.midTask).length / cs.length : null;
      const waiting = (cs: readonly CompactionRecord[], p: Period) =>
        ratio(cs.reduce((s, c) => s + (c.durationMs ?? 0), 0) / 60_000, p.activeDays);
      rows.push(
        row(
          "compactionsPerDay",
          "compactions a day",
          "count",
          ratio(compsBefore.length, b.activeDays),
          ratio(compsAfter.length, a.activeDays),
          "lower",
          true,
        ),
        row(
          "midTaskShare",
          "landed mid-task",
          "share",
          midTask(compsBefore),
          midTask(compsAfter),
          "lower",
          true,
        ),
      );
      // Only agents that name the file they read can say what was read again.
      if (scoped.some((e) => e.tools.some((t) => t.target))) {
        rows.push(
          row(
            "readAgainPerDay",
            "files read again after summaries a day",
            "count",
            ratio(sum(filesReadAgain(scoped, compsBefore)), b.activeDays),
            ratio(sum(filesReadAgain(scoped, compsAfter)), a.activeDays),
            "lower",
            true,
          ),
        );
      }
      // Codex doesn't record how long a summary took, so there is nothing to add up.
      if ([...compsBefore, ...compsAfter].some((c) => c.durationMs !== undefined)) {
        rows.push(
          row(
            "waitingPerDay",
            "waiting for summaries a day",
            "minutes",
            waiting(compsBefore, b),
            waiting(compsAfter, a),
            "lower",
            true,
          ),
        );
      }
    }
    return rows;
  }

  if (change.to) {
    const narrowed = (es: readonly UsageEvent[]) =>
      change.subagent === undefined
        ? es
        : es.filter((e) => Boolean(e.isSubagent) === change.subagent);
    const on = (es: readonly UsageEvent[]) => {
      const n = narrowed(es);
      return ratio(n.filter((e) => e.model === change.to).length, n.length);
    };
    return [
      row(
        "onNewModel",
        `calls on ${modelLabel(change.to)}`,
        "share",
        on(before),
        on(after),
        "higher",
      ),
    ];
  }

  if (change.rule === "reasoning-effort") {
    const thinking = (es: UsageEvent[]) =>
      ratio(
        es.reduce((s, e) => s + e.thinkingTokens, 0),
        es.length,
      );
    return [
      row("thinkingPerCall", "reasoning per call", "tokens", thinking(mainB), thinking(mainA)),
    ];
  }

  if (change.rule === "heavy-start") {
    const firsts = (es: UsageEvent[]) => {
      const first = new Map<string, UsageEvent>();
      for (const e of es) {
        const seen = first.get(e.sessionId);
        if (!seen || e.ts < seen.ts) first.set(e.sessionId, e);
      }
      return median([...first.values()].map(contextOf));
    };
    return [
      row("firstCall", "first call of a conversation", "tokens", firsts(mainB), firsts(mainA)),
    ];
  }

  if (change.rule === "cold-resume") {
    const perDay = (es: UsageEvent[], p: Period) => ratio(coldResumes(es).length, p.activeDays);
    return [
      row("coldPerDay", "expired-cache returns a day", "count", perDay(mainB, b), perDay(mainA, a)),
    ];
  }
  return [];
}

function sinceFacts(
  change: AppliedChange,
  scoped: readonly UsageEvent[],
  after: readonly UsageEvent[],
  a: Period,
  compsAfter: readonly CompactionRecord[],
): SinceFact[] {
  const plural = (n: number, one: string, many = `${one}s`) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const facts: SinceFact[] = [];
  if (a.prompts > 0) {
    facts.push({
      key: "conversations",
      value: a.conversations,
      text: plural(a.conversations, "conversation"),
    });
    facts.push({ key: "prompts", value: a.prompts, text: plural(a.prompts, "prompt") });
  } else {
    facts.push({ key: "calls", value: a.calls, text: plural(a.calls, "call") });
  }
  const main = after.filter((e) => !e.isSubagent);
  if (change.rule === "context-compaction") {
    const point = compactPointOf(change);
    const at = median(compsAfter.map((c) => c.preTokens));
    facts.push({
      key: "compactions",
      value: compsAfter.length,
      text: `${plural(compsAfter.length, "compaction")}${at ? `, fired at ${Math.round(at / 1000)}K on the median` : ""}`,
    });
    if (compsAfter.length > 0 && scoped.some((e) => e.tools.some((t) => t.target))) {
      const again = sum(filesReadAgain(scoped, compsAfter));
      facts.push({
        key: "filesReadAgain",
        value: again,
        text: `${plural(again, "file")} read again after them`,
      });
    }
    const past = main.filter((e) => contextOf(e) > point).length;
    facts.push({
      key: "callsPastPoint",
      value: past,
      text: `${plural(past, "call")} past ${Math.round(point / 1000)}K`,
    });
  } else if (change.to) {
    const on = after.filter((e) => e.model === change.to).length;
    facts.push({
      key: "callsOnNewModel",
      value: on,
      text: `${plural(on, "call")} on ${modelLabel(change.to)}`,
    });
  } else if (change.rule === "cold-resume") {
    const cold = coldResumes(main).length;
    facts.push({
      key: "coldReturns",
      value: cold,
      text: plural(cold, "return to an expired cache", "returns to an expired cache"),
    });
  }
  return facts;
}

function readyAround(
  a: Period,
  count: number,
  need: number,
  at: number,
  now: number,
): string | undefined {
  const elapsed = Math.max(1, (now - at) / DAY);
  // At the pace so far; with nothing yet, assume a few days.
  const forDays =
    a.activeDays >= READY_ACTIVE_DAYS
      ? 0
      : a.activeDays > 0
        ? (READY_ACTIVE_DAYS - a.activeDays) / (a.activeDays / elapsed)
        : READY_ACTIVE_DAYS;
  const forCount =
    count >= need ? 0 : count > 0 ? (need - count) / (count / elapsed) : READY_ACTIVE_DAYS;
  const days = Math.max(1, Math.ceil(Math.max(forDays, forCount)));
  // Further out than this, the pace so far says little about when.
  if (days > 21) return undefined;
  return new Date(now + days * DAY).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * What else could explain the difference
 * ------------------------------------------------------------------ */

/** The key whose share of spend grew most, and how far all of them moved together. */
function mixShift(
  before: readonly UsageEvent[],
  after: readonly UsageEvent[],
  keyOf: (e: UsageEvent) => string,
): { key: string; from: number; to: number; moved: number } | null {
  const shares = (es: readonly UsageEvent[]) => {
    const total = es.reduce((s, e) => s + e.cost.total, 0);
    const m = new Map<string, number>();
    if (total <= 0) return m;
    for (const e of es) m.set(keyOf(e), (m.get(keyOf(e)) ?? 0) + e.cost.total / total);
    return m;
  };
  const sb = shares(before);
  const sa = shares(after);
  if (sb.size === 0 || sa.size === 0) return null;
  let moved = 0;
  let top: { key: string; from: number; to: number } | null = null;
  for (const key of new Set([...sb.keys(), ...sa.keys()])) {
    const from = sb.get(key) ?? 0;
    const to = sa.get(key) ?? 0;
    moved += Math.abs(to - from) / 2;
    // Named by what grew, which reads as what you did instead.
    if (!top || to - from > top.to - top.from) top = { key, from, to };
  }
  return top ? { ...top, moved } : null;
}

const pctOf = (x: number) => `${Math.round(x * 100)}%`;

function projectLabel(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Cost per prompt, or per call without prompts. */
function costPerUnit(es: readonly UsageEvent[]): number | null {
  const p = periodOf(es, 0, 0);
  const n = p.prompts > 0 ? p.prompts : p.calls;
  return n > 0 ? p.costUsd / n : null;
}

/** The change against the full baseline first, then each shorter one that fits inside it. */
function againstBaselines(
  scoped: readonly UsageEvent[],
  after: readonly UsageEvent[],
  b: Period,
  lo: number,
  at: number,
): { days: number; vs: number }[] {
  const full = costPerUnit(scoped.filter(within(lo, at)));
  const now = costPerUnit(after);
  if (!full || !now) return [];
  const out = [{ days: b.days, vs: now / full - 1 }];
  for (const days of SHORT_BASELINES) {
    if (days >= b.days - 1) continue;
    const short = costPerUnit(scoped.filter(within(Math.max(lo, at - days * DAY), at)));
    if (short) out.push({ days, vs: now / short - 1 });
  }
  return out;
}

function rangeOf(vs: readonly { days: number; vs: number }[]): NonNullable<ChangeResult["range"]> {
  const all = vs.map((v) => v.vs);
  const days = vs.map((v) => v.days);
  return {
    low: Math.min(...all),
    high: Math.max(...all),
    shortest: Math.min(...days),
    longest: Math.max(...days),
  };
}

function caveats(
  change: AppliedChange,
  scoped: readonly UsageEvent[],
  vs: readonly { days: number; vs: number }[],
  b: Period,
  a: Period,
  at: number,
  lo: number,
  end: number,
  others: readonly AppliedChange[],
): string[] {
  const out: string[] = [];
  const before = scoped.filter(within(lo, at));
  const after = scoped.filter(within(at, end));
  // A shorter baseline should agree. The one that disagrees most is reported,
  // since a caveat that errs is better than a saving that doesn't hold.
  const [full, ...shorter] = vs;
  let widest: { days: number; vs: number } | null = null;
  for (const s of shorter) {
    if (!widest || Math.abs(s.vs - full!.vs) > Math.abs(widest.vs - full!.vs)) widest = s;
  }
  if (full && widest && Math.abs(widest.vs - full.vs) > 0.1) {
    out.push(
      `Against just the ${widest.days} days before the change it is ${signed(widest.vs)} instead of ${signed(full.vs)}, so part of the difference may have been under way already.`,
    );
  }

  if (!change.project) {
    const shift = mixShift(before, after, (e) => e.project);
    if (shift && shift.moved >= 0.15) {
      out.push(
        `You worked on different projects: ${projectLabel(shift.key)} went from ${pctOf(shift.from)} to ${pctOf(shift.to)} of the spend. Some of the difference is that.`,
      );
    }
  }
  if (!change.to) {
    const shift = mixShift(before, after, (e) => e.model);
    if (shift && shift.moved >= 0.2) {
      out.push(
        `Your model mix changed: ${modelLabel(shift.key)} went from ${pctOf(shift.from)} to ${pctOf(shift.to)} of the spend. Some of the difference is that.`,
      );
    }
  }

  const total = before.concat(after).reduce((s, e) => s + e.cost.total, 0);
  const overlaps = others.filter((o) => {
    const t = Date.parse(o.at);
    if (t < lo || t >= end || sameLever(o, change)) return false;
    if (o.source && change.source && o.source !== change.source) return false;
    if (!o.project || change.project) return true;
    // A change to one small project barely touches the rest.
    const there = before.concat(after).filter((e) => e.project === o.project);
    return total > 0 && there.reduce((s, e) => s + e.cost.total, 0) / total >= 0.1;
  });
  for (const o of overlaps) {
    out.push(
      `Another change landed in this period (${o.rule}, ${o.at.slice(0, 10)}), so the difference carries both.`,
    );
  }

  // Logs that start well after the baseline was meant to.
  const first = before.length ? Math.min(...before.map((e) => Date.parse(e.ts))) : null;
  const wanted = Math.min(BASELINE_MIN_DAYS, b.days);
  if (first !== null && (at - first) / DAY < wanted - 2) {
    const kept =
      change.source === "claude-code"
        ? " Claude Code deletes transcripts after 30 days unless cleanupPeriodDays is set higher."
        : "";
    out.push(
      `Only ${Math.max(1, Math.round((at - first) / DAY))} days of logs before the change, not ${Math.round(wanted)}.${kept}`,
    );
  }
  return out;
}

function signed(x: number): string {
  const p = Math.round(x * 100);
  return p < 0 ? `${-p}% less` : `${p}% more`;
}

/* ------------------------------------------------------------------ *
 * What to do next
 * ------------------------------------------------------------------ */

function nextSteps(change: AppliedChange, verdict: ResultVerdict, rows: ResultRow[]): NextStep[] {
  const out: NextStep[] = [];
  const undo = { command: `optimaizr undo ${change.rule}`, why: "put it back" };
  if (verdict === "worse") out.push({ ...undo, why: "it costs more than before" });

  if (change.rule === "context-compaction" && !change.until) {
    const busier = rows.some(
      (r) => (r.key === "compactionsPerDay" || r.key === "midTaskShare") && r.worse,
    );
    const point = compactPointOf(change);
    if (busier && point < 1_000_000) {
      const later = Math.min(1_000_000, point + 100_000);
      out.push({
        command: `optimaizr apply context-compaction --at ${Math.round(later / 1000)}K`,
        why: "compacting a little later means fewer summaries",
      });
    }
  }
  if (verdict !== "worse" && !change.until) out.push(undo);
  return out;
}
