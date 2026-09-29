import { dayKeyIn, resolveTimeZone, type DayTimeZone } from "./summary.js";
import type { UsageEvent } from "../domain/types.js";

/**
 * A monthly spend cap (reset on the 1st): how much is used and when it runs
 * out. For someone with a fixed monthly agent budget the question is whether
 * the cap lasts, so the answers are dates and days. The month is cut in the
 * same zone as the day buckets, and only this machine's calls are counted.
 */
export interface BudgetStatus {
  limitUsd: number;
  timeZone: string;
  /** First day of the budget month, `YYYY-MM-DD`. */
  periodStart: string;
  /** The day the cap resets, `YYYY-MM-DD` (the 1st of the next month). */
  resetsOn: string;
  daysInPeriod: number;
  /** Days elapsed since the period started, fractional. */
  daysElapsed: number;
  daysLeft: number;

  usedUsd: number;
  usedShare: number;
  /** Spend per calendar day that the projection runs at. */
  dailyRateUsd: number;
  /** Where the rate came from: this month so far, or the last 14 days. */
  rateBasis: "month-to-date" | "trailing-14d";
  /** Month-end spend at that rate, uncapped. */
  projectedUsd: number;

  /** The cap is already used up. */
  reached: boolean;
  /** The day the cap was or will be reached; null when it lasts the month. */
  exhaustsOn: string | null;
  /** Days of the month left without budget; 0 when it lasts. */
  daysShort: number;

  /**
   * The same projection with every recoverable finding applied. Estimated:
   * it assumes the savings share of past spend holds for the rest of the month.
   * Null when there is nothing to recover or the cap is already reached.
   */
  withFixes: {
    dailyRateUsd: number;
    exhaustsOn: string | null;
    daysShort: number;
    /** Days the fixes add before the cap is reached. */
    daysGained: number;
  } | null;
}

export interface BudgetOptions {
  limitUsd: number;
  /** Defaults to the current time. */
  now?: Date;
  timeZone?: DayTimeZone;
  /**
   * Share of spend the recoverable findings would remove, 0..1. Usually
   * `savingsMonthlyUsd / perMonthUsd` from the same analysis.
   */
  savingsShare?: number;
}

/**
 * Below this many elapsed days, month-to-date spend is too little data to
 * project from: one busy morning on the 2nd would put the cap at the 5th. The
 * trailing fortnight is used instead, when there is one.
 */
const MIN_DAYS_FOR_MTD = 7;
const TRAILING_DAYS = 14;

/** Never assume fixes remove more than this, however the findings add up. */
const MAX_SAVINGS_SHARE = 0.9;

export function budgetStatus(events: UsageEvent[], opts: BudgetOptions): BudgetStatus {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? "UTC";
  const clock = clockIn(now, tz);

  const daysInPeriod = new Date(Date.UTC(clock.year, clock.month, 0)).getUTCDate();
  const monthKey = `${clock.year}-${pad2(clock.month)}`;
  const periodStart = `${monthKey}-01`;
  const resetsOn =
    clock.month === 12 ? `${clock.year + 1}-01-01` : `${clock.year}-${pad2(clock.month + 1)}-01`;
  const daysElapsed = clock.day - 1 + (clock.hour * 60 + clock.minute) / 1440;
  const daysLeft = daysInPeriod - daysElapsed;

  // Per-day spend inside the month, so the day the cap was crossed can be
  // named, not just the fact that it was.
  const byDay = new Map<string, number>();
  let usedUsd = 0;
  const nowMs = now.getTime();
  const trailingFrom = nowMs - TRAILING_DAYS * 86_400_000;
  let trailingUsd = 0;
  let earliestMs = Infinity;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t > nowMs) continue;
    if (t < earliestMs) earliestMs = t;
    if (t >= trailingFrom) trailingUsd += e.cost.total;
    const key = dayKeyIn(e.ts, tz);
    if (key.slice(0, 7) !== monthKey) continue;
    usedUsd += e.cost.total;
    byDay.set(key, (byDay.get(key) ?? 0) + e.cost.total);
  }

  let dailyRateUsd: number;
  let rateBasis: BudgetStatus["rateBasis"];
  if (daysElapsed >= MIN_DAYS_FOR_MTD) {
    dailyRateUsd = usedUsd / daysElapsed;
    rateBasis = "month-to-date";
  } else {
    // A history shorter than the fortnight is averaged over what exists, so a
    // user three days into using agents is not diluted by eleven empty days.
    const covered = Math.min(TRAILING_DAYS, Math.max(1, (nowMs - earliestMs) / 86_400_000));
    dailyRateUsd = Number.isFinite(earliestMs) ? trailingUsd / covered : 0;
    rateBasis = "trailing-14d";
  }

  const limitUsd = opts.limitUsd;
  const reached = usedUsd >= limitUsd;
  const projectedUsd = usedUsd + dailyRateUsd * daysLeft;

  let exhaustsOn: string | null = null;
  let daysShort = 0;
  if (reached) {
    let running = 0;
    for (const key of [...byDay.keys()].sort()) {
      running += byDay.get(key)!;
      if (running >= limitUsd) {
        exhaustsOn = key;
        break;
      }
    }
    daysShort = daysLeft;
  } else {
    const hit = runOut(usedUsd, limitUsd, dailyRateUsd, daysElapsed, daysInPeriod);
    if (hit !== null) {
      exhaustsOn = `${monthKey}-${pad2(Math.floor(hit) + 1)}`;
      daysShort = daysInPeriod - hit;
    }
  }

  let withFixes: BudgetStatus["withFixes"] = null;
  const share = Math.min(MAX_SAVINGS_SHARE, Math.max(0, opts.savingsShare ?? 0));
  if (!reached && share > 0) {
    const rate = dailyRateUsd * (1 - share);
    const hit = runOut(usedUsd, limitUsd, rate, daysElapsed, daysInPeriod);
    const before = daysInPeriod - daysShort;
    const after = hit ?? daysInPeriod;
    withFixes = {
      dailyRateUsd: rate,
      exhaustsOn: hit === null ? null : `${monthKey}-${pad2(Math.floor(hit) + 1)}`,
      daysShort: hit === null ? 0 : daysInPeriod - hit,
      daysGained: Math.max(0, after - before),
    };
  }

  return {
    limitUsd,
    timeZone: resolveTimeZone(tz),
    periodStart,
    resetsOn,
    daysInPeriod,
    daysElapsed,
    daysLeft,
    usedUsd,
    usedShare: limitUsd > 0 ? usedUsd / limitUsd : 0,
    dailyRateUsd,
    rateBasis,
    projectedUsd,
    reached,
    exhaustsOn,
    daysShort,
    withFixes,
  };
}

/** The day of the month (fractional, from 0) the cap is hit, or null if it lasts. */
function runOut(
  used: number,
  limit: number,
  rate: number,
  elapsed: number,
  daysInPeriod: number,
): number | null {
  if (rate <= 0) return null;
  const hit = elapsed + (limit - used) / rate;
  return hit < daysInPeriod ? hit : null;
}

/* ------------------------------------------------------------------ *
 * Live thresholds
 * ------------------------------------------------------------------ */

export const BUDGET_THRESHOLDS = [0.5, 0.8, 0.95, 1] as const;

export interface BudgetCrossing {
  /** The threshold just crossed, as a share of the cap. */
  threshold: number;
  usedUsd: number;
  limitUsd: number;
}

/**
 * Follows month-to-date spend as calls arrive and reports each threshold once.
 * Seeded with what the month already used; a call from a new month resets it.
 */
export function createBudgetTracker(opts: {
  limitUsd: number;
  usedUsd: number;
  /** `YYYY-MM` the seed belongs to. */
  month: string;
  timeZone?: DayTimeZone;
  thresholds?: readonly number[];
}) {
  const thresholds = [...(opts.thresholds ?? BUDGET_THRESHOLDS)].sort((a, b) => a - b);
  const tz = opts.timeZone ?? "UTC";
  let month = opts.month;
  let used = opts.usedUsd;
  let announced = thresholds.filter((t) => used >= opts.limitUsd * t).length;

  return {
    get usedUsd() {
      return used;
    },
    /** Add a call; returns the highest threshold it crossed, if any. */
    add(event: UsageEvent): BudgetCrossing | null {
      const key = dayKeyIn(event.ts, tz).slice(0, 7);
      if (key < month) return null;
      if (key > month) {
        month = key;
        used = 0;
        announced = 0;
      }
      used += event.cost.total;
      let crossed: number | null = null;
      while (announced < thresholds.length && used >= opts.limitUsd * thresholds[announced]!) {
        crossed = thresholds[announced]!;
        announced++;
      }
      return crossed === null
        ? null
        : { threshold: crossed, usedUsd: used, limitUsd: opts.limitUsd };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Calendar fields of an instant in a zone; UTC when the zone is unusable. */
function clockIn(at: Date, tz: DayTimeZone) {
  const zone = resolveTimeZone(tz);
  const utc = () => ({
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
  });
  if (zone === "UTC") return utc();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const out = {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
    return Object.values(out).every(Number.isFinite) ? out : utc();
  } catch {
    return utc();
  }
}
