import type { Dataset, UsageEvent } from "../domain/types.js";
import { coldResumes } from "./cold.js";
import { COMPACT_AT } from "./rules.js";
import { contextOf } from "./tasks.js";

/**
 * `optimaizr sessions`: what the sessions look like, measured. How long they run,
 * how big the conversation gets, where re-reading takes over, and whether the
 * money sits in a few long sessions or many medium ones. Facts only, no savings.
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
  coldResumes: { count: number; tokens: number; costUsd: number; warmUsd: number };
}

const CONTEXT_BANDS = [0, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000];
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
    };
  });

  let read = 0;
  let inputSide = 0;
  for (const e of events) {
    read += e.cacheReadTokens;
    inputSide += e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  }

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
    coldResumes: {
      count: cold.length,
      tokens: cold.reduce((s, c) => s + c.rewriteTokens, 0),
      costUsd: cold.reduce((s, c) => s + c.rewriteUsd, 0),
      warmUsd: cold.reduce((s, c) => s + c.warmUsd, 0),
    },
  };
}
