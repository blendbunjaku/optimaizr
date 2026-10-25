import type { CompactionRecord, UsageEvent } from "../domain/types.js";
import { allModels, priceFor, ratesFor } from "../pricing.js";
import type { CacheState } from "./cache-watch.js";
import { coldResumes } from "./cold.js";
import { sessionBlocks } from "./plan.js";

/**
 * Guard: Claude Code hooks that hold a costly step once, before it is paid,
 * and let it through when it comes again. This is the pure half, what a
 * transcript says and what each hold says; the hooks themselves are in local.
 */

/** A message is held when sending it would write at least this into the cache again. */
export const HOLD_MIN_USD = 0.5;
/** A whole-file read over this is held once: about 16K tokens. */
export const BIG_READ_BYTES = 64 * 1024;
/** Claude Code stops a whole read at a token cap and sends the first part only. */
export const READ_TOKEN_CAP = 25_000;

/** About what a whole read of this many bytes sends, at most the cap. */
export function readTokens(bytes: number): number {
  return Math.min(Math.round(bytes / 4), READ_TOKEN_CAP);
}
/** The same command failing this many times in a row, with nothing changed, is held once. */
export const RETRY_LIMIT = 2;
/** The compact nudge comes at this share of where the conversation compacts. */
export const COMPACT_NUDGE_SHARE = 0.75;
/** Where Claude Code compacts is the median of its last this many automatic compactions. */
const POINT_FROM = 10;
const POINT_MIN = 3;

/**
 * Where Claude Code really compacts, from its automatic compactions since
 * `since` (when the setting last changed). It runs under the setting: with
 * 200K set, mine were at 168K on the median.
 */
export function observedCompactPoint(
  compactions: readonly CompactionRecord[],
  since?: string,
): { tokens: number; from: number } | null {
  const auto = compactions
    .filter((c) => c.source === "claude-code" && c.trigger === "auto" && (!since || c.ts >= since))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-POINT_FROM);
  if (auto.length < POINT_MIN) return null;
  const sorted = auto.map((c) => c.preTokens).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const tokens =
    sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  return { tokens, from: auto.length };
}
/** A new conversation in the same folder starts from the handoff note for this long. */
export const HANDOFF_TTL_MS = 30 * 60_000;

// Tools whose success can change what a retried command sees.
const MUTATING = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** What the end of a transcript says about the work, read without a model. */
export interface TranscriptFacts {
  lastPrompt: string | null;
  lastReply: string | null;
  /** Files changed, oldest first, each once. */
  edited: string[];
  todos: Array<{ content: string; status: string }> | null;
  /** Commands that failed, with how often, since the last change that worked. */
  failing: Map<string, number>;
  /** The id of the last change that worked: a new streak of failures starts after it. */
  lastChange: string | null;
  /** How the session was started: cli, claude-vscode, sdk-cli and so on. */
  entrypoint: string | null;
  /** What was tried and did not work, oldest first. */
  dropped: Dropped[];
  /** The conversation stopped because a plan limit refused its last request. */
  limited: boolean;
}

export type Dropped =
  | { kind: "failed"; command: string; times: number }
  | { kind: "declined" | "undone"; file: string };

// A search that finds nothing exits 1 too; that is not something tried and dropped.
const LOOKS =
  /^(cd\s[^&;]*&&\s*)?(grep|rg|find|ls|cat|head|tail|sed\s+-n|awk|wc|which|test|\[|git\s+(status|log|diff|show))\b/;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  error?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  entrypoint?: string;
  lastPrompt?: string;
  message?: { content?: string | Block[] };
}

// Asking for the work in hand to go on, which a fresh start would not serve.
const CARRY_ON =
  /^\s*(please\s+)?(continue|go on|keep going|carry on|resume|proceed|go ahead)(\s+please)?[\s.!]*$/i;

/** Whether a prompt only asks Claude to carry on. */
export function carriesOn(prompt: string | undefined): boolean {
  return typeof prompt === "string" && CARRY_ON.test(prompt);
}

// Text Claude Code adds to a user message that the person did not type.
const NOT_TYPED = /^(<(command-|local-command-|system-reminder|ide_|bash-)|\[Request interrupted)/;

function typed(text: string): string | null {
  const t = text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, "[pasted text]")
    .trim();
  return t && !NOT_TYPED.test(t) ? t : null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: Block) => (typeof b?.text === "string" ? b.text : "")).join("\n");
}

export function transcriptFacts(lines: Iterable<string>): TranscriptFacts {
  const f: TranscriptFacts = {
    lastPrompt: null,
    lastReply: null,
    edited: [],
    todos: null,
    failing: new Map(),
    lastChange: null,
    entrypoint: null,
    dropped: [],
    limited: false,
  };
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  // Keyed so a later outcome replaces an earlier one; insertion order is the order tried.
  const tried = new Map<string, Dropped>();
  const drop = (key: string, d: Dropped) => {
    tried.delete(key);
    tried.set(key, d);
  };
  const changes = new Map<string, Array<{ from: unknown; to: unknown }>>();

  for (const line of lines) {
    if (!line.trim()) continue;
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    if (r.isSidechain) continue;
    if (typeof r.entrypoint === "string") f.entrypoint = r.entrypoint;
    if (r.type === "last-prompt" && typeof r.lastPrompt === "string") {
      f.lastPrompt = typed(r.lastPrompt) ?? f.lastPrompt;
      continue;
    }
    const content = r.message?.content;

    // A refused request is Claude Code's error text, not a reply.
    if (r.type === "assistant" && r.isApiErrorMessage) {
      if (r.error === "rate_limit") f.limited = true;
      continue;
    }
    if (r.type === "assistant" && Array.isArray(content)) {
      f.limited = false;
      for (const b of content) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          f.lastReply = b.text.trim();
        } else if (b.type === "tool_use" && typeof b.id === "string") {
          const input = b.input ?? {};
          calls.set(b.id, { name: String(b.name), input });
          if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
            f.todos = (input.todos as Array<Record<string, unknown>>)
              .filter((t) => typeof t?.content === "string")
              .map((t) => ({ content: String(t.content), status: String(t.status ?? "pending") }));
          }
        }
      }
      continue;
    }

    if (r.type !== "user" || r.isMeta || r.isCompactSummary) continue;
    if (typeof content === "string") {
      f.lastPrompt = typed(content) ?? f.lastPrompt;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "text" && typeof b.text === "string") {
        f.lastPrompt = typed(b.text) ?? f.lastPrompt;
        continue;
      }
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      const file = call.input.file_path ?? call.input.notebook_path;
      const cmd = typeof call.input.command === "string" ? call.input.command.trim() : null;
      if (b.is_error === true) {
        const text = resultText(b.content);
        if (/optimAIzr held/.test(text)) continue;
        // A refusal is not the command failing, but an edit turned down was dropped.
        if (/doesn't want to proceed|was rejected/.test(text)) {
          if (EDITS.has(call.name) && typeof file === "string") {
            drop(`file:${file}`, { kind: "declined", file });
          }
          continue;
        }
        if (call.name === "Bash" && cmd) {
          f.failing.set(cmd, (f.failing.get(cmd) ?? 0) + 1);
          const prev = tried.get(`run:${cmd}`);
          const times = prev?.kind === "failed" ? prev.times + 1 : 1;
          if (!LOOKS.test(cmd)) drop(`run:${cmd}`, { kind: "failed", command: cmd, times });
        }
        continue;
      }
      if (call.name === "Bash" && cmd) tried.delete(`run:${cmd}`);
      if (!MUTATING.has(call.name)) continue;
      f.failing.clear();
      f.lastChange = b.tool_use_id;
      if (EDITS.has(call.name) && typeof file === "string") {
        f.edited = [...f.edited.filter((x) => x !== file), file];
        // An edit that puts back what an earlier one took out undoes it.
        const { old_string: from, new_string: to } = call.input;
        const before = changes.get(file) ?? [];
        if (typeof from === "string" && before.some((c) => c.from === to && c.to === from)) {
          drop(`file:${file}`, { kind: "undone", file });
        }
        changes.set(file, [...before, { from, to }]);
      }
    }
  }
  f.dropped = [...tried.values()];
  return f;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > max * 0.6 ? space : max)}...`;
}

function relative(file: string, cwd?: string): string {
  if (!cwd) return file;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

/**
 * Where the work stands, from the transcript alone: the last ask, the files
 * changed, what was dropped, open todos and the last reply. Null when there is
 * nothing to say.
 */
export function handoffNote(f: TranscriptFacts, cwd?: string): string | null {
  const out: string[] = [];
  if (f.lastPrompt) out.push(`Asked last: ${clip(f.lastPrompt, 300)}`);
  if (f.edited.length > 0) {
    const files = f.edited.slice(-8).map((x) => relative(x, cwd));
    const more = f.edited.length > 8 ? ` and ${f.edited.length - 8} more` : "";
    out.push(`Changed: ${files.join(", ")}${more}`);
  }
  if (f.dropped.length > 0) {
    const items = f.dropped.slice(-4).map((d) => {
      if (d.kind === "failed") {
        return `${clip(d.command, 60)} (failed${d.times > 1 ? ` ${d.times} times` : ""})`;
      }
      const at = relative(d.file, cwd);
      return d.kind === "declined" ? `an edit to ${at}, turned down` : `a change to ${at}, undone`;
    });
    out.push(`Dropped: ${items.join("; ")}`);
  }
  const open = (f.todos ?? []).filter((t) => t.status !== "completed");
  if (open.length > 0) {
    out.push(
      `Still open: ${open
        .slice(0, 5)
        .map((t) => clip(t.content, 80))
        .join("; ")}`,
    );
  }
  if (f.lastReply) out.push(`Last reply: ${clip(f.lastReply, 500)}`);
  return out.length > 0 ? out.join("\n") : null;
}

/**
 * What a new conversation reads before its first message. It says the note is
 * this conversation's own past and how old it is, so Claude neither doubts it nor trusts it blindly.
 */
export function handoffContext(note: string, at: number, lastAt?: number): string {
  const clock = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const away = lastAt === undefined ? null : idle(at - lastAt);
  return (
    `This conversation started with a /clear of the one before it. optimAIzr held a message there at ${clock} because ` +
    `${away ? `it had been idle ${away} and ` : ""}its cache had expired, and kept this note from that conversation's transcript: ` +
    `it is the work being picked up here, as it stood${away ? ` ${away} ago` : " then"}. ` +
    `Check it against the code before relying on it, since parts may be done by now.\n\n${note}`
  );
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function size(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

function idle(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m % 60 === 0 ? `${h}h` : `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * The same rewrite on the balanced model, when the conversation is on a
 * frontier Anthropic one. Null otherwise, or when it is not much cheaper.
 */
export function cheaperRewrite(s: CacheState): { label: string; usd: number } | null {
  const price = priceFor(s.event.model);
  if (!price || price.provider !== "anthropic" || price.tier !== "frontier") return null;
  const balanced = allModels().find((m) => m.provider === "anthropic" && m.tier === "balanced");
  if (!balanced) return null;
  const r = ratesFor(balanced, { at: new Date().toISOString(), promptTokens: s.context });
  const usd = (s.context * (hourCache(s) ? r.cacheWrite1hPerM : r.cacheWrite5mPerM)) / 1_000_000;
  return usd < s.rewriteUsd * 0.8 ? { label: balanced.label, usd } : null;
}

function hourCache(s: CacheState): boolean {
  return s.expiresAt !== null && s.expiresAt - Date.parse(s.event.ts) > 10 * 60_000;
}

/**
 * What writing `tokens` into this conversation's cache costs. For a whole
 * read that is only its first cost: every later call re-reads it too.
 */
export function writeUsd(tokens: number, s: CacheState): number | null {
  const price = priceFor(s.event.model);
  if (!price) return null;
  const r = ratesFor(price, { at: s.event.ts, promptTokens: s.context + tokens });
  return (tokens * (hourCache(s) ? r.cacheWrite1hPerM : r.cacheWrite5mPerM)) / 1_000_000;
}

/** Shown to the person when a message to an expired cache is held. */
export function coldHoldReason(
  s: CacheState,
  now: number,
  opts: {
    handoff: boolean;
    cheaper?: { label: string; usd: number } | null;
    /** What 1% of the 5-hour window costs, on a Claude plan. */
    usdPerPercent?: number | null;
  },
): string {
  const label = priceFor(s.event.model)?.label ?? s.event.model;
  const rate = opts.usdPerPercent && opts.usdPerPercent > 0 ? opts.usdPerPercent : null;
  // On a plan the window is what runs out, so it leads and the dollars follow.
  const share = (usd: number) => {
    const pct = Math.round(usd / rate!);
    return pct < 1 ? "under 1%" : `about ${pct}%`;
  };
  const cost = rate
    ? `${share(s.rewriteUsd)} of your 5-hour limit (${money(s.rewriteUsd)} at API prices, ${label})`
    : `about ${money(s.rewriteUsd)} on ${label}`;
  const lines = [
    `optimAIzr held this message once. The conversation has been idle ${idle(now - Date.parse(s.event.ts))} and its cache expired, so sending it writes all ${size(s.context)} tokens again: ${cost}.`,
    // Claude Code empties the input box on a hold and prints the text below as
    // "Original prompt", so the way back is to copy it from there.
    opts.handoff
      ? "It was not sent: copy it from Original prompt below. Send it again to go ahead, or type /clear and send it there: the new conversation starts from a short note of where this one stood."
      : "It was not sent: copy it from Original prompt below. Send it again to go ahead, or type /clear and start fresh.",
  ];
  if (opts.cheaper) {
    lines.push(
      `On ${opts.cheaper.label} the same rewrite is ${rate ? `${share(opts.cheaper.usd)} (${money(opts.cheaper.usd)})` : `about ${money(opts.cheaper.usd)}`}: /model ${opts.cheaper.label.split(" ")[0]!.toLowerCase()}, then send it again.`,
    );
  }
  return lines.join("\n");
}

/** Told to Claude when it reads a whole big file. */
export function bigReadReason(file: string, sent: number, fileBytes = sent): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  const kb = Math.round(fileBytes / 1024);
  const whole = fileBytes >= 1024 * 1024 ? `${(fileBytes / 1024 / 1024).toFixed(1)}MB` : `${kb}KB`;
  return (
    `optimAIzr held this read once: ${name} is ${whole}, and a whole read sends about ${size(readTokens(sent))} tokens of it, ` +
    "which stay in this conversation for every call after. Read the part you need: " +
    "Grep for it first, or pass offset and limit. If the whole file is needed, read it again and it will go through."
  );
}

/** Told to Claude when it runs a command again that failed twice with nothing changed. */
export const RETRY_REASON =
  "optimAIzr held this retry: the same command failed twice in a row and nothing has changed since. " +
  "Change something first (the command, the code or the setup), or tell the user what is blocking you. " +
  "If it must run unchanged, run it again and it will go through.";

/**
 * Shown to the person at the end of a turn, once, when the conversation nears
 * compaction. `seen` when the point is where it really compacted, not the setting.
 */
export function compactNudge(context: number, compactAt: number, seen = false): string {
  return (
    `optimAIzr: this conversation is at ${size(context)} and compacts at ${seen ? "about " : ""}${size(compactAt)}. ` +
    "If this task is done, /compact now (or /clear), so it does not compact in the middle of the next one."
  );
}

/** One line of guard's log, read by `optimaizr guard` and `live`. */
export interface GuardReceipt {
  at: string;
  session: string;
  kind:
    | "cold-hold"
    | "cold-sent"
    | "handoff-used"
    | "big-read"
    | "big-read-sent"
    | "retry"
    | "retry-sent"
    | "compact";
  /** What was at stake: the rewrite for a cold cache, the first write for a big read. */
  usd?: number;
  tokens?: number;
  /** The file, the command, or the model. */
  detail?: string;
}

/** What guard's holds kept from being paid. */
export interface GuardSaved {
  /** Holds whose cheaper path was taken: the held step never came again. */
  catches: number;
  /** Rewrites that were never sent, and whole reads at their first write. */
  usd: number;
}

// A hold, and the receipt that says it went through after all.
const SENT: Record<string, string> = {
  "cold-hold": "cold-sent",
  "big-read": "big-read-sent",
  retry: "retry-sent",
};

/**
 * Only holds that stuck count: a message sent again, or a whole read or retry
 * that went through the second time, cancels its hold.
 */
export function guardSaved(receipts: readonly GuardReceipt[]): GuardSaved {
  const sorted = [...receipts].sort((a, b) => a.at.localeCompare(b.at));
  // A cold send has no detail: it goes with the last hold in its conversation.
  const keyOf = (r: GuardReceipt, hold: string) =>
    `${hold}|${r.session}|${hold === "cold-hold" ? "" : (r.detail ?? "")}`;
  const open = new Map<string, GuardReceipt>();
  const held: GuardReceipt[] = [];
  const cancelled = new Set<GuardReceipt>();
  for (const r of sorted) {
    if (SENT[r.kind]) {
      held.push(r);
      open.set(keyOf(r, r.kind), r);
      continue;
    }
    const hold = Object.keys(SENT).find((k) => SENT[k] === r.kind);
    const h = hold ? open.get(keyOf(r, hold)) : undefined;
    if (hold && h) {
      cancelled.add(h);
      open.delete(keyOf(r, hold));
    }
  }
  const kept = held.filter((r) => !cancelled.has(r));
  return { catches: kept.length, usd: kept.reduce((t, r) => t + (r.usd ?? 0), 0) };
}

/** The pace warning starts once this share of the 5-hour limit is used. */
export const PACE_FROM = 0.5;
const PACE_OVER_MS = 3_600_000;
// Running out a few minutes before the reset is not worth a warning.
const PACE_MARGIN_MS = 15 * 60_000;

export interface Pace {
  /** When the 5-hour window runs out at the last hour's pace. */
  runsOutAt: string;
  resetsAt: string;
  /** The share of the limit used so far. */
  used: number;
  /** The balanced model, when the conversation is on a frontier one. */
  lighter?: string;
}

/**
 * Whether the 5-hour window runs out before it resets, at the last hour's
 * pace. Tried on my 7 stops at the limit, it came before each, 19 minutes to
 * 2h 44m ahead, and in 10 of the 44 windows that never got there.
 */
export function paceCheck(
  events: readonly UsageEvent[],
  limitUsd: number,
  now = Date.now(),
): Pace | null {
  const own = events
    .filter((e) => e.source === "claude-code" && Date.parse(e.ts) <= now)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const window = sessionBlocks(own).at(-1);
  if (!window || limitUsd <= 0 || now >= Date.parse(window.end)) return null;
  if (window.usd < PACE_FROM * limitUsd || window.usd >= limitUsd) return null;
  const lastHour = own
    .filter((e) => Date.parse(e.ts) >= now - PACE_OVER_MS)
    .reduce((t, e) => t + e.cost.total, 0);
  if (lastHour <= 0) return null;
  const out = now + ((limitUsd - window.usd) / lastHour) * PACE_OVER_MS;
  if (out > Date.parse(window.end) - PACE_MARGIN_MS) return null;
  const last = own.filter((e) => !e.isSubagent).at(-1);
  const price = last ? priceFor(last.model) : undefined;
  const lighter =
    price?.provider === "anthropic" && price.tier === "frontier"
      ? allModels().find((m) => m.provider === "anthropic" && m.tier === "balanced")
      : undefined;
  return {
    runsOutAt: new Date(out).toISOString(),
    resetsAt: window.end,
    used: window.usd / limitUsd,
    ...(lighter ? { lighter: lighter.label } : {}),
  };
}

/** Shown once a window, at the end of a turn. */
export function paceText(p: Pace): string {
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const early = idle(Date.parse(p.resetsAt) - Date.parse(p.runsOutAt));
  const lighter = p.lighter ? ` ${p.lighter} makes it last longer: /model sonnet.` : "";
  return (
    `optimAIzr: at the last hour's pace, your 5-hour limit runs out around ${clock(p.runsOutAt)}, ` +
    `${early} before it resets at ${clock(p.resetsAt)}. About ${Math.round(p.used * 100)}% is used.${lighter}`
  );
}

/** The messages guard would have held, from history it never saw. */
export interface WouldHold {
  count: number;
  /** What writing those conversations into the cache again cost. */
  usd: number;
  /** What a warm cache would have read the same tokens for. */
  warmUsd: number;
}

/**
 * Returns to a Claude Code conversation after a break, since `since`, whose
 * cache had expired and whose rewrite was worth a hold. Null when there were none.
 */
export function wouldHold(events: readonly UsageEvent[], since = 0): WouldHold | null {
  const held = coldResumes(events.filter((e) => e.source === "claude-code")).filter(
    (c) => c.waiting === "away" && c.rewriteUsd >= HOLD_MIN_USD && Date.parse(c.event.ts) >= since,
  );
  if (held.length === 0) return null;
  return {
    count: held.length,
    usd: held.reduce((t, c) => t + c.rewriteUsd, 0),
    warmUsd: held.reduce((t, c) => t + c.warmUsd, 0),
  };
}

/**
 * "9 catches, $14.20 not spent", or null before guard has kept anything. With
 * the week before's catches: "9 catches (was 4), $14.20 not spent".
 */
export function savedText(s: GuardSaved, before?: number): string | null {
  if (s.catches === 0) return null;
  const was = before ? ` (was ${before})` : "";
  const n = `${s.catches} ${s.catches === 1 ? "catch" : "catches"}${was}`;
  return s.usd >= 0.01 ? `${n}, ${money(s.usd)} not spent` : n;
}
