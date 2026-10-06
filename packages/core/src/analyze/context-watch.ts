import type { UsageEvent } from "../domain/types.js";
import { COMPACT_AT } from "./rules.js";
import { contextOf } from "./tasks.js";

/**
 * What `live` says about context as it happens: a single call that pulled a lot
 * into the conversation, and a conversation that has grown past the point where
 * compacting would pay. A big steady context is not news; a jump, or crossing
 * the line, is. Main conversations only: a subagent starts empty.
 */

/** Tokens added in one call that are worth a word. */
export const CONTEXT_JUMP = 50_000;

export interface ContextNotice {
  kind: "jump" | "long";
  event: UsageEvent;
  /** The conversation's context with this call. */
  contextTokens: number;
  /** For a jump: how much this one call added. */
  added?: number;
  /** What re-reading the conversation cost on this call, in dollars. */
  rereadUsd: number;
}

export function createContextWatch(opts: { jump?: number; long?: number } = {}) {
  const jump = opts.jump ?? CONTEXT_JUMP;
  const long = opts.long ?? COMPACT_AT;
  const last = new Map<string, number>();
  const told = new Set<string>();

  return {
    push(e: UsageEvent): ContextNotice[] {
      if ((e.source !== "claude-code" && e.source !== "codex") || e.isSubagent) return [];
      const key = `${e.sessionId}|${e.contextEpoch ?? 0}`;
      const context = contextOf(e);
      const before = last.get(key);
      last.set(key, context);
      const notices: ContextNotice[] = [];
      const base = { event: e, contextTokens: context, rereadUsd: e.cost.cacheRead };
      if (before !== undefined && context - before >= jump) {
        notices.push({ kind: "jump", added: context - before, ...base });
      }
      if (context > long && !told.has(key)) {
        told.add(key);
        notices.push({ kind: "long", ...base });
      }
      return notices;
    },
  };
}
