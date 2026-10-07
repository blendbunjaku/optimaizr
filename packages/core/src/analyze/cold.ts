import { priceFor, ratesFor } from "../pricing.js";
import type { UsageEvent } from "../domain/types.js";
import { contextOf } from "./tasks.js";

/**
 * Cold resumes: coming back to a conversation after its prompt cache expired.
 * The next call can't read the conversation from cache, so it pays for all of
 * it again: written at 1.25x the input rate (Anthropic's 5-minute cache) or 2x
 * (1-hour), or sent at the full input rate where the provider caches on its own
 * (OpenAI, so Codex).
 */

/** Below this, rewriting the conversation costs about what a fresh start does. */
export const COLD_MIN_CONTEXT = 50_000;
/** A call that wrote at least this share of its context started from a cold cache. */
const REWRITE_SHARE = 0.6;
/**
 * OpenAI keeps a cached prefix for a few idle minutes and sets no fixed time,
 * so a miss after at least this long away counts as a return.
 */
export const AUTO_IDLE_MINUTES = 5;
const M = 1_000_000;

export interface ColdResume {
  event: UsageEvent;
  /** The call before it in the same conversation, the last one with a warm cache. */
  previous: UsageEvent;
  gapMinutes: number;
  /** The cache lifetime the conversation was written with; null where the provider decides. */
  ttlMinutes: 5 | 60 | null;
  rewriteTokens: number;
  /** What the rewrite cost. */
  rewriteUsd: number;
  /** What reading the same tokens from a warm cache would have cost. */
  warmUsd: number;
}

/** What a conversation has put in and read from the cache so far. */
export interface CacheSeen {
  w5: number;
  w1: number;
  read: number;
}

export const emptySeen = (): CacheSeen => ({ w5: 0, w1: 0, read: 0 });

export function see(s: CacheSeen, e: UsageEvent): void {
  s.w5 += e.cacheWrite5mTokens;
  s.w1 += e.cacheWrite1hTokens;
  s.read += e.cacheReadTokens;
}

/** Codex reports no cache writes: OpenAI caches on its own and bills a miss as input. */
export function cachesOnItsOwn(e: UsageEvent): boolean {
  return e.source === "codex";
}

/** The cache lifetime a conversation was written with, from its writes so far. */
export function cacheMinutes(s: CacheSeen, e: UsageEvent): 5 | 60 | null {
  if (cachesOnItsOwn(e)) return null;
  return s.w1 >= s.w5 ? 60 : 5;
}

/**
 * The main conversation of each session, split at compactions. Subagents are
 * left out: they start empty and rarely sit idle.
 */
export function mainConversations(events: UsageEvent[]): UsageEvent[][] {
  const out = new Map<string, UsageEvent[]>();
  for (const e of events) {
    if (e.isSubagent) continue;
    const key = `${e.sessionId}|${e.contextEpoch ?? 0}`;
    const arr = out.get(key);
    if (arr) arr.push(e);
    else out.set(key, [e]);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return [...out.values()];
}

/**
 * Whether `e` came back to an expired cache, given what the conversation had
 * cached before it. Shared by the history rule and `optimaizr live`.
 */
export function coldReturn(prev: UsageEvent, e: UsageEvent, before: CacheSeen): ColdResume | null {
  const auto = cachesOnItsOwn(e);
  const hadCache = auto ? before.read > 0 : before.w5 + before.w1 > 0;
  if (!hadCache) return null;

  const ttlMinutes = cacheMinutes(before, e);
  const gapMinutes = (Date.parse(e.ts) - Date.parse(prev.ts)) / 60_000;
  const context = contextOf(e);
  if (gapMinutes < (ttlMinutes ?? AUTO_IDLE_MINUTES) || context < COLD_MIN_CONTEXT) return null;
  const rewriteTokens = auto ? e.inputTokens : e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  if (rewriteTokens < context * REWRITE_SHARE) return null;

  const price = priceFor(e.model);
  if (!price) return null;
  const r = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
  if (auto) {
    // The recorded input cost already carries any long-context rate.
    const warmShare = r.inputPerM > 0 ? r.cachedInputPerM / r.inputPerM : 0;
    return {
      event: e,
      previous: prev,
      gapMinutes,
      ttlMinutes,
      rewriteTokens,
      rewriteUsd: e.cost.input,
      warmUsd: e.cost.input * warmShare,
    };
  }
  return {
    event: e,
    previous: prev,
    gapMinutes,
    ttlMinutes,
    rewriteTokens,
    rewriteUsd:
      (e.cacheWrite5mTokens * r.cacheWrite5mPerM + e.cacheWrite1hTokens * r.cacheWrite1hPerM) / M,
    warmUsd: (rewriteTokens * r.cachedInputPerM) / M,
  };
}

export function coldResumes(events: UsageEvent[]): ColdResume[] {
  const found: ColdResume[] = [];
  for (const conversation of mainConversations(events)) {
    const seen = emptySeen();
    for (let i = 0; i < conversation.length; i++) {
      const e = conversation[i]!;
      const prev = conversation[i - 1];
      // The lifetime of what is in the cache comes from the calls before this one.
      const cold = prev ? coldReturn(prev, e, seen) : null;
      see(seen, e);
      if (cold) found.push(cold);
    }
  }
  return found;
}
