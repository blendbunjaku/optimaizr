import { recoverableByEvent } from "./rules.js";
import type { OptimizationFinding, RateLimitSnapshot, UsageEvent } from "../domain/types.js";

/**
 * A ChatGPT plan, as Codex reports it. Every `token_count` carries the plan and
 * each window's usage and reset time straight from OpenAI, so this view is
 * detected, not configured, and its percentages are measured. It adds what the
 * meter doesn't say: the API-price value and the waste in it.
 */

const DAY = 86_400_000;
const RECENT_DAYS = 30;

/**
 * Every plan type Codex reports, priced where the price is public, flat and
 * monthly. `prolite` is Pro 5x ($100), `pro` is Pro 20x ($200). Seat plans get
 * no price (Business is $25 monthly or $20 annually, and the plan type doesn't
 * say which). `team` is Business under its old name.
 */
const CHATGPT_PLANS: Record<string, { label: string; priceUsd: number | null }> = {
  free: { label: "ChatGPT Free", priceUsd: 0 },
  go: { label: "ChatGPT Go", priceUsd: 8 },
  plus: { label: "ChatGPT Plus", priceUsd: 20 },
  prolite: { label: "ChatGPT Pro 5x", priceUsd: 100 },
  pro: { label: "ChatGPT Pro 20x", priceUsd: 200 },
  team: { label: "ChatGPT Business", priceUsd: null },
  business: { label: "ChatGPT Business", priceUsd: null },
  self_serve_business_usage_based: { label: "ChatGPT Business, usage-based", priceUsd: null },
  enterprise: { label: "ChatGPT Enterprise", priceUsd: null },
  enterprise_cbp_usage_based: { label: "ChatGPT Enterprise, usage-based", priceUsd: null },
  edu: { label: "ChatGPT Edu", priceUsd: null },
};

function planOf(planType: string | null) {
  const key = (planType ?? "").toLowerCase();
  const known = CHATGPT_PLANS[key];
  if (known) return known;
  // A plan type newer than this table: say what Codex said, and no price.
  const name = key && key !== "unknown" ? key[0]!.toUpperCase() + key.slice(1) : "plan";
  return { label: `ChatGPT ${name}`, priceUsd: null };
}

/** 300 -> "5-hour", 10080 -> "Weekly". */
export function windowLabel(minutes: number): string {
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export interface CodexWindowView {
  label: string;
  windowMinutes: number;
  /** OpenAI's figure at the last reading; 0 once the window has reset since. */
  usedPercent: number;
  resetsAt: string;
  /** The window reset after the last reading, so it has started again. */
  hasReset: boolean;
  /** API-equivalent spend inside this window so far. */
  apiUsd: number;
  /**
   * What a full window holds at API prices, from spend so far over the share
   * used. Only when enough of it is used for the ratio to mean anything.
   */
  fullWindowUsd: number | null;
}

export interface CodexPlanView {
  planType: string | null;
  label: string;
  priceUsd: number | null;
  /** When Codex last reported the meter. */
  readAt: string;
  /** Codex's API-equivalent spend over the last 30 days. */
  valueMonthlyUsd: number;
  multiple: number | null;
  windows: CodexWindowView[];
  /** Recoverable share of the last 30 days of Codex spend. */
  wasteShare: number;
}

/**
 * The ChatGPT plan view, or null when Codex has not reported a meter in the
 * last 30 days (API-key sessions never report one).
 */
export function codexPlanView(
  events: UsageEvent[],
  findings: OptimizationFinding[],
  opts: { now?: Date } = {},
): CodexPlanView | null {
  const now = (opts.now ?? new Date()).getTime();
  const codex = events
    .filter((e) => e.source === "codex" && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  let latest: UsageEvent | undefined;
  for (const e of codex) if (e.rateLimits && Date.parse(e.ts) <= now) latest = e;
  if (!latest?.rateLimits) return null;
  if (now - Date.parse(latest.ts) > RECENT_DAYS * DAY) return null;

  const since = now - RECENT_DAYS * DAY;
  const recent = codex.filter((e) => {
    const t = Date.parse(e.ts);
    return t >= since && t <= now;
  });
  const first = codex[0] ? Date.parse(codex[0].ts) : now;
  const valueDays = Math.min(RECENT_DAYS, Math.max(1, (now - first) / DAY));
  const recentUsd = recent.reduce((t, e) => t + e.cost.total, 0);
  const valueMonthlyUsd = (recentUsd / valueDays) * RECENT_DAYS;

  const { byEvent } = recoverableByEvent(findings);
  const recentWaste = recent.reduce((t, e) => t + (byEvent.get(e.id) ?? 0), 0);

  const windows = latest.rateLimits.windows.map((w): CodexWindowView => {
    const resets = Date.parse(w.resetsAt);
    const hasReset = resets <= now;
    const start = resets - w.windowMinutes * 60_000;
    const apiUsd = hasReset
      ? 0
      : codex
          .filter((e) => {
            const t = Date.parse(e.ts);
            return t >= start && t <= now;
          })
          .reduce((t, e) => t + e.cost.total, 0);
    return {
      label: windowLabel(w.windowMinutes),
      windowMinutes: w.windowMinutes,
      usedPercent: hasReset ? 0 : w.usedPercent,
      resetsAt: w.resetsAt,
      hasReset,
      apiUsd,
      fullWindowUsd: !hasReset && w.usedPercent >= 5 ? apiUsd / (w.usedPercent / 100) : null,
    };
  });

  const { label, priceUsd } = planOf(latest.rateLimits.planType);
  return {
    planType: latest.rateLimits.planType,
    label,
    priceUsd,
    readAt: latest.ts,
    valueMonthlyUsd,
    multiple: priceUsd ? valueMonthlyUsd / priceUsd : null,
    windows,
    wasteShare: recentUsd > 0 ? recentWaste / recentUsd : 0,
  };
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

export const CODEX_THRESHOLDS = [80, 95] as const;

export interface CodexLimitCrossing {
  label: string;
  threshold: number;
  usedPercent: number;
  resetsAt: string;
}

/**
 * Follows OpenAI's meter and announces each window crossing 80% and 95% once.
 * Seeded with the latest reading; a window whose reset time moves has restarted.
 */
export function createCodexLimitTracker(opts: {
  seed?: RateLimitSnapshot | null;
  thresholds?: readonly number[];
}) {
  const thresholds = [...(opts.thresholds ?? CODEX_THRESHOLDS)].sort((a, b) => a - b);
  const state = new Map<number, { resetsAt: string; announced: number }>();
  for (const w of opts.seed?.windows ?? []) {
    state.set(w.windowMinutes, {
      resetsAt: w.resetsAt,
      announced: thresholds.filter((t) => w.usedPercent >= t).length,
    });
  }

  return {
    add(event: UsageEvent): CodexLimitCrossing[] {
      if (event.source !== "codex" || !event.rateLimits) return [];
      const out: CodexLimitCrossing[] = [];
      for (const w of event.rateLimits.windows) {
        let s = state.get(w.windowMinutes);
        if (!s || s.resetsAt !== w.resetsAt) {
          // A later reset time is a new window. The same window re-reported
          // with a slightly different second is not, hence the tolerance.
          const moved = !s || Math.abs(Date.parse(w.resetsAt) - Date.parse(s.resetsAt)) > 60_000;
          s = { resetsAt: w.resetsAt, announced: moved ? 0 : (s?.announced ?? 0) };
          state.set(w.windowMinutes, s);
        }
        let crossed: number | null = null;
        while (s.announced < thresholds.length && w.usedPercent >= thresholds[s.announced]!) {
          crossed = thresholds[s.announced]!;
          s.announced++;
        }
        if (crossed !== null) {
          out.push({
            label: windowLabel(w.windowMinutes),
            threshold: crossed,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt,
          });
        }
      }
      return out;
    },
  };
}
