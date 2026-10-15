import type { Dataset, UsageEvent } from "../domain/types.js";

/**
 * Conversations: one row per agent conversation (a Claude Code or Codex
 * session, under the title the agent gave it), what it cost with its
 * subagents, and how long the agent worked on it. Plus the rate that turns
 * dollars into a share of Claude's five-hour window.
 */

/** A pause this long inside a turn is someone away or a question left open, not work. */
export const IDLE_GAP_MS = 15 * 60_000;

export interface ConversationRow {
  sessionId: string;
  title?: string;
  project: string;
  source: UsageEvent["source"];
  /** Everything it cost, subagents included. */
  costUsd: number;
  subagentUsd: number;
  /** Time the agent spent working on it, idle stretches left out. */
  workMs: number;
  turns: number;
  calls: number;
  firstTs: string;
  lastTs: string;
}

/**
 * How long the agent worked: from each prompt to its last response, with
 * stretches over `IDLE_GAP_MS` left out. Overlapping turns count once.
 */
export function workMs(events: readonly UsageEvent[]): number {
  const byTurn = new Map<string, number[]>();
  for (const e of events) {
    if (e.isSubagent) continue;
    const key = e.turnId ?? "";
    let points = byTurn.get(key);
    if (!points) byTurn.set(key, (points = []));
    points.push(Date.parse(e.ts), Date.parse(e.endTs ?? e.ts));
    if (e.turnStartedAt) points.push(Date.parse(e.turnStartedAt));
  }

  const spans: Array<[number, number]> = [];
  for (const points of byTurn.values()) {
    const t = points.filter(Number.isFinite).sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) {
      if (t[i]! - t[i - 1]! <= IDLE_GAP_MS) spans.push([t[i - 1]!, t[i]!]);
    }
  }

  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of spans) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/** A main-conversation reply that stopped for anything but a tool call ends its turn. */
export function endsTurn(e: UsageEvent): boolean {
  const stop = e.stopReason;
  return !e.isSubagent && Boolean(stop) && stop !== "tool_use" && stop !== "pause_turn";
}

/**
 * The calls of the turn `last` ended, from its conversation's calls. Subagents
 * answer to prompts of their own, so they join the turn by time.
 */
export function turnCalls(conversation: readonly UsageEvent[], last: UsageEvent): UsageEvent[] {
  if (!last.turnId) return [last];
  const from = last.turnStartedAt ?? last.ts;
  const end = last.endTs ?? last.ts;
  return conversation.filter((e) =>
    e.isSubagent ? e.ts >= from && e.ts <= end : e.turnId === last.turnId,
  );
}

/** Agent conversations, costliest first. SDK and imported calls have none. */
export function conversations(data: Pick<Dataset, "events" | "titles">): ConversationRow[] {
  const bySession = new Map<string, UsageEvent[]>();
  for (const e of data.events) {
    if (e.source !== "claude-code" && e.source !== "codex" && e.source !== "opencode") continue;
    const list = bySession.get(e.sessionId);
    if (list) list.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const rows: ConversationRow[] = [];
  for (const [sessionId, list] of bySession) {
    const main = list.filter((e) => !e.isSubagent);
    const first = list.reduce((a, e) => (e.ts < a ? e.ts : a), list[0]!.ts);
    const last = list.reduce((a, e) => {
      const end = e.endTs ?? e.ts;
      return end > a ? end : a;
    }, first);
    const title = data.titles?.[sessionId];
    rows.push({
      sessionId,
      ...(title ? { title } : {}),
      project: (main[0] ?? list[0]!).project,
      source: list[0]!.source,
      costUsd: list.reduce((s, e) => s + e.cost.total, 0),
      subagentUsd: list.filter((e) => e.isSubagent).reduce((s, e) => s + e.cost.total, 0),
      workMs: workMs(list),
      turns: new Set(main.map((e) => e.turnId).filter(Boolean)).size,
      calls: list.length,
      firstTs: first,
      lastTs: last,
    });
  }
  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

/** One reading of Claude's five-hour meter: whole percents, as Claude reports them. */
export interface MeterReading {
  /** Epoch ms. */
  t: number;
  percent: number;
}

export interface WindowRate {
  /** Dollars at list prices per 1% of the five-hour window: the median window. */
  usdPerPercent: number;
  /** The middle half of the windows it was learned from. */
  low: number;
  high: number;
  windows: number;
}

/** A window has to move this many points before its rate says anything. */
const MIN_RISE = 5;
const MIN_WINDOWS = 3;
const FIVE_HOURS_MS = 5 * 3_600_000;

/**
 * What 1% of the five-hour window costs, learned from the meter's history and
 * the Claude Code calls made while it moved. The meter only shows whole
 * percents, so one turn's share has to come from its dollars. Null until
 * three windows have each moved at least 5 points.
 */
export function windowRate(
  readings: readonly MeterReading[],
  events: readonly UsageEvent[],
): WindowRate | null {
  const calls = events
    .filter((e) => e.source === "claude-code")
    .map((e) => ({ t: Date.parse(e.ts), usd: e.cost.total }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
  if (calls.length === 0) return null;

  // Prefix sums, so each window's spend is two binary searches.
  const times = calls.map((c) => c.t);
  const sums = [0];
  for (const c of calls) sums.push(sums[sums.length - 1]! + c.usd);
  const upTo = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return sums[lo]!;
  };

  // Readings from before the first call would charge a window with nothing.
  const sorted = readings
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.percent) && r.t >= times[0]!)
    .sort((a, b) => a.t - b.t);

  // A new window starts where the meter drops back or nothing was read for five hours.
  const windows: MeterReading[][] = [];
  for (const r of sorted) {
    const w = windows[windows.length - 1];
    const prev = w?.[w.length - 1];
    if (!w || !prev || r.percent < prev.percent || r.t - prev.t > FIVE_HOURS_MS) {
      windows.push([r]);
    } else {
      w.push(r);
    }
  }

  const rates: number[] = [];
  for (const w of windows) {
    const first = w[0]!;
    const last = w[w.length - 1]!;
    const rise = last.percent - first.percent;
    if (rise < MIN_RISE) continue;
    const spent = upTo(last.t) - upTo(first.t);
    if (spent > 0) rates.push(spent / rise);
  }
  if (rates.length < MIN_WINDOWS) return null;

  rates.sort((a, b) => a - b);
  const at = (p: number) => rates[Math.min(rates.length - 1, Math.floor(rates.length * p))]!;
  const mid = Math.floor(rates.length / 2);
  const median = rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
  return { usdPerPercent: median, low: at(0.25), high: at(0.75), windows: rates.length };
}

/** `~1.3%`, `<0.1%`, or `~140%` for a conversation that ran past one window. */
export function windowShareLabel(usd: number, usdPerPercent: number): string {
  const p = usd / usdPerPercent;
  if (!Number.isFinite(p) || p <= 0) return "0%";
  if (p < 0.1) return "<0.1%";
  return `~${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** 42s, 2m 10s, 1h 05m: how long a turn or a conversation took. */
export function workLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
