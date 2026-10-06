// Pure helpers for register.tsx. Nothing here touches `$`, so the figures the
// band, the spinner and /optimaizr show can be tested on their own.

import { PRICES, type Price } from "./prices.ts";

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string };

/** One reading of the 5-hour window: when, and how full. */
export type Sample = { t: number; pct: number };

/** The readings of one 5-hour window, kept in $.store so every session shares them. */
export type Window = { resetsAt: string; samples: Sample[] };

/** An entry of ~/.optimaizr/overrides.json, as `optimaizr live` writes it. */
export type Override = {
  rule: string;
  source?: string;
  project: string;
  subagent?: boolean;
  from: string;
  to: string;
  /** An effort switch: the same model, asked to think less. */
  effort?: string;
  /** Applied by `optimaizr live --auto`, with no one pressing Y. */
  auto?: boolean;
};

/** A request's token counts, as the API reports them. */
export type Tokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const fiveHour = (limits: readonly RateLimit[] | undefined) =>
  limits?.find((l) => l.kind === "five_hour");

export const sevenDay = (limits: readonly RateLimit[] | undefined) =>
  limits?.find((l) => l.kind === "seven_day");

/**
 * The meters as the session file carries them, so `optimaizr profile` and
 * `optimaizr live` can show Claude Code's real windows. Undefined when neither
 * meter is reported (an API-key session has none).
 */
export function windowsOf(limits: readonly RateLimit[] | undefined, at: number) {
  const pick = (l: RateLimit | undefined) =>
    l ? { percentUsed: l.percentUsed, ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}) } : undefined;
  const five = pick(fiveHour(limits));
  const seven = pick(sevenDay(limits));
  if (!five && !seven) return undefined;
  return {
    at: new Date(at).toISOString(),
    ...(five ? { fiveHour: five } : {}),
    ...(seven ? { sevenDay: seven } : {}),
  };
}

/** `claude-opus-5-5[1m]` and `claude-opus-5-5-20260915` are `claude-opus-5-5`. */
export function baseModel(id: string): string {
  return id
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

/** `claude-sonnet-5-5` is `Sonnet 5.5`; an id it can't read is shown as given. */
export function modelLabel(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(baseModel(id));
  if (!m) return id;
  const family = m[1]!;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function percent(n: number): string {
  return `${Math.round(n)}%`;
}

/** `45m`, `2h 05m`. */
export function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / MINUTE));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Local wall-clock time, `01:00`. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A saving as a share of the 5-hour window, from how far the window moved
 * against what was spent meanwhile. Null until it has moved a whole point;
 * other sessions on the account move it too, so it is an estimate.
 */
export function windowShare(saved: number, spent: { usd: number; pct: number }): number | null {
  if (spent.pct < 1 || spent.usd <= 0 || saved <= 0) return null;
  return saved / (spent.usd / spent.pct);
}

/** `0.4%`, `2.1%`, `12%`. */
export function share(pct: number): string {
  return pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/** The meter's colour as the window fills: calm, then a warning, then urgent. */
export function meterColor(pct: number): "green" | "yellow" | "red" {
  return pct < 60 ? "green" : pct < 85 ? "yellow" : "red";
}

/** A sparkline of turn costs, one cell each, scaled to the largest. */
export function sparkline(values: readonly number[]): string {
  const cells = "▁▂▃▄▅▆▇█";
  const top = Math.max(...values, 0);
  return values.map((v) => cells[top > 0 ? Math.min(7, Math.round((v / top) * 7)) : 0]).join("");
}

/** The window levels that earn a toast, and the session savings that do. */
export const WINDOW_ALERTS = [80, 95];
export const SAVED_MILESTONES = [0.5, 1, 2, 5, 10, 20, 50];

/** The highest threshold crossed going from `was` to `now`, if any. */
export function crossed(thresholds: readonly number[], was: number, now: number): number | null {
  const hit = thresholds.filter((t) => was < t && now >= t);
  return hit.length > 0 ? hit[hit.length - 1]! : null;
}

/** The filled and empty halves of a meter `width` cells wide. */
export function bar(pct: number, width: number): [string, string] {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return ["█".repeat(n), "░".repeat(width - n)];
}

function projectName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;
}

/** `shop-api subagents: Opus 5.5 → Sonnet 5.5`, or `shop-api: Opus 5.5 at low effort`. */
export function describeSwitch(o: Override): string {
  const who = o.subagent === true ? " subagents" : o.subagent === false ? " main" : "";
  const what = o.effort
    ? `${modelLabel(o.from)} at ${o.effort} effort`
    : `${modelLabel(o.from)} → ${modelLabel(o.to)}`;
  return `${projectName(o.project)}${who}: ${what}`;
}

function isOverride(v: unknown): v is Override {
  const o = v as Override;
  return (
    typeof o === "object" &&
    o !== null &&
    o.source === "claude-code" &&
    typeof o.rule === "string" &&
    typeof o.project === "string" &&
    typeof o.from === "string" &&
    typeof o.to === "string" &&
    (o.subagent === undefined || typeof o.subagent === "boolean") &&
    (o.effort === undefined || EFFORTS.includes(o.effort)) &&
    (o.auto === undefined || typeof o.auto === "boolean")
  );
}

/** Claude Code's entries of overrides.json; anything unreadable is no switch at all. */
export function parseOverrides(text: string): Override[] {
  try {
    const file = JSON.parse(text) as { overrides?: unknown };
    return Array.isArray(file?.overrides) ? file.overrides.filter(isOverride) : [];
  } catch {
    return [];
  }
}

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Is `cwd` the project, or a folder inside it? */
export function inProject(cwd: string, project: string): boolean {
  const c = slash(cwd);
  const p = slash(project);
  return c === p || c.startsWith(`${p}/`);
}

const covers = (o: Override, req: { cwd: string; model: string; subagent: boolean }) =>
  inProject(req.cwd, o.project) &&
  (o.subagent === undefined || o.subagent === req.subagent) &&
  baseModel(o.from) === baseModel(req.model);

/** The model switch for one request: its project, agent and model. */
export function switchFor(
  list: readonly Override[],
  req: { cwd: string; model: string; subagent: boolean },
): Override | undefined {
  return list.find((o) => !o.effort && covers(o, req) && baseModel(o.to) !== baseModel(req.model));
}

/** Lowest first. A number, or a level not listed, is never lowered. */
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The effort switch for one request, only when it asks for less than the request does. */
export function effortFor(
  list: readonly Override[],
  req: { cwd: string; model: string; subagent: boolean; effort?: string | number },
): Override | undefined {
  const now = typeof req.effort === "string" ? EFFORTS.indexOf(req.effort) : -1;
  return list.find(
    (o) => o.effort !== undefined && covers(o, req) && EFFORTS.indexOf(o.effort) < now,
  );
}

const priceOf = (model: string): Price | undefined => PRICES[baseModel(model)];

/**
 * What a request's tokens cost at a model's rates. `warm`: its cache writes would
 * have been reads. `hour`: the main conversation caches for an hour, at 2x input;
 * subagents for 5 minutes, at 1.25x, as the engine prices them.
 */
export function costAt(
  model: string,
  t: Tokens,
  opts: { warm?: boolean; hour?: boolean } = {},
): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const write = opts.warm ? p.cacheRead : opts.hour ? p.cacheWrite1h : p.cacheWrite;
  return (
    (t.input_tokens * p.input +
      t.output_tokens * p.output +
      t.cache_read_input_tokens * p.cacheRead +
      t.cache_creation_input_tokens * write) /
    1_000_000
  );
}

/**
 * What a switched request saved: the same tokens at the original model's rates,
 * less what they cost on the new one. The first request on the new model writes
 * the conversation to its cache, where the original model would have read it,
 * so that one is priced warm and can come out negative.
 */
/** What reloading a conversation of `contextTokens` into the new model's cache costs, over reading it on the old one. */
export function reloadCost(o: Override, contextTokens: number): number | null {
  const from = priceOf(o.from);
  const to = priceOf(o.to);
  if (!from || !to) return null;
  return (contextTokens * (to.cacheWrite1h - from.cacheRead)) / 1_000_000;
}

// Switching a conversation under way waits until the reload is won back within this many requests.
export const PAYBACK_REQUESTS = 10;

/**
 * Requests until a mid-conversation switch pays for its reload, from this
 * session's average request. Infinity when a request saves nothing.
 */
export function paybackRequests(o: Override, contextTokens: number, avg: Tokens): number {
  const reload = reloadCost(o, contextTokens);
  const was = costAt(o.from, avg, { hour: true });
  const is = costAt(o.to, avg, { hour: true });
  if (reload === null || was === null || is === null) return Infinity;
  if (reload <= 0) return 0;
  return was > is ? reload / (was - is) : Infinity;
}

export function savedBy(o: Override, t: Tokens, first: boolean, hour = true): number | null {
  const was = costAt(o.from, t, { warm: first, hour });
  const is = costAt(o.to, t, { hour });
  return was === null || is === null ? null : was - is;
}

export function isWindow(v: unknown): v is Window {
  const w = v as Window;
  return (
    typeof w === "object" &&
    w !== null &&
    typeof w.resetsAt === "string" &&
    Array.isArray(w.samples)
  );
}

/** Add a reading. A new window, or one that went down, starts the history over. */
export function record(w: Window | undefined, limit: RateLimit, t: number): Window {
  const resetsAt = limit.resetsAt ?? "";
  const pct = limit.percentUsed;
  const last = w?.samples.at(-1);
  if (!w || w.resetsAt !== resetsAt || (last && pct < last.pct)) {
    return { resetsAt, samples: [{ t, pct }] };
  }
  if (last && last.pct === pct) return w;
  return { resetsAt, samples: [...w.samples, { t, pct }].slice(-120) };
}

/**
 * When the window runs out at the pace of the last hour, as epoch ms. Null
 * until there are 10 minutes and one point of use to go on.
 */
export function runsOutAt(w: Window): number | null {
  const last = w.samples.at(-1);
  const base = w.samples.find((s) => last && s.t >= last.t - HOUR);
  if (!last || !base) return null;
  const span = last.t - base.t;
  const used = last.pct - base.pct;
  if (span < 10 * MINUTE || used < 1) return null;
  return last.t + ((100 - last.pct) / used) * span;
}

/** What follows the percent in the band: the pace, then the reset. */
export function windowNote(five: RateLimit, w: Window | undefined, now: number): string {
  const resets = five.resetsAt ? clock(five.resetsAt) : null;
  const end = w && w.resetsAt === (five.resetsAt ?? "") ? runsOutAt(w) : null;
  const resetAt = five.resetsAt ? Date.parse(five.resetsAt) : null;
  if (end !== null && resetAt !== null && end >= resetAt) return ` · lasts to the ${resets} reset`;
  const pace = end === null ? "" : ` · ~${duration(Math.max(0, end - now))} left at this pace`;
  return `${pace}${resets ? ` · resets ${resets}` : ""}`;
}

/** What the spinner shows after its word: the switched model, the turn so far, the window. */
export function meterText(m: {
  usd: number | null;
  five?: RateLimit;
  model?: string;
  saved?: number;
}): string {
  const parts: string[] = [];
  if (m.model) parts.push(m.model);
  if (m.usd !== null && m.usd >= 0.005) parts.push(usd(m.usd));
  if (m.saved !== undefined && m.saved >= 0.005) parts.push(`saved ${usd(m.saved)}`);
  if (m.five) parts.push(`${percent(m.five.percentUsed)} of 5h`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The line under an answer. Claude Code puts the plugin's name in front of it.
 * A switched turn leads with what it saved, so the difference reads first.
 */
export function turnLine(t: {
  usd: number;
  calls: number;
  /** The model switch this turn ran under: labels, and what it saved (null: unpriced). */
  switched?: { from: string; to: string; saved: number | null };
  effort?: string;
  held?: number;
  before?: number;
  after?: number;
}): string {
  const parts: string[] = [];
  const s = t.switched;
  if (s && s.saved !== null && s.saved >= 0.005) {
    parts.push(`saved ${usd(s.saved)} vs ${s.from}`, `this turn ${usd(t.usd)} on ${s.to}`);
  } else if (s) {
    parts.push(`this turn ${usd(t.usd)} on ${s.to}`);
  } else {
    parts.push(`this turn ${usd(t.usd)}${t.effort ? ` at ${t.effort} effort` : ""}`);
  }
  parts.push(plural(t.calls, "request"));
  if (s && s.saved !== null && s.saved <= -0.005) {
    parts.push(`${usd(-s.saved)} more than ${s.from} once, to load the conversation`);
  }
  if (t.held) parts.push(`${plural(t.held, "retry", "retries")} held`);
  if (t.before !== undefined && t.after !== undefined) {
    parts.push(`5h ${percent(t.before)} → ${percent(t.after)}`);
  }
  return parts.join(" · ");
}

/** What /optimaizr prints. */
export function summary(s: {
  usd?: number;
  requests: number;
  startedAt: number;
  limits: readonly RateLimit[];
  window?: Window;
  now: number;
  switches: readonly Override[];
  paused?: boolean;
  /** Net saving of this session's switched requests, when any were priced. */
  saved?: number;
  held?: number;
  /** What each recent turn cost, oldest first. */
  turns?: readonly number[];
  /** Why a switch for this conversation is waiting, when one is. */
  note?: string;
}): string {
  const rows: Array<[string, string]> = [];
  const onPlan = s.limits.length > 0;
  const spent = s.usd === undefined ? "not reported" : usd(s.usd);
  rows.push([
    "Spend",
    `${spent}${onPlan ? " at API rates" : ""} over ${plural(s.requests, "request")} since ${clock(new Date(s.startedAt).toISOString())}`,
  ]);
  if (s.saved !== undefined && s.saved < 0) {
    rows.push([
      "Saved",
      `not yet: reloading the conversation cost ${usd(-s.saved)} more than the switch has saved so far`,
    ]);
  } else if (s.saved !== undefined) {
    rows.push([
      "Saved",
      `${usd(s.saved)} by switching models: the same tokens at the original model's rates, less what they cost`,
    ]);
  }
  if (s.held) rows.push(["Guard", `${plural(s.held, "retry", "retries")} held`]);
  if (s.turns && s.turns.length > 1) {
    rows.push([
      "Turns",
      `${sparkline(s.turns)}  last ${s.turns.length}, up to ${usd(Math.max(...s.turns))}`,
    ]);
  }
  const five = fiveHour(s.limits);
  if (five)
    rows.push(["5h window", `${percent(five.percentUsed)}${windowNote(five, s.window, s.now)}`]);
  const week = sevenDay(s.limits);
  if (week) {
    const resets = week.resetsAt
      ? ` · resets ${new Date(week.resetsAt).toDateString().slice(0, 3)} ${clock(week.resetsAt)}`
      : "";
    rows.push(["7d window", `${percent(week.percentUsed)}${resets}`]);
  }
  for (const [i, o] of s.switches.entries()) {
    const how = s.paused
      ? "off in this session: /optimaizr on"
      : `/optimaizr off here, optimaizr undo ${o.rule} everywhere`;
    rows.push([i === 0 ? "Switch" : "", `${describeSwitch(o)} · ${how}`]);
  }
  if (s.switches.length === 0) rows.push(["Switch", "none: accept one with Y in optimaizr live"]);
  if (s.note) rows.push(["", s.note.replace(/^waiting\s+/, "waiting: ")]);
  return rows.map(([k, v]) => `${k.padEnd(11)}${v}`).join("\n");
}
