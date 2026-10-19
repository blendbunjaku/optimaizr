import type { UsageEvent } from "../domain/types.js";
import { coldResumes } from "./cold.js";

/**
 * The last 7 days against the 7 before: how much of the spend went on
 * re-reading the conversation, and how often you came back to a cold cache.
 */
export interface WeekCompare {
  rereadShare: number;
  rereadShareBefore: number | null;
  cold: number;
  coldBefore: number | null;
  spendUsd: number;
}

const DAY = 86_400_000;

export function weekCompare(events: readonly UsageEvent[], now = Date.now()): WeekCompare | null {
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
    spendUsd: spend(week),
  };
}

/** "re-reading 28% of spend (was 56%), 2 returns to a cold cache (was 5)" */
export function weekText(w: WeekCompare): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const was = (x: string | null) => (x === null ? "" : ` (was ${x})`);
  const returns = `${w.cold} ${w.cold === 1 ? "return" : "returns"} to a cold cache`;
  return `re-reading ${pct(w.rereadShare)} of spend${was(w.rereadShareBefore === null ? null : pct(w.rereadShareBefore))}, ${returns}${was(w.coldBefore === null ? null : String(w.coldBefore))}`;
}
