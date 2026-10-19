import fs from "node:fs";
import path from "node:path";

import {
  BIG_READ_BYTES,
  bigReadReason,
  cheaperRewrite,
  COLD_MIN_CONTEXT,
  coldHoldReason,
  COMPACT_NUDGE_SHARE,
  compactNudge,
  type GuardReceipt,
  guardSaved,
  HANDOFF_TTL_MS,
  handoffContext,
  handoffNote,
  HOLD_MIN_USD,
  priceFor,
  readTokens,
  RETRY_LIMIT,
  RETRY_REASON,
  savedText,
  transcriptFacts,
  writeUsd,
} from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";
import { claudeSettingsPath } from "./rewriters.js";
import { cacheStateOf, readSettings, transcriptTail, writeSettings } from "./statusline.js";

/**
 * `optimaizr guard on|off` and the hooks it sets in Claude Code. Each hook
 * holds a costly step once and lets it through when it comes again: a message
 * to an expired cache, a whole big file read, a retry of a failing command.
 * Hooks someone already has are never touched.
 */

/** The hooks guard sets, one command for all of them. */
export const GUARD_HOOKS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "Read|Bash" },
  { event: "SessionStart", matcher: "clear" },
  { event: "SessionEnd", matcher: "clear" },
  { event: "Stop" },
];
const TIMEOUT_SECONDS = 10;
/** Marks older than this are dropped: no conversation is held for its whole life. */
const MARK_TTL_MS = 7 * 86_400_000;
/** Claude Code's Read stops after this many lines, so more is never sent. */
const READ_LINES = 2000;
/** How much of the transcript the handoff note reads: a long turn's worth. */
const NOTE_BYTES = 2 * 1024 * 1024;

export interface GuardPaths {
  claudeSettings?: string;
  /** Where guard keeps its marks, receipts and handoff notes. */
  dir?: string;
}

export interface GuardResult {
  ok: boolean;
  changed: boolean;
  detail: string;
}

function paths(opts: GuardPaths) {
  const dir = opts.dir ?? path.join(optimaizrDir(), "guard");
  return {
    settings: opts.claudeSettings ?? claudeSettingsPath(),
    dir,
    record: path.join(dir, "installed.json"),
    marks: path.join(dir, "marks.json"),
    receipts: path.join(dir, "receipts.jsonl"),
    handoffs: path.join(dir, "handoffs"),
    week: path.join(dir, "week.json"),
  };
}

type Paths = ReturnType<typeof paths>;
type Handler = { type?: string; command?: string; timeout?: number };
type Group = { matcher?: string; hooks?: Handler[] };

/** Ours: `optimaizr guard hook`, or the full-path form, whose path names the package. */
const isOurs = (h: Handler | undefined) =>
  typeof h?.command === "string" &&
  /optimaizr/i.test(h.command) &&
  /\bguard hook"?\s*$/.test(h.command);

function hooksOf(
  settings: Record<string, unknown>,
  file: string,
): Record<string, unknown> | string {
  const hooks = settings.hooks ?? {};
  return typeof hooks === "object" && hooks !== null && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : `"hooks" in ${file} is not an object; leaving it alone`;
}

export function guardApplied(opts: GuardPaths = {}): boolean {
  const p = paths(opts);
  const settings = readSettings(p.settings);
  if (typeof settings === "string") return false;
  const hooks = hooksOf(settings, p.settings);
  if (typeof hooks === "string") return false;
  return GUARD_HOOKS.every(({ event }) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((g: Group) => g?.hooks?.some(isOurs));
  });
}

export function applyGuard(command: string | null, opts: GuardPaths = {}): GuardResult {
  const p = paths(opts);
  if (command === null) {
    return {
      ok: false,
      changed: false,
      detail:
        "optimAIzr is running through npx. Install it so Claude Code can run it quickly: npm i -g optimaizr, then optimaizr guard on",
    };
  }
  const settings = readSettings(p.settings);
  if (typeof settings === "string") return { ok: false, changed: false, detail: settings };
  if (settings.disableAllHooks === true) {
    return {
      ok: false,
      changed: false,
      detail: `hooks are turned off in ${p.settings} (disableAllHooks), so guard would never run.`,
    };
  }
  const hooks = hooksOf(settings, p.settings);
  if (typeof hooks === "string") return { ok: false, changed: false, detail: hooks };

  const next: Record<string, unknown> = { ...hooks };
  let changed = false;
  for (const { event, matcher } of GUARD_HOOKS) {
    const groups = next[event] ?? [];
    if (!Array.isArray(groups)) {
      return {
        ok: false,
        changed: false,
        detail: `"hooks.${event}" in ${p.settings} is not a list; leaving it alone`,
      };
    }
    let found = false;
    const updated = (groups as Group[]).map((g) => {
      if (!g || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) return g;
      found = true;
      // A newer optimAIzr may run from another path or match other tools.
      const hs = g.hooks.map((h) => (isOurs(h) && h.command !== command ? { ...h, command } : h));
      const own = g.hooks.every(isOurs);
      const out: Group = { ...g, hooks: hs };
      if (own && matcher && g.matcher !== matcher) out.matcher = matcher;
      if (JSON.stringify(out) !== JSON.stringify(g)) changed = true;
      return out;
    });
    if (!found) {
      updated.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command, timeout: TIMEOUT_SECONDS }],
      });
      changed = true;
    }
    next[event] = updated;
  }
  if (!changed)
    return { ok: true, changed: false, detail: `guard's hooks are set in ${p.settings}.` };

  writeSettings(p.settings, { ...settings, hooks: next });
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(
    p.record,
    JSON.stringify(
      { version: 1, file: p.settings, command, at: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  return {
    ok: true,
    changed: true,
    detail: `hooks in ${p.settings}: ${GUARD_HOOKS.map((h) => h.event).join(", ")}.`,
  };
}

/** Take guard's hooks out again, and only those. Null when none were set. */
export function undoGuard(opts: GuardPaths = {}): GuardResult | null {
  const p = paths(opts);
  fs.rmSync(p.record, { force: true });
  const settings = readSettings(p.settings);
  if (typeof settings === "string") return { ok: false, changed: false, detail: settings };
  const hooks = hooksOf(settings, p.settings);
  if (typeof hooks === "string") return null;

  let removed = false;
  const next: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept: Group[] = [];
    for (const g of groups as Group[]) {
      if (!g || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) {
        kept.push(g);
        continue;
      }
      removed = true;
      const hs = g.hooks.filter((h) => !isOurs(h));
      if (hs.length > 0) kept.push({ ...g, hooks: hs });
    }
    if (kept.length > 0) next[event] = kept;
  }
  if (!removed) return null;
  const out = { ...settings };
  if (Object.keys(next).length > 0) out.hooks = next;
  else delete out.hooks;
  writeSettings(p.settings, out);
  return { ok: true, changed: true, detail: `guard's hooks removed from ${p.settings}.` };
}

/* ------------------------------------------------------------------ *
 * What guard remembers: what it held, what it did, and handoff notes
 * ------------------------------------------------------------------ */

function readMarks(p: Paths): Record<string, number> {
  try {
    const v = JSON.parse(fs.readFileSync(p.marks, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Notes that this was held, so the same step comes through the next time. */
function mark(p: Paths, key: string, now: number): void {
  const marks = readMarks(p);
  const kept: Record<string, number> = {};
  for (const [k, at] of Object.entries(marks)) if (now - at < MARK_TTL_MS) kept[k] = at;
  kept[key] = now;
  fs.mkdirSync(p.dir, { recursive: true });
  // Another session's hook can run at the same moment: write whole, then swap.
  const tmp = `${p.marks}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(kept));
  fs.renameSync(tmp, p.marks);
}

function receipt(p: Paths, r: GuardReceipt): void {
  fs.mkdirSync(p.dir, { recursive: true });
  fs.appendFileSync(p.receipts, JSON.stringify(r) + "\n");
}

function parseReceipts(text: string): GuardReceipt[] {
  const out: GuardReceipt[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as GuardReceipt;
      if (typeof r?.kind === "string" && typeof r.at === "string") out.push(r);
    } catch {
      // A line cut off mid-write.
    }
  }
  return out;
}

/** What guard did since `since` (ms), oldest first. */
export function readReceipts(since = 0, opts: GuardPaths = {}): GuardReceipt[] {
  try {
    const all = parseReceipts(fs.readFileSync(paths(opts).receipts, "utf8"));
    return all.filter((r) => Date.parse(r.at) >= since);
  } catch {
    return [];
  }
}

/** For `live`: what guard does from now on, polled. */
export function tailReceipts(opts: GuardPaths = {}): { poll(): GuardReceipt[] } {
  const file = paths(opts).receipts;
  const sizeOf = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  let offset = sizeOf();
  return {
    poll() {
      const size = sizeOf();
      if (size < offset) offset = 0;
      if (size === offset) return [];
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        const text = buf.toString("utf8");
        // Keep a half-written last line for the next poll.
        const end = text.lastIndexOf("\n") + 1;
        offset += Buffer.byteLength(text.slice(0, end));
        return parseReceipts(text.slice(0, end));
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

interface SavedHandoff {
  version: 2;
  cwd: string;
  session: string;
  at: number;
  text: string;
  usd: number;
  /** That conversation's last call, so the new one knows how old the note is. */
  lastAt?: number;
  /** When that conversation was cleared, so only its own /clear reads the note. */
  clearedAt?: number;
}

/** One note per folder, named the way Claude Code names its project folders. */
const handoffFile = (p: Paths, cwd: string) =>
  path.join(p.handoffs, `${cwd.replace(/[^A-Za-z0-9]/g, "-")}.json`);

function readHandoff(p: Paths, cwd: string): SavedHandoff | null {
  try {
    const h = JSON.parse(fs.readFileSync(handoffFile(p, cwd), "utf8")) as SavedHandoff;
    return h?.version === 2 && typeof h.text === "string" ? h : null;
  } catch {
    return null;
  }
}

/** Notes nobody read in time hold a clip of a prompt, so they don't stay around. */
function pruneHandoffs(p: Paths, now: number): void {
  for (const name of fs.readdirSync(p.handoffs)) {
    const file = path.join(p.handoffs, name);
    if (now - fs.statSync(file).mtimeMs > HANDOFF_TTL_MS) fs.rmSync(file, { force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The hooks
 * ------------------------------------------------------------------ */

/** The parts of Claude Code's hook input guard reads. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  agent_id?: string;
}

export interface GuardHookOptions extends GuardPaths {
  now?: number;
  /** Where Claude Code compacts, when set. Unset falls back to the model's window. */
  compactAt?: number | null;
  /** Starts working out the week's line in the background, so no hook waits on it. */
  weekRun?: () => void;
}

/**
 * Run one hook: what to print back to Claude Code, or null to let it go on.
 * Anything unexpected lets it go on; a guard must never be in the way.
 */
export function guardHook(
  input: HookInput,
  opts: GuardHookOptions = {},
): Record<string, unknown> | null {
  const p = paths(opts);
  const now = opts.now ?? Date.now();
  try {
    switch (input.hook_event_name) {
      case "UserPromptSubmit":
        return onPrompt(input, p, now);
      case "PreToolUse":
        if (input.agent_id) return null;
        if (input.tool_name === "Read") return onRead(input, p, now);
        if (input.tool_name === "Bash") return onBash(input, p, now);
        return null;
      case "SessionStart":
        return onStart(input, p, now);
      case "SessionEnd":
        return onEnd(input, p, now);
      case "Stop":
        return onStop(input, p, now, opts.compactAt ?? null) ?? onWeek(input, p, now, opts.weekRun);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/** A message to a conversation whose cache expired: hold it once, with a way out. */
function onPrompt(input: HookInput, p: Paths, now: number) {
  const file = input.transcript_path;
  const session = input.session_id;
  if (!file || !session) return null;
  const lines = transcriptTail(file);
  if (!lines) return null;
  const s = cacheStateOf(lines, file);
  if (!s || s.expiresAt === null || now < s.expiresAt) return null;
  if (s.context < COLD_MIN_CONTEXT || s.rewriteUsd < HOLD_MIN_USD) return null;
  // Nobody is there to send a held message again in a headless run.
  if (transcriptFacts(lines).entrypoint?.startsWith("sdk")) return null;

  const at = new Date(now).toISOString();
  const key = `cold|${session}|${s.event.id}`;
  if (readMarks(p)[key]) {
    // Sent again: carrying on here, so the note is not needed.
    const cwd = input.cwd;
    if (cwd && readHandoff(p, cwd)?.session === session)
      fs.rmSync(handoffFile(p, cwd), { force: true });
    receipt(p, { at, session, kind: "cold-sent", usd: s.rewriteUsd, tokens: s.context });
    return null;
  }
  mark(p, key, now);
  // The note looks further back, for the files changed before the last few calls.
  const facts = transcriptFacts(transcriptTail(file, NOTE_BYTES) ?? lines);
  const note = input.cwd ? handoffNote(facts, input.cwd) : null;
  if (note && input.cwd) {
    const h: SavedHandoff = {
      version: 2,
      cwd: input.cwd,
      session,
      at: now,
      text: note,
      usd: s.rewriteUsd,
      lastAt: Date.parse(s.event.ts),
    };
    fs.mkdirSync(p.handoffs, { recursive: true });
    pruneHandoffs(p, now);
    fs.writeFileSync(handoffFile(p, input.cwd), JSON.stringify(h, null, 2) + "\n");
  }
  receipt(p, {
    at,
    session,
    kind: "cold-hold",
    usd: s.rewriteUsd,
    tokens: s.context,
    detail: s.event.model,
  });
  return {
    decision: "block",
    reason: coldHoldReason(s, now, { handoff: note !== null, cheaper: cheaperRewrite(s) }),
  };
}

/** What a whole-file read would send: Claude Code stops after 2000 lines. */
function readBytes(file: string, size: number): number {
  if (size <= BIG_READ_BYTES) return size;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    let lines = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10 && ++lines === READ_LINES) return i + 1;
    }
    return buf.length;
  } finally {
    fs.closeSync(fd);
  }
}

/** A whole big file: held once, so Claude reads the part it needs. */
function onRead(input: HookInput, p: Paths, now: number) {
  const t = input.tool_input ?? {};
  const session = input.session_id;
  if (!session || typeof t.file_path !== "string") return null;
  if (t.offset !== undefined || t.limit !== undefined || t.pages !== undefined) return null;
  // Images and PDFs are read another way and priced another way.
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg|pdf|ipynb)$/i.test(t.file_path)) return null;
  const file = path.resolve(input.cwd ?? process.cwd(), t.file_path);
  const fileBytes = fs.statSync(file).size;
  const bytes = readBytes(file, fileBytes);
  if (bytes <= BIG_READ_BYTES) return null;
  const key = `read|${session}|${file}`;
  const marks = readMarks(p);
  if (marks[key]) {
    // Read whole after all: the hold didn't stick, so it doesn't count as kept.
    if (!marks[`${key}|sent`]) {
      mark(p, `${key}|sent`, now);
      receipt(p, { at: new Date(now).toISOString(), session, kind: "big-read-sent", detail: file });
    }
    return null;
  }
  mark(p, key, now);
  const lines = input.transcript_path ? transcriptTail(input.transcript_path) : null;
  const s = lines && input.transcript_path ? cacheStateOf(lines, input.transcript_path) : null;
  const usd = s ? writeUsd(readTokens(bytes), s) : null;
  receipt(p, {
    at: new Date(now).toISOString(),
    session,
    kind: "big-read",
    ...(usd !== null ? { usd } : {}),
    tokens: readTokens(bytes),
    detail: file,
  });
  return deny(bigReadReason(file, bytes, fileBytes));
}

/** The same command again after it failed twice with nothing changed: held once. */
function onBash(input: HookInput, p: Paths, now: number) {
  const command = input.tool_input?.command;
  const session = input.session_id;
  if (!session || !input.transcript_path || typeof command !== "string") return null;
  const lines = transcriptTail(input.transcript_path);
  if (!lines) return null;
  const facts = transcriptFacts(lines);
  const cmd = command.trim();
  if ((facts.failing.get(cmd) ?? 0) < RETRY_LIMIT) return null;
  // One hold per streak: a change that works starts a new one.
  const key = `retry|${session}|${facts.lastChange ?? "start"}|${cmd}`;
  const detail = cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd;
  const marks = readMarks(p);
  if (marks[key]) {
    if (!marks[`${key}|sent`]) {
      mark(p, `${key}|sent`, now);
      receipt(p, { at: new Date(now).toISOString(), session, kind: "retry-sent", detail });
    }
    return null;
  }
  mark(p, key, now);
  receipt(p, { at: new Date(now).toISOString(), session, kind: "retry", detail });
  return deny(RETRY_REASON);
}

/** A /clear of the conversation guard held: the new one starts from its note. */
function onStart(input: HookInput, p: Paths, now: number) {
  if (input.source !== "clear") return null;
  const cwd = input.cwd;
  const session = input.session_id;
  if (!cwd || !session) return null;
  if (fs.existsSync(p.handoffs)) pruneHandoffs(p, now);
  const h = readHandoff(p, cwd);
  if (!h || h.session === session) return null;
  if (now - h.at > HANDOFF_TTL_MS) {
    fs.rmSync(handoffFile(p, cwd), { force: true });
    return null;
  }
  // A /clear of another conversation in the folder leaves the note for the held one.
  if (h.clearedAt === undefined) return null;
  // Read once, then gone: a later conversation starts on its own.
  fs.rmSync(handoffFile(p, cwd), { force: true });
  receipt(p, {
    at: new Date(now).toISOString(),
    session,
    kind: "handoff-used",
    usd: h.usd,
    detail: h.session,
  });
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: handoffContext(h.text, h.at, h.lastAt),
    },
  };
}

/**
 * A /clear ends the old conversation before the new one starts, so when the
 * held one is cleared its note is marked for the conversation that comes next.
 */
function onEnd(input: HookInput, p: Paths, now: number) {
  const cwd = input.cwd;
  if (input.reason !== "clear" || !cwd || !input.session_id) return null;
  const h = readHandoff(p, cwd);
  if (!h || h.session !== input.session_id) return null;
  fs.writeFileSync(handoffFile(p, cwd), JSON.stringify({ ...h, clearedAt: now }, null, 2) + "\n");
  return null;
}

/** The end of a turn near the compaction point: say so once, while it is a good moment. */
function onStop(input: HookInput, p: Paths, now: number, compactAt: number | null) {
  const file = input.transcript_path;
  const session = input.session_id;
  if (!file || !session) return null;
  const lines = transcriptTail(file);
  if (!lines) return null;
  const s = cacheStateOf(lines, file);
  if (!s) return null;
  const at = compactAt ?? priceFor(s.event.model)?.contextTokens ?? null;
  if (!at || s.context < at * COMPACT_NUDGE_SHARE || s.context >= at) return null;
  const key = `compact|${session}|${s.event.contextEpoch ?? 0}`;
  if (readMarks(p)[key]) return null;
  mark(p, key, now);
  receipt(p, { at: new Date(now).toISOString(), session, kind: "compact", tokens: s.context });
  return { systemMessage: compactNudge(s.context, at) };
}

/** The Monday of `now`'s week, as a local YYYY-MM-DD. */
function weekOf(now: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Saved by `optimaizr guard week`, for the first conversation of the week to show. */
export function saveWeekLine(text: string, opts: GuardPaths & { now?: number } = {}): void {
  const p = paths(opts);
  fs.mkdirSync(p.dir, { recursive: true });
  const week = weekOf(opts.now ?? Date.now());
  fs.writeFileSync(p.week, JSON.stringify({ week, text }) + "\n");
}

/**
 * Once a week, at the end of a turn: the last 7 days in a line. Working it
 * out reads two weeks of transcripts, so the first turn of the week starts it
 * in the background and a later turn shows it.
 */
function onWeek(input: HookInput, p: Paths, now: number, run?: () => void) {
  if (!input.transcript_path || !input.session_id) return null;
  const week = weekOf(now);
  const marks = readMarks(p);
  if (marks[`week|${week}`]) return null;
  const lines = transcriptTail(input.transcript_path);
  // Nobody reads a headless run's messages.
  if (!lines || transcriptFacts(lines).entrypoint?.startsWith("sdk")) return null;
  let saved: { week?: string; text?: string } = {};
  try {
    saved = JSON.parse(fs.readFileSync(p.week, "utf8"));
  } catch {
    // Not worked out yet.
  }
  if (saved.week === week && typeof saved.text === "string") {
    mark(p, `week|${week}`, now);
    const kept = savedText(guardSaved(readReceipts(now - 7 * 86_400_000, { dir: p.dir })));
    return {
      systemMessage: `optimAIzr, your last 7 days: ${saved.text}.${kept ? ` Guard: ${kept}.` : ""}`,
    };
  }
  if (run && !marks[`week-run|${week}`]) {
    mark(p, `week-run|${week}`, now);
    run();
  }
  return null;
}
