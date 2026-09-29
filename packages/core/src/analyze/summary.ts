import { addCost, emptyCost, priceFor, ratesFor } from "../pricing.js";
import type { CostBreakdown } from "../pricing.js";
import type { CallEvent, Dataset } from "../types.js";

export interface Bucket {
  key: string;
  calls: number;
  cost: CostBreakdown;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache writes at the 5-minute TTL, billed at 1.25x the input rate. */
  cacheWrite5mTokens: number;
  /** Cache writes at the 1-hour TTL, billed at 2x the input rate. */
  cacheWrite1hTokens: number;
  thinkingTokens: number;
}

/**
 * Which calendar day buckets use. UTC by default so two machines agree; it's
 * also the usual reason a daily figure differs from another tool's, so the
 * report always prints the zone it used.
 */
export type DayTimeZone = "UTC" | "local" | (string & {});

export interface SummaryOptions {
  /** `"UTC"` (default), `"local"`, or an IANA zone such as `"Europe/Berlin"`. */
  timeZone?: DayTimeZone;
}

/** The IANA zone a `DayTimeZone` resolves to, for display. */
export function resolveTimeZone(tz: DayTimeZone = "UTC"): string {
  if (tz === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return tz;
}

/**
 * The `YYYY-MM-DD` a timestamp falls on in a zone. Built from `formatToParts`
 * because locale formats vary by ICU build (`en-CA` can render `09/02/2026`).
 * An unusable zone falls back to UTC instead of throwing.
 */
export function dayKeyIn(ts: string, tz: DayTimeZone = "UTC"): string {
  const zone = resolveTimeZone(tz);
  if (zone === "UTC") return ts.slice(0, 10);
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return ts.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y.length !== 4 || m.length !== 2 || d.length !== 2) return ts.slice(0, 10);
    return `${y}-${m}-${d}`;
  } catch {
    return ts.slice(0, 10);
  }
}

/** A single call singled out for being unusually expensive or large. */
export interface TopCall {
  id: string;
  ts: string;
  model: string;
  provider: string;
  project: string;
  route?: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
}

/**
 * Monthly figures project the last 30 days, not the whole history, so a user
 * whose spend jumped this month isn't told the average of the last six.
 */
export const PACE_DAYS = 30;

/**
 * The days to divide a window's dollar amounts by for a rate at the recent
 * pace. A window up to `PACE_DAYS` long is its own pace. For a longer one, it's
 * the days the last `PACE_DAYS` of spend would take to reach the window total,
 * so every `x / days * 30` projects at the recent pace unchanged. Measured back
 * from the last call, so an old export still projects from its own final month.
 */
export function projectionDays(data: Dataset): number {
  const days = Math.max(1, data.window.days || 1);
  if (days <= PACE_DAYS) return days;
  const end = Date.parse(data.window.to);
  if (!Number.isFinite(end)) return days;
  const from = end - PACE_DAYS * 86_400_000;
  let total = 0;
  let recent = 0;
  for (const e of data.events) {
    total += e.cost.total;
    if (Date.parse(e.ts) >= from) recent += e.cost.total;
  }
  if (total <= 0 || recent <= 0) return days;
  return total / (recent / PACE_DAYS);
}

export interface Summary {
  calls: number;
  totalCost: number;
  /** `totalCost` broken out by what drove it, including per-request tools. */
  cost: CostBreakdown;
  window: Dataset["window"];
  perDay: number;
  perMonth: number;
  /** Where `perDay` and `perMonth` came from: the whole window, or its last 30 days. */
  pace: "window" | "last-30-days";

  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache writes at the 5-minute TTL, billed at 1.25x the input rate. */
  cacheWrite5mTokens: number;
  /** Cache writes at the 1-hour TTL, billed at 2x the input rate. */
  cacheWrite1hTokens: number;
  /** Server-side web searches, billed per request rather than per token. */
  webSearches: number;

  /** The IANA zone the `byDay` buckets were cut in. */
  dayTimeZone: string;
  /**
   * The first and last day in `dayTimeZone`. `window.from`/`.to` are UTC
   * timestamps, so slicing them would name days no bucket has.
   */
  windowDays: { from: string; to: string };

  /** Share of billable input tokens served from cache. 1.0 is perfect. */
  cacheHitRate: number;
  /** Share of output spend that went on thinking tokens. */
  thinkingShare: number;

  /** Total tokens across every direction, the headline volume figure. */
  totalTokens: number;
  /** Mean tokens per call, which shows whether context is creeping. */
  avgTokensPerCall: number;
  avgCostPerCall: number;

  byModel: Bucket[];
  byProvider: Bucket[];
  byDay: Bucket[];
  byProject: Bucket[];
  bySession: Bucket[];
  byRoute: Bucket[];

  /** Most expensive individual calls. */
  topByCost: TopCall[];
  /** Largest individual calls by token count. */
  topByTokens: TopCall[];

  /** Latency percentiles in ms, for calls that recorded them. */
  latency: { p50: number; p95: number; count: number } | null;
}

function newBucket(key: string): Bucket {
  return {
    key,
    calls: 0,
    cost: emptyCost(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    thinkingTokens: 0,
  };
}

function push(map: Map<string, Bucket>, key: string, e: CallEvent): void {
  let b = map.get(key);
  if (!b) {
    b = newBucket(key);
    map.set(key, b);
  }
  b.calls++;
  b.cost = addCost(b.cost, e.cost);
  b.inputTokens += e.inputTokens;
  b.outputTokens += e.outputTokens;
  b.cacheReadTokens += e.cacheReadTokens;
  b.cacheWriteTokens += e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  b.cacheWrite5mTokens += e.cacheWrite5mTokens;
  b.cacheWrite1hTokens += e.cacheWrite1hTokens;
  b.thinkingTokens += e.thinkingTokens;
}

function sorted(map: Map<string, Bucket>): Bucket[] {
  return [...map.values()].sort((a, b) => b.cost.total - a.cost.total);
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return sortedValues[idx]!;
}

/** The model's effective input rate at the time of the call, $/M tokens. */
export function inputRateOf(e: CallEvent): number {
  const price = priceFor(e.model);
  if (!price) return 0;
  return ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch }).inputPerM;
}

export function summarize(data: Dataset, opts: SummaryOptions = {}): Summary {
  const dayTimeZone = resolveTimeZone(opts.timeZone ?? "UTC");
  const byModel = new Map<string, Bucket>();
  const byProvider = new Map<string, Bucket>();
  const byDay = new Map<string, Bucket>();
  const byProject = new Map<string, Bucket>();
  const bySession = new Map<string, Bucket>();
  const byRoute = new Map<string, Bucket>();

  let cost = emptyCost();
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  let webSearches = 0;
  let thinkingCost = 0;
  const latencies: number[] = [];

  for (const e of data.events) {
    cost = addCost(cost, e.cost);
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    thinkingTokens += e.thinkingTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheWriteTokens += e.cacheWrite5mTokens + e.cacheWrite1hTokens;
    cacheWrite5mTokens += e.cacheWrite5mTokens;
    cacheWrite1hTokens += e.cacheWrite1hTokens;
    webSearches += e.webSearches ?? 0;

    if (e.outputTokens > 0) {
      thinkingCost += e.cost.output * (e.thinkingTokens / e.outputTokens);
    }
    if (typeof e.latencyMs === "number") latencies.push(e.latencyMs);

    push(byModel, e.model, e);
    push(byProvider, e.provider ?? "unknown", e);
    push(byDay, dayKeyIn(e.ts, dayTimeZone), e);
    push(byProject, e.project, e);
    push(bySession, e.sessionId, e);
    if (e.route) push(byRoute, e.route, e);
  }

  const tokensOf = (e: (typeof data.events)[number]) =>
    e.inputTokens +
    e.outputTokens +
    e.cacheReadTokens +
    e.cacheWrite5mTokens +
    e.cacheWrite1hTokens;

  const toTop = (e: (typeof data.events)[number]): TopCall => ({
    id: e.id,
    ts: e.ts,
    model: e.model,
    provider: e.provider ?? "unknown",
    project: e.project,
    route: e.route,
    costUsd: e.cost.total,
    totalTokens: tokensOf(e),
    inputTokens: e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens,
    outputTokens: e.outputTokens,
    latencyMs: e.latencyMs,
  });

  const topByCost = [...data.events]
    .sort((a, b) => b.cost.total - a.cost.total)
    .slice(0, 10)
    .map(toTop);
  const topByTokens = [...data.events]
    .sort((a, b) => tokensOf(b) - tokensOf(a))
    .slice(0, 10)
    .map(toTop);

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const days = projectionDays(data);
  const totalInputSide = inputTokens + cacheReadTokens + cacheWriteTokens;
  latencies.sort((a, b) => a - b);

  return {
    calls: data.events.length,
    totalCost: cost.total,
    cost,
    window: data.window,
    // Divided by elapsed days, not days with traffic: a quiet fortnight is part
    // of the rate. Past 30 days, it's the last 30 days' rate (see projectionDays).
    perDay: cost.total / days,
    perMonth: (cost.total / days) * 30,
    pace: Math.max(1, data.window.days || 1) > PACE_DAYS ? "last-30-days" : "window",
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    webSearches,
    dayTimeZone,
    windowDays: {
      from: data.window.from ? dayKeyIn(data.window.from, dayTimeZone) : "",
      to: data.window.to ? dayKeyIn(data.window.to, dayTimeZone) : "",
    },
    cacheHitRate: totalInputSide > 0 ? cacheReadTokens / totalInputSide : 0,
    thinkingShare: cost.output > 0 ? thinkingCost / cost.output : 0,
    totalTokens,
    avgTokensPerCall: data.events.length ? totalTokens / data.events.length : 0,
    avgCostPerCall: data.events.length ? cost.total / data.events.length : 0,
    byModel: sorted(byModel),
    byProvider: sorted(byProvider),
    topByCost,
    topByTokens,
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byProject: sorted(byProject),
    bySession: sorted(bySession),
    byRoute: sorted(byRoute),
    latency: latencies.length
      ? {
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          count: latencies.length,
        }
      : null,
  };
}
