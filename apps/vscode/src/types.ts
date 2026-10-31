/**
 * What the host sends the webviews, and what they send back. Plain data only:
 * it crosses postMessage and is cached on disk for other windows.
 */

export type Tier = "fix" | "try" | "test";

export interface FixItem {
  rule: string;
  label: string;
  tier: Tier;
  monthlyUsd: number;
  /** Of the month's usage, 0 to 1. */
  usageShare: number;
  confidence: string;
  happened: string;
  why: string;
  fix: string;
  /** compaction is one click; a habit is something you change and mark done. */
  kind: "compaction" | "habit";
  /** When it was recorded as done by hand, if it was and not undone. */
  doneAt: string | null;
  /** Whose calls it covers, so a done record is scoped the way `apply --done` scopes it. */
  scope: { source?: string; project?: string };
}

export interface ResultItem {
  name: string;
  since: string;
  verdict: "working" | "worse" | "unclear" | "none" | "too-early" | "no-baseline";
  text: string;
}

export interface GuardCatch {
  at: string;
  kind: string;
  title: string;
  text: string;
}

export interface Snapshot {
  version: 1;
  /** When it was worked out, ISO. */
  at: string;
  days: number;
  empty: boolean;
  /** Why there is nothing to show, when empty. */
  emptyReason?: string;
  window: { from: string; to: string; days: number };
  spend: { windowUsd: number; perMonthUsd: number; calls: number; tokens: number };
  /** Claude (or ChatGPT) plan value at API prices, when a plan is known. */
  plan: {
    label: string;
    priceUsd: number;
    valueMonthlyUsd: number;
    multiple: number;
    /** What a 5-hour window holds, learned from limit hits. */
    limitUsd: number | null;
    current: { usd: number; end: string; share: number | null } | null;
  } | null;
  allIn: {
    share: number;
    monthlyUsd: number;
    moreWork: number;
    parts: Array<{ rule: string; label: string; tier: Tier; share: number }>;
  } | null;
  savings: { clearMonthlyUsd: number; likelyMonthlyUsd: number };
  biggestWin: (FixItem & { share: number; moreWork: number }) | null;
  breakdown: { reread: number; output: number; cacheWrite: number; input: number; tools: number };
  fixes: FixItem[];
  /** Listed fixes under the floor, folded into "+N smaller". */
  smaller: number;
  compaction: { at: number | null; ours: boolean; since: string | null };
  guard: { on: boolean; catches: number; savedUsd: number; recent: GuardCatch[] };
  results: ResultItem[];
  /** "Last 7 days: ..." from weekCompare, or null without two weeks behind it. */
  week: string | null;
  rate: { usdPerPercent: number; basis: string } | null;
  /** Conversation titles by session id. */
  titles: Record<string, string>;
  /** Main-thread Claude Code calls from the last two hours, to seed the live watch. */
  recent: unknown[];
  firstLook: { fact: string; why: string } | null;
}

export interface LiveConvo {
  sessionId: string;
  title: string;
  project: string;
  model: string;
  /** Claude Code's effort on its latest call, when the transcript says. */
  effort: string | null;
  context: number;
  /** Epoch ms the cache is gone; null when nobody knows. */
  expiresAt: number | null;
  rewriteUsd: number;
  readUsd: number;
  lastAt: number;
}

export interface LiveState {
  now: number;
  /** This folder's newest Claude Code conversation. */
  convo: LiveConvo | null;
  /** Other long conversations that are still warm. */
  warm: LiveConvo[];
  fiveHour: { percent: number; resetsAt: string | null; basis: "claude" | "estimate" } | null;
  lastTurn: {
    sessionId: string;
    title: string;
    workMs: number;
    costUsd: number;
    percent: number | null;
    at: number;
  } | null;
  /** Cold returns seen since VS Code started. */
  cold: { count: number; usd: number };
}

export interface ViewState {
  snapshot: Snapshot | null;
  live: LiveState;
  loading: boolean;
  error: string | null;
  /** The action in flight, so its button can show it is working. */
  busy: string | null;
  cli: "found" | "missing" | "unknown";
}

export type FromView =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "guard"; on: boolean }
  | { type: "compact"; on: boolean }
  | { type: "done"; rule: string }
  | { type: "undoDone"; rule: string }
  | { type: "openReport" }
  | { type: "openSettings" }
  | { type: "link"; url: string };

export type ToView =
  | { type: "state"; state: ViewState }
  | { type: "live"; live: LiveState; busy: string | null }
  | { type: "toast"; ok: boolean; text: string };
