import type { UsageEvent } from "../domain/types.js";
import { coldResumes } from "./cold.js";
import type { LimitHit } from "./plan.js";

/**
 * The last 7 days against the 7 before: how much of the spend went on
 * re-reading the conversation, and how often you came back to a cold cache.
 */
export interface WeekCompare {
  rereadShare: number;
  rereadShareBefore: number | null;
  cold: number;
  coldBefore: number | null;
  /** Times the 5-hour limit stopped you. */
  stops: number;
  stopsBefore: number | null;
  spendUsd: number;
}

const DAY = 86_400_000;
const WINDOW = 5 * 3_600_000;

// Retries until the reset are one stop: by the reset when known, else 5 hours.
function stopsIn(hits: readonly LimitHit[], lo: number, hi: number): number {
  const sorted = hits
    .map((h) => (typeof h === "string" ? { ts: h } : h))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  let n = 0;
  let until = -Infinity;
  for (const h of sorted) {
    const t = Date.parse(h.ts);
    if (t < until) continue;
    until = h.resetsAt ? Date.parse(h.resetsAt) : t + WINDOW;
    if (t >= lo && t < hi) n++;
  }
  return n;
}

/** `hits` are the 5-hour limit's, from the transcripts and any recorded by hand. */
export function weekCompare(
  events: readonly UsageEvent[],
  now = Date.now(),
  hits: readonly LimitHit[] = [],
): WeekCompare | null {
  const span = (lo: number, hi: number) =>
    events.filter((e) => {
      const t = Date.parse(e.ts);
      return t >= lo && t < hi;
    });
  const week = span(now - 7 * DAY, now);
  const before = span(now - 14 * DAY, now - 7 * DAY);
  const spend = (es: UsageEvent[]) => es.reduce((s, e) => s + e.cost.total, 0);
  const reread = (es: UsageEvent[]) => {
    const total = spend(es);
    return total > 0 ? es.reduce((s, e) => s + e.cost.cacheRead, 0) / total : null;
  };
  const share = reread(week);
  if (share === null) return null;
  return {
    rereadShare: share,
    rereadShareBefore: reread(before),
    cold: coldResumes(week).length,
    coldBefore: before.length > 0 ? coldResumes(before).length : null,
    stops: stopsIn(hits, now - 7 * DAY, now),
    stopsBefore: before.length > 0 ? stopsIn(hits, now - 14 * DAY, now - 7 * DAY) : null,
    spendUsd: spend(week),
  };
}

/**
 * "re-reading 28% of spend (was 56%), 2 returns to a cold cache (was 5)", and
 * the stops at the 5-hour limit when either week had one.
 */
export function weekText(w: WeekCompare): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const was = (x: string | null) => (x === null ? "" : ` (was ${x})`);
  const returns = `${w.cold} ${w.cold === 1 ? "return" : "returns"} to a cold cache`;
  const line = `re-reading ${pct(w.rereadShare)} of spend${was(w.rereadShareBefore === null ? null : pct(w.rereadShareBefore))}, ${returns}${was(w.coldBefore === null ? null : String(w.coldBefore))}`;
  if (!w.stops && !w.stopsBefore) return line;
  const stops = `${w.stops || "no"} ${w.stops === 1 ? "stop" : "stops"} at the 5-hour limit`;
  return `${line}, ${stops}${was(w.stopsBefore === null ? null : String(w.stopsBefore))}`;
}
