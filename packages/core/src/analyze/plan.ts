import { recoverableByEvent } from "./rules.js";
import type { OptimizationFinding, UsageEvent } from "../domain/types.js";

/**
 * A Claude subscription, where usage is rationed in five-hour sessions rather
 * than billed per token. Dollars here are API-equivalent: still the right unit,
 * since a bigger model drains a session faster roughly in proportion to price.
 *
 * Two things are reconstructed, and the report says so: sessions are rebuilt
 * from timestamps (one opens at the top of the hour of the first message after
 * the last one closed, and lasts five hours), and the limit, which isn't
 * published, is learned from hits the user records with `optimaizr limit`.
 */

export type PlanId = "pro" | "max5" | "max20" | "team" | "team-premium";

/**
 * The Claude plans that ration Claude Code in five-hour sessions, at monthly
 * list prices (annual billing is cheaper, so the multiple then reads a little
 * low). Max 5x/20x are 5x/20x Pro per session; Premium is 5x a Standard seat.
 * The weekly limit on top is not modelled.
 */
export const PLANS: Record<PlanId, { label: string; priceUsd: number; perSeat: boolean }> = {
  pro: { label: "Claude Pro", priceUsd: 20, perSeat: false },
  max5: { label: "Claude Max 5x", priceUsd: 100, perSeat: false },
  max20: { label: "Claude Max 20x", priceUsd: 200, perSeat: false },
  team: { label: "Claude Team Standard", priceUsd: 25, perSeat: true },
  "team-premium": { label: "Claude Team Premium", priceUsd: 125, perSeat: true },
};

/** The ids `--plan` takes, in the order help text lists them. */
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

/** `pro`, `max5`, `max20`, `team`, `team-premium`, and the spellings people actually type. */
export function parsePlan(raw: string): PlanId | null {
  const k = planKey(raw);
  if (k === "pro") return "pro";
  if (k === "max" || k === "max5" || k === "max5x") return "max5";
  if (k === "max20" || k === "max20x") return "max20";
  if (k === "team" || k === "teamstandard" || k === "standard") return "team";
  if (k === "teampremium" || k === "premium") return "team-premium";
  return null;
}

/**
 * Real Claude plans with no session view, and what to use instead. Enterprise
 * bills usage at API rates under a spend limit, so `--budget` fits; Free
 * doesn't include Claude Code.
 */
export function planRedirect(raw: string): string | null {
  const k = planKey(raw);
  if (k === "enterprise") {
    return "Claude Enterprise bills usage at API rates, so read it against your spend limit: --budget <USD>";
  }
  if (k === "free")
    return "Claude Free does not include Claude Code, so it has no sessions to read";
  return null;
}

function planKey(raw: string): string {
  return raw.toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * The account fields Claude Code caches in its config after sign-in
 * (`oauthAccount` in ~/.claude.json). Undocumented, so every one is optional
 * and anything unrecognised reads as unknown.
 */
export interface ClaudeAccountInfo {
  organizationType?: string | null;
  organizationRateLimitTier?: string | null;
  userRateLimitTier?: string | null;
  seatTier?: string | null;
  billingType?: string | null;
}

/** Where the plan a report uses came from. */
export type PlanSource = "flag" | "config" | "detected";

/**
 * What Claude Code's account info says about the plan:
 * - `plan`: one we can read sessions against.
 * - `partial`: the family is known but not the tier (Max 5x or 20x?).
 * - `per-token`: billed at API rates (Enterprise), so `--budget` fits instead.
 * - `unknown`: nothing usable; never filled in with a guess.
 */
export type PlanDetection =
  | { kind: "plan"; plan: PlanId; label: string }
  | { kind: "partial"; label: string; choices: PlanId[] }
  | { kind: "per-token"; label: string }
  | { kind: "unknown"; reason: string };

export function planFromAccount(account: ClaudeAccountInfo | null): PlanDetection {
  if (!account) return { kind: "unknown", reason: "no Claude Code sign-in found" };
  const org = planKey(account.organizationType ?? "");
  const tiers = [account.userRateLimitTier, account.organizationRateLimitTier]
    .map((t) => planKey(t ?? ""))
    .join(" ");
  const seat = planKey(account.seatTier ?? "");
  const found = (plan: PlanId): PlanDetection => ({ kind: "plan", plan, label: PLANS[plan].label });

  if (org.includes("enterprise")) return { kind: "per-token", label: "Claude Enterprise" };
  if (org.includes("max")) {
    if (tiers.includes("max20x")) return found("max20");
    if (tiers.includes("max5x")) return found("max5");
    return { kind: "partial", label: "Claude Max", choices: ["max5", "max20"] };
  }
  if (org.includes("team")) {
    if (seat.includes("premium")) return found("team-premium");
    if (seat.includes("standard")) return found("team");
    return { kind: "partial", label: "Claude Team", choices: ["team", "team-premium"] };
  }
  if (org.includes("pro")) return found("pro");
  return { kind: "unknown", reason: "Claude Code's account info does not name a plan" };
}

export const SESSION_HOURS = 5;
const HOUR = 3_600_000;
const SESSION_MS = SESSION_HOURS * HOUR;
const RECENT_DAYS = 30;

export interface PlanSession {
  /** ISO start, on the hour. */
  start: string;
  /** ISO reset time: start + 5 hours. */
  end: string;
  calls: number;
  /** API-equivalent spend in the session. */
  usd: number;
  /** The recoverable part of it, de-overlapped as the headline savings are. */
  wasteUsd: number;
  /** When a limit hit was recorded inside this session: what it had used by then. */
  usdAtLimit?: number;
}

/** Only Claude Code traffic counts against a Claude plan. */
function planEvents(events: UsageEvent[]): UsageEvent[] {
  return events
    .filter((e) => e.source === "claude-code" && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Rebuild five-hour sessions from call timestamps. */
export function sessionBlocks(
  events: UsageEvent[],
  findings: OptimizationFinding[] = [],
  limitHits: string[] = [],
): PlanSession[] {
  const { byEvent } = recoverableByEvent(findings);
  const sessions: Array<PlanSession & { startMs: number; items: UsageEvent[] }> = [];
  let cur: (typeof sessions)[number] | undefined;

  for (const e of planEvents(events)) {
    const t = Date.parse(e.ts);
    if (!cur || t >= cur.startMs + SESSION_MS) {
      const startMs = Math.floor(t / HOUR) * HOUR;
      cur = {
        start: new Date(startMs).toISOString(),
        end: new Date(startMs + SESSION_MS).toISOString(),
        startMs,
        calls: 0,
        usd: 0,
        wasteUsd: 0,
        items: [],
      };
      sessions.push(cur);
    }
    cur.calls++;
    cur.usd += e.cost.total;
    cur.wasteUsd += byEvent.get(e.id) ?? 0;
    cur.items.push(e);
  }

  for (const hit of limitHits) {
    const h = Date.parse(hit);
    if (!Number.isFinite(h)) continue;
    const s = sessions.find((x) => h >= x.startMs && h < x.startMs + SESSION_MS);
    if (!s) continue;
    const used = s.items.filter((e) => Date.parse(e.ts) <= h).reduce((t, e) => t + e.cost.total, 0);
    // Two hits recorded in one session describe one limit: keep the later.
    s.usdAtLimit = Math.max(s.usdAtLimit ?? 0, used);
  }

  return sessions.map(({ startMs: _s, items: _i, ...rest }) => rest);
}

/** One of Claude Code's own limit meters, as the optimAIzr mod last read it. */
export interface ClaudeWindowReading {
  /** 0-100, Claude Code's own figure. */
  percentUsed: number;
  resetsAt?: string;
}

export interface ClaudeWindows {
  fiveHour?: ClaudeWindowReading;
  sevenDay?: ClaudeWindowReading;
  /** ISO time of the reading. */
  at: string;
}

export interface PlanView {
  plan: PlanId;
  label: string;
  /** How the plan was chosen; absent for callers that predate detection. */
  source?: PlanSource;
  /** Claude Code's real meters, when the mod reported them recently. */
  windows?: ClaudeWindows;
  /** Monthly list price, per seat when `perSeat`. */
  priceUsd: number;
  perSeat: boolean;
  /** Claude Code's API-equivalent spend over the last 30 days. */
  valueMonthlyUsd: number;
  /** valueMonthlyUsd / priceUsd. */
  multiple: number;
  /** Days of history `valueMonthlyUsd` was measured over, when under 30. */
  valueDays: number;
  /** Claude Code calls in the history. With none there is nothing to set the plan against. */
  calls: number;
  /** Where the Claude Code transcripts were read from, named when none were found. */
  dir?: string;

  /** Sessions that started in the last 30 days. */
  recentSessions: number;
  medianSessionUsd: number;
  heaviest: PlanSession | null;
  /** Recoverable share of recent session spend. */
  wasteShare: number;

  /** The learned limit: the median of what sessions had used when a hit was recorded. */
  limit: { usd: number; hits: number } | null;
  /** The session running now, if one is. */
  current: (PlanSession & { limitShare: number | null }) | null;
}

export function planView(
  events: UsageEvent[],
  findings: OptimizationFinding[],
  opts: {
    plan: PlanId;
    limitHits?: string[];
    now?: Date;
    source?: PlanSource;
    windows?: ClaudeWindows | null;
    dir?: string;
  },
): PlanView {
  const now = (opts.now ?? new Date()).getTime();
  const sessions = sessionBlocks(events, findings, opts.limitHits ?? []);
  const since = now - RECENT_DAYS * 24 * HOUR;
  const recent = sessions.filter((s) => Date.parse(s.start) >= since);

  const first = sessions[0] ? Date.parse(sessions[0].start) : now;
  const valueDays = Math.min(RECENT_DAYS, Math.max(1, (now - first) / (24 * HOUR)));
  const recentUsd = recent.reduce((t, s) => t + s.usd, 0);
  // A history shorter than a month is scaled up to one, as every other
  // monthly figure in the engine is.
  const valueMonthlyUsd = (recentUsd / valueDays) * RECENT_DAYS;
  const recentWaste = recent.reduce((t, s) => t + s.wasteUsd, 0);

  const hits = sessions.flatMap((s) => (s.usdAtLimit === undefined ? [] : [s.usdAtLimit]));
  const limit = hits.length ? { usd: median(hits), hits: hits.length } : null;

  const last = sessions.at(-1);
  const current =
    last && now < Date.parse(last.end)
      ? { ...last, limitShare: limit && limit.usd > 0 ? last.usd / limit.usd : null }
      : null;

  const { label, priceUsd, perSeat } = PLANS[opts.plan];
  return {
    plan: opts.plan,
    label,
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.windows ? { windows: opts.windows } : {}),
    priceUsd,
    perSeat,
    valueMonthlyUsd,
    multiple: valueMonthlyUsd / priceUsd,
    valueDays,
    calls: sessions.reduce((t, s) => t + s.calls, 0),
    ...(opts.dir ? { dir: opts.dir } : {}),
    recentSessions: recent.length,
    medianSessionUsd: median(recent.map((s) => s.usd)),
    heaviest: recent.reduce<PlanSession | null>((a, s) => (!a || s.usd > a.usd ? s : a), null),
    wasteShare: recentUsd > 0 ? recentWaste / recentUsd : 0,
    limit,
    current,
  };
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

export const SESSION_THRESHOLDS = [0.8, 0.95] as const;

export interface SessionCrossing {
  threshold: number;
  usedUsd: number;
  limitUsd: number;
  /** ISO time the session resets. */
  resetsAt: string;
}

/**
 * Follows the running session and reports when it nears the learned limit.
 * Seeded with the session in progress; a call past the reset starts a new one.
 */
export function createSessionTracker(opts: {
  limitUsd: number;
  /** The session in progress when tracking starts, if any. */
  current?: { start: string; usd: number } | null;
  thresholds?: readonly number[];
}) {
  const thresholds = [...(opts.thresholds ?? SESSION_THRESHOLDS)].sort((a, b) => a - b);
  let startMs = opts.current ? Date.parse(opts.current.start) : -Infinity;
  let used = opts.current?.usd ?? 0;
  let announced = thresholds.filter((t) => used >= opts.limitUsd * t).length;

  return {
    add(event: UsageEvent): SessionCrossing | null {
      if (event.source !== "claude-code") return null;
      const t = Date.parse(event.ts);
      if (!Number.isFinite(t) || t < startMs) return null;
      if (t >= startMs + SESSION_MS) {
        startMs = Math.floor(t / HOUR) * HOUR;
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
        : {
            threshold: crossed,
            usedUsd: used,
            limitUsd: opts.limitUsd,
            resetsAt: new Date(startMs + SESSION_MS).toISOString(),
          };
    },
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
