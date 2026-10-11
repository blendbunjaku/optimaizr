import type { UsageEvent } from "../domain/types.js";
import {
  type CacheSeen,
  cacheMinutes,
  coldReturn,
  emptySeen,
  mainConversations,
  REWRITE_SHARE,
  see,
} from "./cold.js";
import { contextOf } from "./tasks.js";

/**
 * Why a call wrote to the cache. A write costs 1.25x the input rate (5-minute
 * cache) or 2x (1-hour), so the causes that write existing context again are
 * the ones to look at.
 */
export type WriteCause =
  | "growth" // new messages and tool results, written once
  | "start" // a new conversation, or a short one picked up after a break
  | "compaction" // the summary a compaction leaves behind
  | "subagent" // each subagent starts empty and writes its own context
  | "break" // a long conversation picked up after its cache expired
  | "rebuilt" // most of the context written again while the cache was warm
  | "model"; // a switch of model: each model has its own cache

/** The causes that wrote again what the cache already held. */
export const REWRITE_CAUSES: readonly WriteCause[] = ["break", "rebuilt", "model"];

const ORDER: readonly WriteCause[] = [
  "growth",
  "start",
  "compaction",
  "subagent",
  ...REWRITE_CAUSES,
];

export interface WriteCauseRow {
  cause: WriteCause;
  /** Calls it happened on; runs for subagents. */
  times: number;
  tokens: number;
  costUsd: number;
  /** Share of all cache-write spend. */
  share: number;
}

export function writeOf(e: UsageEvent): number {
  return e.cacheWrite5mTokens + e.cacheWrite1hTokens;
}

function mainCause(prev: UsageEvent | undefined, e: UsageEvent, before: CacheSeen): WriteCause {
  if (!prev) return (e.contextEpoch ?? 0) > 0 ? "compaction" : "start";
  if (coldReturn(prev, e, before)) return "break";
  if (writeOf(e) < contextOf(e) * REWRITE_SHARE) return "growth";
  // Back after the cache expired, but too short to be a cold return: about a fresh start.
  const gapMinutes = (Date.parse(e.ts) - Date.parse(prev.ts)) / 60_000;
  if (gapMinutes >= (cacheMinutes(before, e) ?? 0)) return "start";
  return e.model === prev.model ? "rebuilt" : "model";
}

/** Every call that wrote to the cache, with why. */
export function writeCauses(events: UsageEvent[]): Array<{ event: UsageEvent; cause: WriteCause }> {
  const out: Array<{ event: UsageEvent; cause: WriteCause }> = [];
  for (const e of events) {
    if (e.isSubagent && writeOf(e) > 0) out.push({ event: e, cause: "subagent" });
  }
  for (const conversation of mainConversations(events)) {
    const seen = emptySeen();
    conversation.forEach((e, i) => {
      if (writeOf(e) > 0) out.push({ event: e, cause: mainCause(conversation[i - 1], e, seen) });
      see(seen, e);
    });
  }
  return out;
}

/** Cache-write spend by cause, in a fixed order. */
export function writesByCause(events: UsageEvent[]): WriteCauseRow[] {
  const rows = new Map<WriteCause, WriteCauseRow>(
    ORDER.map((cause) => [cause, { cause, times: 0, tokens: 0, costUsd: 0, share: 0 }]),
  );
  const runs = new Set<string>();
  for (const { event: e, cause } of writeCauses(events)) {
    const row = rows.get(cause)!;
    row.tokens += writeOf(e);
    row.costUsd += e.cost.cacheWrite;
    if (cause === "subagent") runs.add(`${e.sessionId}|${e.turnId ?? ""}`);
    else row.times++;
  }
  rows.get("subagent")!.times = runs.size;
  const total = [...rows.values()].reduce((s, r) => s + r.costUsd, 0);
  for (const r of rows.values()) r.share = total > 0 ? r.costUsd / total : 0;
  return [...rows.values()];
}
