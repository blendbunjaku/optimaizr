import type { UsageEvent } from "../domain/types.js";
import { priceFor, ratesFor } from "../pricing.js";
import {
  type CacheSeen,
  cacheMinutes,
  COLD_MIN_CONTEXT,
  type ColdResume,
  coldReturn,
  emptySeen,
  see,
} from "./cold.js";
import { contextOf } from "./tasks.js";

/**
 * What `live` and `optimaizr statusline` say about the cache as it happens: how
 * long a long conversation stays warm, a warning shortly before it expires, and
 * what coming back cost once it had. Main conversations only.
 */

/** The warning comes this long before the cache expires. */
export const EXPIRY_WARN_MS = 5 * 60_000;
/** And only when coming back after would cost at least this. */
export const EXPIRY_WARN_USD = 0.5;
/** The countdown shows over this last stretch. */
export const COUNTDOWN_MS = 15 * 60_000;
/**
 * A call's time is when it finished, but the cache was touched when it
 * started, so expiry is called a twelfth early: 55 minutes for the 1-hour cache.
 */
const EARLY = 1 / 12;
const M = 1_000_000;

export interface CacheState {
  /** The conversation's last call. */
  event: UsageEvent;
  context: number;
  /** When the cache is gone, in ms; null where the provider decides (Codex). */
  expiresAt: number | null;
  /** Reading the conversation from a warm cache, on one call. */
  readUsd: number;
  /** Paying for all of it again once the cache is gone. */
  rewriteUsd: number;
}

function stateOf(e: UsageEvent, seen: CacheSeen): CacheState {
  const context = contextOf(e);
  const ttl = cacheMinutes(seen, e);
  const wrote = seen.w5 + seen.w1 > 0;
  const price = priceFor(e.model);
  const r = price
    ? ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch, promptTokens: context })
    : null;
  const again = !r
    ? 0
    : ttl === null
      ? r.inputPerM
      : ttl === 60
        ? r.cacheWrite1hPerM
        : r.cacheWrite5mPerM;
  return {
    event: e,
    context,
    expiresAt: ttl === null || !wrote ? null : Date.parse(e.ts) + ttl * 60_000 * (1 - EARLY),
    readUsd: r ? (context * r.cachedInputPerM) / M : 0,
    rewriteUsd: (context * again) / M,
  };
}

export function createCacheWatch(
  opts: { warnMs?: number; warnUsd?: number; minContext?: number } = {},
) {
  const warnMs = opts.warnMs ?? EXPIRY_WARN_MS;
  const warnUsd = opts.warnUsd ?? EXPIRY_WARN_USD;
  const minContext = opts.minContext ?? COLD_MIN_CONTEXT;
  const conversations = new Map<string, { seen: CacheSeen; state: CacheState; warned: boolean }>();

  return {
    /** Fold in a call. Returns the cold return it was, if it was one. */
    push(e: UsageEvent): ColdResume | null {
      if ((e.source !== "claude-code" && e.source !== "codex") || e.isSubagent) return null;
      const key = `${e.sessionId}|${e.contextEpoch ?? 0}`;
      const c = conversations.get(key);
      if (!c) {
        const seen = emptySeen();
        see(seen, e);
        conversations.set(key, { seen, state: stateOf(e, seen), warned: false });
        return null;
      }
      // A call older than the last one seen changes nothing about now.
      if (e.ts < c.state.event.ts) {
        see(c.seen, e);
        return null;
      }
      const cold = coldReturn(c.state.event, e, c.seen);
      see(c.seen, e);
      c.state = stateOf(e, c.seen);
      c.warned = false;
      return cold;
    },

    /** Long conversations whose cache expires within the warning window, each once. */
    expiring(now: number): CacheState[] {
      const out: CacheState[] = [];
      for (const c of conversations.values()) {
        const s = c.state;
        if (c.warned || s.expiresAt === null || s.context < minContext) continue;
        const left = s.expiresAt - now;
        if (left <= 0 || left > warnMs || s.rewriteUsd < warnUsd) continue;
        c.warned = true;
        out.push(s);
      }
      return out;
    },

    /**
     * Long conversations that are still warm, soonest to expire first. Codex
     * ones, whose expiry nobody knows, follow while idle under an hour.
     */
    warm(now: number): CacheState[] {
      return [...conversations.values()]
        .map((c) => c.state)
        .filter(
          (s) =>
            s.context >= minContext &&
            (s.expiresAt === null ? now - Date.parse(s.event.ts) < 60 * 60_000 : s.expiresAt > now),
        )
        .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
    },

    /** The most recent conversation, whatever its size: what a status line shows. */
    latest(): CacheState | null {
      let best: CacheState | null = null;
      for (const c of conversations.values()) {
        if (!best || c.state.event.ts > best.event.ts) best = c.state;
      }
      return best;
    },
  };
}

export type CacheWatch = ReturnType<typeof createCacheWatch>;
