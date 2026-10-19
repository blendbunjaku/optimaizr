import { analyze, COMPACT_AT, downgradeTargetFor, repriced } from "./rules.js";
import { contextOf } from "./tasks.js";
import { priceFor, ratesFor } from "../pricing.js";
import { ruleLabel } from "../report/terminal.js";
import type { Traffic } from "../recommend/actions.js";
import type { OptimizationFinding, UsageEvent } from "../domain/types.js";

/**
 * What `live` looked at when it has nothing to say: each check with what it saw,
 * so a quiet run reads as "checked and fine", not "nothing happened".
 */

export interface LiveCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A choice the user made, said for what it costs, never counted as waste. */
  note?: boolean;
}

export interface LiveChecks {
  calls: number;
  /** Earliest to latest call in the window. */
  spanMs: number;
  checks: LiveCheck[];
  /** Findings over the floor, biggest first. */
  findings: OptimizationFinding[];
}

export interface ChecksOptions {
  /** The live floor: findings under it are reported as fine. */
  minUsd: number;
  /** Where each agent compacts, when set. Unset falls back to the model's window. */
  compactAt?: Partial<Record<UsageEvent["source"], number | null>>;
  /** Long conversations whose cache is still warm, from the cache watch. */
  warm?: Array<{ context: number; expiresAt: number | null }>;
  /** Calls this run that came back to an expired cache, and what they paid. */
  cold?: { count: number; usd: number };
  /** What this run has already printed, so the rules row agrees with it. */
  shown?: { count: number; usd: number };
  now?: number;
}

/** A conversation this big gets what each message costs to re-read it said. */
export const BIG_CONVERSATION = 100_000;

/** What one call costs just to read the conversation back from the cache. */
export function rereadFloor(e: UsageEvent): number | null {
  const price = priceFor(e.model);
  if (!price) return null;
  const context = contextOf(e);
  const r = ratesFor(price, { at: e.ts, promptTokens: context });
  return (context * r.cachedInputPerM) / 1_000_000;
}

/** Below this read share, the cache check fails: much of each call was written again. */
const CACHE_OK = 0.85;
/** A conversation idle longer than this is not "the conversation" any more. */
const ACTIVE_MS = 60 * 60_000;

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function money(n: number): string {
  return n >= 1 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(n >= 0.01 ? 2 : 3)}`;
}

function minutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function liveChecks(events: readonly UsageEvent[], opts: ChecksOptions): LiveChecks {
  const now = opts.now ?? Date.now();
  const times = events.map((e) => Date.parse(e.ts)).filter((t) => Number.isFinite(t));
  const spanMs = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const checks: LiveCheck[] = [];

  // Cache: of everything sent, how much was read back instead of paid in full.
  let read = 0;
  let sent = 0;
  for (const e of events) {
    read += e.cacheReadTokens;
    sent += contextOf(e);
  }
  if (sent > 0) {
    const share = read / sent;
    const pct = `${Math.round(share * 100)}%`;
    checks.push({
      name: "Cache",
      ok: share >= CACHE_OK,
      detail:
        share >= CACHE_OK
          ? `${pct} of what was sent came from the cache`
          : `only ${pct} came from the cache, the rest was paid in full or written again`,
    });
  }

  // Context: each main conversation's latest size against where it compacts.
  // Only the ones used in the last hour; a replayed history has old ones too.
  const latest = new Map<string, UsageEvent>();
  for (const e of events) {
    if (e.isSubagent || e.source === "sdk" || e.source === "import") continue;
    if (now - Date.parse(e.ts) > ACTIVE_MS) continue;
    const before = latest.get(e.sessionId);
    if (!before || e.ts >= before.ts) latest.set(e.sessionId, e);
  }
  let biggest: { e: UsageEvent; size: number; at: number } | null = null;
  for (const e of latest.values()) {
    const size = contextOf(e);
    const at = opts.compactAt?.[e.source] ?? priceFor(e.model)?.contextTokens ?? 0;
    if (!biggest || size > biggest.size) biggest = { e, size, at };
  }
  if (biggest && biggest.at > 0) {
    const over = biggest.size >= biggest.at;
    const n = latest.size;
    const which = n === 1 ? "the open conversation" : `the biggest of ${n} open conversations`;
    const floor = biggest.size >= BIG_CONVERSATION ? rereadFloor(biggest.e) : null;
    const each = floor ? `; each message re-reads it, at least ${money(floor)}` : "";
    checks.push({
      name: "Context",
      ok: !over,
      detail: over
        ? `${which} is at ${short(biggest.size)}, past where it compacts (${short(biggest.at)})${each}`
        : `${which} is at ${short(biggest.size)}, compacts at ${short(biggest.at)}${each}`,
    });
  }

  if (opts.warm && opts.warm.length > 0) {
    const first = opts.warm.find((w) => w.expiresAt !== null);
    if (first?.expiresAt) {
      const n = opts.warm.length;
      checks.push({
        name: "Warm",
        ok: true,
        detail:
          n === 1
            ? `the cache stays warm for ${minutes(first.expiresAt - now)} more`
            : `${n} caches warm, the first expires in ${minutes(first.expiresAt - now)}`,
      });
    }
  }

  if (opts.cold) {
    checks.push({
      name: "Returns",
      ok: opts.cold.count === 0,
      detail:
        opts.cold.count === 0
          ? "nothing came back to an expired cache this run"
          : `${opts.cold.count} came back to an expired cache this run, ${money(opts.cold.usd)} written again`,
    });
  }

  // The rules: the same ones that print cards, with the biggest one named even
  // when it is under the floor, so "fine" says how far from not fine it is.
  const data = {
    events: [...events],
    window: {
      from: times.length ? new Date(Math.min(...times)).toISOString() : "",
      to: times.length ? new Date(Math.max(...times)).toISOString() : "",
      days: spanMs / 86_400_000,
    },
    sources: ["live"],
    warnings: [],
  };
  const live = analyze(data).findings.filter((f) => !f.advisory && f.tier !== "test");
  live.sort((a, b) => b.savings.windowUsd - a.savings.windowUsd);
  const over = live.filter((f) => f.savings.windowUsd >= opts.minUsd);
  const top = live[0];
  const shown = opts.shown && opts.shown.count > 0 ? opts.shown : null;
  checks.push({
    name: "Rules",
    ok: !shown && over.length === 0,
    detail: shown
      ? `${shown.count} found this run, ${money(shown.usd)} already paid`
      : over.length > 0
        ? `${over.length} worth changing, ${money(over.reduce((t, f) => t + f.savings.windowUsd, 0))} so far`
        : top && top.savings.windowUsd > 0
          ? `nothing over ${money(opts.minUsd)}; the biggest is ${ruleLabel(top.rule).toLowerCase()} at ${money(top.savings.windowUsd)}`
          : "none of them found anything",
  });

  checks.push(...modelChoice(events, opts.minUsd));
  return { calls: events.length, spanMs, checks, findings: over };
}

const AGENTS = new Set(["claude-code", "codex", "opencode"]);
/** One step down, never to low: what guard's effort suggestion would say. */
const EFFORT_DOWN: Record<string, string> = { max: "xhigh", xhigh: "high" };
/** Under this share of the cost, a cheaper model or effort is not worth a line. */
const CHOICE_SHARE = 0.1;

const most = <T>(items: T[]): T | undefined => {
  const counts = new Map<T, number>();
  for (const x of items) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * The model and effort most of the agent spend went to, said only when a
 * cheaper choice would have moved the bill: the same calls priced one model
 * down, and what thinking cost at max or xhigh.
 */
function modelChoice(events: readonly UsageEvent[], minUsd: number): LiveCheck[] {
  const spend = new Map<string, number>();
  for (const e of events) {
    if (AGENTS.has(e.source)) spend.set(e.model, (spend.get(e.model) ?? 0) + e.cost.total);
  }
  const top = [...spend].sort((a, b) => b[1] - a[1])[0];
  const from = top ? priceFor(top[0]) : null;
  if (!top || !from) return [];
  const calls = events.filter((e) => AGENTS.has(e.source) && e.model === top[0]);
  const total = top[1];
  const effort = most(calls.map((e) => e.effort).filter((x): x is string => !!x));
  const out: LiveCheck[] = [];

  // Only from the top tier: a balanced model down to a fast one is not a like-for-like.
  const to = from.tier === "frontier" ? downgradeTargetFor(top[0]) : null;
  if (to && total > 0) {
    let before = 0;
    let after = 0;
    let reads = 0;
    for (const e of calls) {
      const p = repriced(e, from, to);
      before += p.before;
      after += p.after;
      reads += e.cost.cacheRead;
    }
    const saved = before - after;
    if (before > 0 && saved >= minUsd && saved / before >= CHOICE_SHARE) {
      const last = calls.at(-1)!.ts;
      const a = ratesFor(from, { at: last });
      const b = ratesFor(to, { at: last });
      // On a long conversation most of the bill is re-reading it, which a
      // cheaper model may not price any lower.
      const readShare = reads / total;
      const sameReads = Math.abs(a.cachedInputPerM - b.cachedInputPerM) < 1e-9;
      const half = Math.abs(b.inputPerM / a.inputPerM - 0.5) < 0.05;
      const why =
        sameReads && readShare >= 0.2
          ? `${half ? ", not half" : ""} (re-reads, ${Math.round(readShare * 100)}% of it, cost the same)`
          : "";
      out.push({
        name: "Model",
        ok: true,
        note: true,
        detail: `${from.label}${effort ? ` at ${effort}` : ""}. The same calls on ${to.label}: ${Math.round((saved / before) * 100)}% less${why}`,
      });
    }
  }

  const down = effort ? EFFORT_DOWN[effort] : undefined;
  if (down && total > 0) {
    let thinking = 0;
    for (const e of calls) {
      if (e.thinkingTokens > 0 && e.outputTokens > 0) {
        thinking += e.cost.output * Math.min(1, e.thinkingTokens / e.outputTokens);
      }
    }
    const share = thinking / total;
    if (thinking >= minUsd && share >= CHOICE_SHARE) {
      const claude = calls.some((e) => e.source === "claude-code");
      const hint = claude ? `; /effort ${down} on routine steps keeps the cache` : "";
      out.push({
        name: "Effort",
        ok: true,
        note: true,
        detail: `${effort}: thinking was ${Math.round(share * 100)}% of the cost (${money(thinking)})${hint}`,
      });
    }
  }
  return out;
}

/** What to do about a finding: now, in the session, and next time. */
export interface LiveStep {
  now: string;
  later?: string;
  /** The setting `a` makes in live, when the later part is one. */
  apply?: "guard" | "context-compaction";
  /** Whose calls these mostly were, so the setting goes to the right agent. */
  agent?: "claude-code" | "codex" | "opencode";
}

/** What is set already, so a step never offers what is on. */
export interface StepContext {
  /** Guard's hooks are in Claude Code's settings. */
  guard?: boolean;
  /** Whether each agent has a compaction point set. Unknown offers nothing. */
  compacts?: Partial<Record<"claude-code" | "codex", boolean>>;
}

/** Most of the traffic is a coding agent's, so the step is said in its terms. */
function agentOf(traffic?: Traffic): "claude-code" | "codex" | "opencode" | null {
  const share = traffic?.shareBySource ?? {};
  const agents = (["claude-code", "codex", "opencode"] as const).filter((s) => (share[s] ?? 0) > 0);
  if (agents.length === 0) return null;
  return agents.reduce((a, b) => ((share[a] ?? 0) >= (share[b] ?? 0) ? a : b));
}

/**
 * One step for a finding, in the words of the agent that made the calls.
 * SDK traffic gets the rule's own fix, which is written for code.
 */
export function liveStep(
  f: OptimizationFinding,
  traffic?: Traffic,
  ctx: StepContext = {},
): LiveStep {
  const agent = agentOf(traffic);
  const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
  if (!agent) return { now: firstSentence(f.fix) };
  const claude = agent === "claude-code";
  // Guard covers big reads, retries and cold sends, in Claude Code only.
  const guard = (text: string): Partial<LiveStep> =>
    claude && !ctx.guard ? { later: `optimaizr guard on: ${text}`, apply: "guard", agent } : {};
  const to = f.candidate?.to ? (priceFor(f.candidate.to)?.label ?? f.candidate.to) : null;

  switch (f.rule) {
    case "model-fit":
      return {
        now: claude
          ? `Before the next small task, type /model ${(to ?? "sonnet").toLowerCase().split(" ")[0]}. A new conversation is the cheapest moment to switch.`
          : `Switch to ${to ?? "a smaller model"} for the next small task, and back for hard ones.`,
        later: `optimaizr apply ${f.rule}`,
      };
    case "reasoning-effort":
      return {
        now: claude
          ? "While the work is mechanical, type /effort medium. Go back up when it has to plan."
          : "Lower the reasoning effort while the work is mechanical.",
      };
    case "oversized-tool-output":
      return {
        now: "Ask for less at once: grep instead of cat, head or tail on logs, and a line range on big files.",
        ...guard("it holds a whole read of a big file once, so Claude reads the part it needs"),
      };
    case "repeat-tool-calls":
      return {
        now: "The same file or command keeps coming back. Tell it to use what it already read.",
      };
    case "oversized-input": {
      const step: LiveStep = {
        now: claude
          ? "Start small jobs with /clear instead of at the end of a long conversation."
          : "Start small jobs in a fresh conversation instead of a long one.",
      };
      if (agent === "opencode" || ctx.compacts?.[agent] !== false) return step;
      return {
        ...step,
        later: `optimaizr apply context-compaction: from the next session it compacts at ${short(COMPACT_AT)}`,
        apply: "context-compaction",
        agent,
      };
    }
    case "oversized-output":
      return {
        now: "Ask for shorter answers on routine steps: the diff only, no recap.",
      };
    case "error-loops":
      return {
        now: "It is retrying the same failing call. Stop it, read the error, and point it at the cause.",
        ...guard("when a command fails twice with nothing changed, it holds the third run once"),
      };
    case "cold-resume": {
      const now =
        "Before a break of over an hour, ask for a three-line handoff note (done, next, file).";
      if (!claude) return { now };
      if (ctx.guard) {
        return {
          now,
          later: "Guard is on: it holds the next one, and /clear starts from its note.",
        };
      }
      return {
        now,
        later:
          "optimaizr guard on: it holds the next message to an expired cache once, and /clear starts from a note",
        apply: "guard",
        agent,
      };
    }
    default:
      return { now: firstSentence(f.fix) };
  }
}
