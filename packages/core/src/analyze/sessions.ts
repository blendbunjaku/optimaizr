import type { Dataset, UsageEvent } from "../domain/types.js";
import { coldResumes, waitedOn } from "./cold.js";
import { filesReadAgain } from "./results.js";
import { COMPACT_AT } from "./rules.js";
import { contextOf } from "./tasks.js";
import { REWRITE_CAUSES, writeOf, writesByCause, type WriteCauseRow } from "./writes.js";

/**
 * `optimaizr sessions`: what the sessions look like, measured. How long they run,
 * how big the conversation gets, where re-reading takes over, what the cache
 * writes were for, and whether the money sits in a few long sessions or many
 * medium ones. Facts only, no savings.
 */

export interface Spread {
  median: number;
  p90: number;
}

export interface ContextBand {
  /** Context size at the start of the band, in tokens. */
  from: number;
  /** Where it ends, or null for the last band. */
  to: number | null;
  calls: number;
  costUsd: number;
  /** This band's share of main-conversation spend. */
  share: number;
  /** The share of this band's spend that went on re-reading the conversation. */
  rereadShare: number;
}

export interface SessionBand {
  /** Calls per session at the start of the band. */
  from: number;
  to: number | null;
  sessions: number;
  costUsd: number;
  share: number;
}

export interface SessionStats {
  sessions: number;
  calls: number;
  costUsd: number;
  /** Cached input over all input: fresh, cached and cache writes. */
  cacheHitRate: number;
  callsPerSession: Spread;
  turnsPerSession: Spread;
  /** The largest conversation each session reached. */
  peakContext: Spread;
  /** Main-conversation calls by how much conversation they carried. */
  byContext: ContextBand[];
  /** The smallest band where re-reading is half its spend or more, or null. */
  rereadHalfAt: number | null;
  bySessionLength: SessionBand[];
  /** The costliest tenth of sessions and their share of spend. */
  topSessions: { count: number; share: number };
  /** Sessions whose conversation passed the compaction lever's window. */
  longSessions: { over: number; count: number; share: number };
  /** Sessions started by `claude -p`, the SDK or `codex exec`. */
  headless: { sessions: number; costUsd: number; share: number };
  coldResumes: ColdReturns;
  cacheWrites: CacheWrites;
  windows: FiveHourWindows;
}

export interface ColdReturns {
  count: number;
  tokens: number;
  costUsd: number;
  warmUsd: number;
  /** After a reply that ended the turn. */
  away: { count: number; costUsd: number };
  /** After Claude asked for a tool: a long command, a subagent or a permission prompt. */
  tool: { count: number; costUsd: number };
  /** On the 5-minute cache, what Claude was waiting on when it expired, most often first. */
  outlasted: Array<{ label: string; times: number; costUsd: number }>;
}

export interface CacheWrites {
  tokens: number;
  costUsd: number;
  /** Writes over every token sent and received. */
  tokenShare: number;
  spendShare: number;
  /** What each session spent on writes. */
  perSession: Spread;
  byCause: WriteCauseRow[];
  /** Breaks, warm rebuilds and model switches together. */
  rewrites: { costUsd: number; share: number };
  /** Written tokens by cache lifetime, and the share kept for an hour. */
  lifetime: { hourTokens: number; fiveTokens: number; hourShare: number };
}

/** One of Claude's five-hour windows and the conversations that spent it. */
export interface FiveHourWindow {
  /** The hour of its first call. */
  start: string;
  costUsd: number;
  /** Costliest first. */
  conversations: Array<{ sessionId: string; costUsd: number; share: number }>;
  /** The most conversations making calls in the same 10 minutes. */
  atOnce: number;
}

export interface FiveHourWindows {
  count: number;
  /** Windows where two or more conversations ran at once, and their share of spend. */
  parallel: number;
  parallelShare: number;
  /** The latest, newest first. */
  recent: FiveHourWindow[];
}

const CONTEXT_BANDS = [0, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000];
const HOUR_MS = 3_600_000;
const SLOT_MS = 10 * 60_000;
const SESSION_BANDS = [1, 50, 150, 400];
/** A band needs this many calls before its re-read share says anything. */
const BAND_MIN_CALLS = 20;

function spread(values: number[]): Spread {
  if (values.length === 0) return { median: 0, p90: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  return { median: at(0.5), p90: at(0.9) };
}

function bandOf(bands: number[], value: number): number {
  let i = 0;
  while (i + 1 < bands.length && value >= bands[i + 1]!) i++;
  return i;
}

export function sessionStats(data: Dataset): SessionStats {
  const events = data.events;
  const costUsd = events.reduce((s, e) => s + e.cost.total, 0);
  const of = (n: number, total: number) => (total > 0 ? n / total : 0);

  const sessions = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const arr = sessions.get(e.sessionId);
    if (arr) arr.push(e);
    else sessions.set(e.sessionId, [e]);
  }
  const rows = [...sessions.values()].map((list) => {
    const main = list.filter((e) => !e.isSubagent);
    return {
      calls: list.length,
      turns: new Set(main.map((e) => e.turnId).filter(Boolean)).size,
      peak: main.reduce((m, e) => Math.max(m, contextOf(e)), 0),
      cost: list.reduce((s, e) => s + e.cost.total, 0),
      writes: list.reduce((s, e) => s + e.cost.cacheWrite, 0),
    };
  });

  let read = 0;
  let inputSide = 0;
  let output = 0;
  let written = 0;
  let writeUsd = 0;
  for (const e of events) {
    read += e.cacheReadTokens;
    inputSide += e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;
    output += e.outputTokens;
    written += writeOf(e);
    writeUsd += e.cost.cacheWrite;
  }
  const byCause = writesByCause(events);
  const rewriteUsd = byCause
    .filter((r) => REWRITE_CAUSES.includes(r.cause))
    .reduce((s, r) => s + r.costUsd, 0);

  const main = events.filter((e) => !e.isSubagent);
  const mainCost = main.reduce((s, e) => s + e.cost.total, 0);
  const byContext: ContextBand[] = CONTEXT_BANDS.map((from, i) => ({
    from,
    to: CONTEXT_BANDS[i + 1] ?? null,
    calls: 0,
    costUsd: 0,
    share: 0,
    rereadShare: 0,
  }));
  const reread = byContext.map(() => 0);
  for (const e of main) {
    const i = bandOf(CONTEXT_BANDS, contextOf(e));
    byContext[i]!.calls++;
    byContext[i]!.costUsd += e.cost.total;
    reread[i]! += e.cost.cacheRead;
  }
  byContext.forEach((b, i) => {
    b.share = of(b.costUsd, mainCost);
    b.rereadShare = of(reread[i]!, b.costUsd);
  });
  const half = byContext.find((b) => b.calls >= BAND_MIN_CALLS && b.rereadShare >= 0.5);

  const bySessionLength: SessionBand[] = SESSION_BANDS.map((from, i) => ({
    from,
    to: SESSION_BANDS[i + 1] ?? null,
    sessions: 0,
    costUsd: 0,
    share: 0,
  }));
  for (const r of rows) {
    const b = bySessionLength[bandOf(SESSION_BANDS, r.calls)]!;
    b.sessions++;
    b.costUsd += r.cost;
  }
  for (const b of bySessionLength) b.share = of(b.costUsd, costUsd);

  const ranked = [...rows].sort((a, b) => b.cost - a.cost);
  const top = Math.max(1, Math.ceil(rows.length * 0.1));
  const long = rows.filter((r) => r.peak > COMPACT_AT);
  const cold = coldResumes(events);
  const kind = (k: "away" | "tool") => {
    const of = cold.filter((c) => c.waiting === k);
    return { count: of.length, costUsd: of.reduce((s, c) => s + c.rewriteUsd, 0) };
  };
  const outlasted = new Map<string, { label: string; times: number; costUsd: number }>();
  for (const c of cold) {
    if (c.waiting !== "tool" || c.ttlMinutes !== 5) continue;
    const label = waitedOn(c.previous);
    const o = outlasted.get(label) ?? { label, times: 0, costUsd: 0 };
    o.times++;
    o.costUsd += c.rewriteUsd;
    outlasted.set(label, o);
  }
  const headless = new Set(events.filter((e) => e.headless).map((e) => e.sessionId));
  const headlessUsd = events
    .filter((e) => headless.has(e.sessionId))
    .reduce((s, e) => s + e.cost.total, 0);
  let hourTokens = 0;
  let fiveTokens = 0;
  for (const e of events) {
    hourTokens += e.cacheWrite1hTokens;
    fiveTokens += e.cacheWrite5mTokens;
  }

  return {
    sessions: rows.length,
    calls: events.length,
    costUsd,
    cacheHitRate: of(read, inputSide),
    callsPerSession: spread(rows.map((r) => r.calls)),
    turnsPerSession: spread(rows.map((r) => r.turns)),
    peakContext: spread(rows.map((r) => r.peak)),
    byContext,
    rereadHalfAt: half ? half.from : null,
    bySessionLength,
    topSessions: {
      count: rows.length > 0 ? top : 0,
      share: of(
        ranked.slice(0, top).reduce((s, r) => s + r.cost, 0),
        costUsd,
      ),
    },
    longSessions: {
      over: COMPACT_AT,
      count: long.length,
      share: of(
        long.reduce((s, r) => s + r.cost, 0),
        costUsd,
      ),
    },
    headless: { sessions: headless.size, costUsd: headlessUsd, share: of(headlessUsd, costUsd) },
    coldResumes: {
      count: cold.length,
      tokens: cold.reduce((s, c) => s + c.rewriteTokens, 0),
      costUsd: cold.reduce((s, c) => s + c.rewriteUsd, 0),
      warmUsd: cold.reduce((s, c) => s + c.warmUsd, 0),
      away: kind("away"),
      tool: kind("tool"),
      outlasted: [...outlasted.values()].sort((a, b) => b.times - a.times || b.costUsd - a.costUsd),
    },
    cacheWrites: {
      tokens: written,
      costUsd: writeUsd,
      tokenShare: of(written, inputSide + output),
      spendShare: of(writeUsd, costUsd),
      perSession: spread(rows.map((r) => r.writes)),
      byCause,
      rewrites: { costUsd: rewriteUsd, share: of(rewriteUsd, writeUsd) },
      lifetime: { hourTokens, fiveTokens, hourShare: of(hourTokens, hourTokens + fiveTokens) },
    },
    windows: fiveHourWindows(events),
  };
}

/**
 * Claude Code's calls in five-hour windows: one opens at the hour of the first
 * call after the last one closed. Each says which conversations spent it and
 * how many were running at once.
 */
export function fiveHourWindows(events: readonly UsageEvent[], keep = 5): FiveHourWindows {
  const calls = events
    .filter((e) => e.source === "claude-code")
    .map((e) => ({ t: Date.parse(e.ts), e }))
    .filter((c) => Number.isFinite(c.t))
    .sort((a, b) => a.t - b.t);
  const windows: FiveHourWindow[] = [];
  let i = 0;
  while (i < calls.length) {
    const start = Math.floor(calls[i]!.t / HOUR_MS) * HOUR_MS;
    const end = start + 5 * HOUR_MS;
    const by = new Map<string, number>();
    const slots = new Map<number, Set<string>>();
    let cost = 0;
    for (; i < calls.length && calls[i]!.t < end; i++) {
      const { t, e } = calls[i]!;
      cost += e.cost.total;
      by.set(e.sessionId, (by.get(e.sessionId) ?? 0) + e.cost.total);
      const slot = Math.floor((t - start) / SLOT_MS);
      const busy = slots.get(slot) ?? new Set<string>();
      busy.add(e.sessionId);
      slots.set(slot, busy);
    }
    windows.push({
      start: new Date(start).toISOString(),
      costUsd: cost,
      conversations: [...by]
        .map(([sessionId, usd]) => ({ sessionId, costUsd: usd, share: cost > 0 ? usd / cost : 0 }))
        .sort((a, b) => b.costUsd - a.costUsd),
      atOnce: Math.max(0, ...[...slots.values()].map((s) => s.size)),
    });
  }
  const parallel = windows.filter((w) => w.atOnce >= 2);
  const total = windows.reduce((s, w) => s + w.costUsd, 0);
  return {
    count: windows.length,
    parallel: parallel.length,
    parallelShare: total > 0 ? parallel.reduce((s, w) => s + w.costUsd, 0) / total : 0,
    recent: windows.slice(-keep).reverse(),
  };
}

/** A conversation guard started from a note, and the one the note came from. */
export interface NoteStart {
  session: string;
  from: string;
}

/** How a conversation went on after a fresh start or a compaction. */
export interface StartFacts {
  count: number;
  /** The first call's context, median. */
  firstCall: number;
  /** What the person waited through before it, median: the summary, or nothing for a note. */
  waitMs: number;
  /** Files the work had touched before and read again after, on average. */
  readAgain: number;
  callsPerPrompt: number | null;
}

/**
 * Picking up from guard's note after a /clear, against picking up after a
 * compaction. Null until there is at least one of each.
 */
export function noteVsCompaction(
  data: Pick<Dataset, "events" | "compactions">,
  notes: readonly NoteStart[],
): { note: StartFacts; compaction: StartFacts } | null {
  const main = new Map<string, UsageEvent[]>();
  for (const e of data.events) {
    if (e.isSubagent || e.source !== "claude-code") continue;
    const list = main.get(e.sessionId) ?? [];
    list.push(e);
    main.set(e.sessionId, list);
  }
  for (const list of main.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  const comps = (data.compactions ?? []).filter((c) => main.has(c.sessionId));
  const started = notes.filter((n) => main.has(n.session));
  if (comps.length === 0 || started.length === 0) return null;

  const facts = (spans: UsageEvent[][], waits: number[], again: number[]): StartFacts => {
    const prompts = spans.reduce(
      (s, span) => s + new Set(span.map((e) => e.turnId).filter(Boolean)).size,
      0,
    );
    const calls = spans.reduce((s, span) => s + span.length, 0);
    return {
      count: spans.length,
      firstCall: spread(spans.filter((s) => s.length > 0).map((s) => contextOf(s[0]!))).median,
      waitMs: spread(waits).median,
      readAgain: again.length > 0 ? again.reduce((s, n) => s + n, 0) / again.length : 0,
      callsPerPrompt: prompts > 0 ? calls / prompts : null,
    };
  };

  const times = new Map<string, number[]>();
  for (const c of comps)
    times.set(c.sessionId, [...(times.get(c.sessionId) ?? []), Date.parse(c.ts)]);
  const after = comps.map((c) => {
    const at = Date.parse(c.ts);
    const next = Math.min(...times.get(c.sessionId)!.filter((t) => t > at), Infinity);
    return main.get(c.sessionId)!.filter((e) => {
      const t = Date.parse(e.ts);
      return t >= at && t < next;
    });
  });
  const compaction = facts(
    after,
    comps.flatMap((c) => (c.durationMs === undefined ? [] : [c.durationMs])),
    filesReadAgain(data.events, comps),
  );

  const touched = (session: string) =>
    new Set((main.get(session) ?? []).flatMap((e) => e.tools.map((t) => t.target).filter(Boolean)));
  const note = facts(
    started.map((n) => main.get(n.session)!),
    started.map(() => 0),
    started.map((n) => {
      const before = touched(n.from);
      const reads = main
        .get(n.session)!
        .flatMap((e) => e.tools.filter((t) => t.name === "Read" && t.target).map((t) => t.target!));
      return new Set(reads.filter((f) => before.has(f))).size;
    }),
  );
  return { note, compaction };
}
