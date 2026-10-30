import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { costOf, PROVIDERS, providerOf, statedCost } from "../pricing.js";
import { toolSignatureOf, toolTargetOf, userPath } from "./claudecode.js";
import type { CompactionRecord, Dataset, ToolCall, UsageEvent } from "../domain/types.js";

/**
 * opencode history, the third agent beside Claude Code and Codex. opencode
 * keeps everything in one SQLite file; the tables that matter:
 * - `session`: directory, title, `parent_id` for subagents, and `model`, the
 *   model and effort the session is set to now.
 * - `message`: assistant messages name the model that answered (`modelID`,
 *   `variant`) and the user message (`parentID`); a `summary` is a compaction.
 * - `part`: each `step-finish` is one billed call with its tokens; `tool`
 *   parts are the calls it made.
 *
 * opencode normalises counts across vendors: input excludes cache traffic,
 * and reasoning sits beside output. This mapping is pure, tested without SQLite.
 */

export interface OpencodeSessionRow {
  id: string;
  parent_id?: string | null;
  directory?: string | null;
  title?: string | null;
  /** JSON `{ id, providerID, variant }`. */
  model?: string | null;
}

export interface OpencodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

export interface OpencodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
  /** Length measured where the output is stored, so the text isn't copied. */
  output_chars?: number | null;
}

export interface OpencodeRows {
  sessions: OpencodeSessionRow[];
  messages: OpencodeMessageRow[];
  parts: OpencodePartRow[];
  /** Invalid JSON left behind by the reader. */
  unparseableRows?: number;
}

export interface OpencodeMapOptions {
  days?: number;
  project?: string;
}

export interface OpencodeMapped {
  events: UsageEvent[];
  compactions: CompactionRecord[];
  titles: Record<string, string>;
  warnings: string[];
}

/** opencode's per-step token counts. */
interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parse(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function iso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * opencode's counts in `normalizeUsage`'s vocabulary. Add cache traffic back
 * for providers whose own counts include it, so their policy subtracts it once.
 */
function usageShape(t: Tokens, provider: string): Record<string, unknown> {
  const reasoning = num(t.reasoning);
  const read = num(t.cache?.read);
  const write = num(t.cache?.write);
  const output = {
    output_tokens: num(t.output) + reasoning,
    output_tokens_details: { reasoning_tokens: reasoning },
  };
  if (PROVIDERS[provider]?.inputIncludesCacheReads) {
    return {
      ...output,
      input_tokens: num(t.input) + read + write,
      input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
    };
  }
  return {
    ...output,
    input_tokens: num(t.input),
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  };
}

/**
 * optimAIzr's own prices first: opencode's `cost` is 0 on subscriptions. For a
 * model with no card here, opencode's figure is better than $0.
 */
function costed(t: Tokens, provider: string, model: string, ts: string, own: unknown) {
  const ours = costOf(usageShape(t, provider), model, { at: ts });
  const stated = num(own);
  if (!ours.unpriced || stated <= 0) return ours;
  // With no card the provider is unknown to the split, so give it each count apart.
  return statedCost(stated, usageShape(t, "unknown"), model);
}

const TOOL_NAMES = new Map([
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["multiedit", "MultiEdit"],
  ["bash", "Bash"],
  ["grep", "Grep"],
  ["glob", "Glob"],
  ["list", "LS"],
  ["todowrite", "TodoWrite"],
  ["todoread", "TodoWrite"],
  ["task", "Task"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["patch", "apply_patch"],
]);

function toolInput(raw: unknown): Record<string, unknown> {
  const input = { ...record(raw) };
  if ("filePath" in input) {
    input.file_path = input.filePath;
    delete input.filePath;
  }
  return input;
}

function stopReason(raw: unknown): string | null {
  const reason = str(raw);
  switch (reason) {
    case "tool-calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return reason || null;
  }
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Oldest first; opencode's ids sort by time, so they break ties. */
function byTime(a: { time_created: number; id: string }, b: { time_created: number; id: string }) {
  return a.time_created - b.time_created || a.id.localeCompare(b.id);
}

/** opencode's rows as calls. Bad JSON and timestamps become one warning. */
export function mapOpencodeRows(rows: OpencodeRows, opts: OpencodeMapOptions = {}): OpencodeMapped {
  const events: UsageEvent[] = [];
  const compactions: CompactionRecord[] = [];
  const titles: Record<string, string> = {};
  let bad = rows.unparseableRows ?? 0;
  let unnamed = 0;

  const sessions = new Map(rows.sessions.map((s) => [s.id, s]));
  const messagesOf = groupBy(rows.messages, (m) => m.session_id);
  const partsOf = groupBy(rows.parts, (p) => p.message_id);

  for (const s of rows.sessions) {
    if (s.title) titles[s.id] = s.title;
    // Sidechains share the root's conversation, but keep their own turns and epochs.
    let root = s;
    const ancestors = new Set([s.id]);
    while (root.parent_id) {
      const parent = sessions.get(root.parent_id);
      if (!parent || ancestors.has(parent.id)) break;
      ancestors.add(parent.id);
      root = parent;
    }
    const project = s.directory || root.directory || "unknown";
    const chosen = record(parse(s.model));
    let epoch = 0;
    let lastContext = 0;
    let toolLast = false;

    for (const m of (messagesOf.get(s.id) ?? []).sort(byTime)) {
      const data = parse(m.data);
      const messageTs = iso(m.time_created);
      if (!data || !messageTs) {
        bad++;
        continue;
      }
      if (data.role !== "assistant") continue;

      const model = str(data.modelID) || str(chosen.id) || "unknown";
      let provider = providerOf(model);
      const reportedProvider = str(data.providerID);
      if (provider === "unknown" && Object.hasOwn(PROVIDERS, reportedProvider))
        provider = reportedProvider;
      const effort = str(data.variant) || str(chosen.variant) || null;
      const parentID = str(data.parentID);
      const summary = data.summary === true;
      // Only the main conversation's compactions are counted, as for Claude Code.
      if (summary && lastContext > 0 && !s.parent_id) {
        compactions.push({
          source: "opencode",
          ts: messageTs,
          sessionId: s.id,
          project,
          // opencode doesn't record what triggered it or how long it took.
          trigger: "unknown",
          preTokens: lastContext,
          midTask: toolLast,
        });
      }

      let tools: ToolCall[] = [];
      for (const p of (partsOf.get(m.id) ?? []).sort(byTime)) {
        const part = parse(p.data);
        const ts = iso(p.time_created);
        if (!part || !ts) {
          bad++;
          continue;
        }
        if (part.type === "tool") {
          const state = record(part.state);
          const rawName = str(part.tool) || "unknown";
          const name = TOOL_NAMES.get(rawName) ?? rawName;
          const input = toolInput(state.input);
          const target = toolTargetOf(input);
          tools.push({
            id: str(part.callID) || p.id,
            name,
            signature: toolSignatureOf(name, input),
            ...(target ? { target } : {}),
            ...(typeof p.output_chars === "number" ? { resultChars: p.output_chars } : {}),
            ...(state.status === "error" ? { isError: true } : {}),
          });
          continue;
        }
        // The billable unit.
        if (part.type !== "step-finish") continue;

        const t = record(part.tokens) as Tokens;
        const reason = stopReason(part.reason);
        if (model === "unknown") unnamed++;
        events.push({
          // Stable across re-reads, so decisions stay attached to their calls.
          id: `${s.id}#${p.id}`,
          source: "opencode",
          ts,
          model,
          provider,
          sessionId: root.id,
          project,
          inputTokens: num(t.input),
          outputTokens: num(t.output) + num(t.reasoning),
          thinkingTokens: num(t.reasoning),
          cacheReadTokens: num(t.cache?.read),
          // opencode reports one write figure; bill it at the short-TTL rate.
          cacheWrite5mTokens: num(t.cache?.write),
          cacheWrite1hTokens: 0,
          effort,
          stopReason: reason,
          ...(s.parent_id ? { isSubagent: true } : {}),
          ...(parentID ? { turnId: `${s.id}:${parentID}` } : {}),
          ...(epoch ? { contextEpoch: epoch } : {}),
          tools,
          cost: costed(t, provider, model, ts, part.cost),
        });
        tools = [];
        lastContext = num(t.input) + num(t.cache?.read) + num(t.cache?.write);
        toolLast = reason === "tool_use";
      }
      if (summary) epoch++;
    }
  }

  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : null;
  const kept = (e: { ts: string; project: string }) =>
    !(cutoff && new Date(e.ts).getTime() < cutoff) &&
    !(opts.project && !e.project.toLowerCase().includes(opts.project.toLowerCase()));

  const warnings: string[] = [];
  if (bad) warnings.push(`opencode: skipped ${bad} unparseable row(s)`);
  if (unnamed) warnings.push(`opencode: ${unnamed} call(s) with no model, priced as unknown`);

  return {
    events: events.filter(kept).sort((a, b) => a.ts.localeCompare(b.ts)),
    compactions: compactions.filter(kept).sort((a, b) => a.ts.localeCompare(b.ts)),
    titles,
    warnings,
  };
}

/** `$XDG_DATA_HOME/opencode`, else ~/.local/share/opencode. */
export function opencodeDbPath(): string {
  const set = process.env.XDG_DATA_HOME?.trim();
  const base = set ? userPath(set) : path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode", "opencode.db");
}

/** The slice of `node:sqlite` used here; Node 20's types don't have it. */
export interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

export interface SqliteModule {
  DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb;
}

let sqlite: Promise<SqliteModule | null> | undefined;

/** SQLite where available, suppressing its one-time experimental warning. */
export function loadSqlite(): Promise<SqliteModule | null> {
  sqlite ??= (async () => {
    // A variable keeps TypeScript and the bundler from resolving it.
    const specifier = "node:sqlite";
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning.message;
      const type = typeof warning === "string" ? rest[0] : warning.name;
      if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
      return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return (await import(specifier)) as SqliteModule;
    } catch {
      return null;
    } finally {
      process.emitWarning = emit;
    }
  })();
  return sqlite;
}

export interface OpencodeReadOptions {
  since?: number;
  sessionIds?: string[];
}

/**
 * Read selected sessions' full history, retaining all ancestors for root
 * resolution. Indexed, bounded queries leave tool output and bad JSON behind.
 */
export function readOpencodeRows(db: SqliteDb, opts: OpencodeReadOptions = {}): OpencodeRows {
  const ids =
    opts.sessionIds ??
    (
      db.prepare("SELECT id FROM session WHERE time_updated >= ?").all(opts.since ?? 0) as {
        id: string;
      }[]
    ).map((s) => s.id);
  const rows: OpencodeRows = {
    sessions: db
      .prepare("SELECT id, parent_id, directory, title, model FROM session")
      .all() as OpencodeSessionRow[],
    messages: [],
    parts: [],
    unparseableRows: 0,
  };
  const selected = [...new Set(ids)];
  for (let start = 0; start < selected.length; start += 500) {
    const chunk = selected.slice(start, start + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    const messages = db
      .prepare(
        `SELECT m.id, m.session_id, m.time_created, m.data FROM message m
       WHERE m.session_id IN (${placeholders}) AND json_valid(m.data)
         AND json_extract(m.data, '$.role') = 'assistant'`,
      )
      .all(...chunk) as OpencodeMessageRow[];
    const parts = db
      .prepare(
        `SELECT p.id, p.message_id, p.session_id, p.time_created,
         json_remove(p.data, '$.state.output', '$.state.metadata') AS data,
         length(json_extract(p.data, '$.state.output')) AS output_chars
       FROM part p WHERE p.session_id IN (${placeholders}) AND json_valid(p.data)
         AND json_extract(p.data, '$.type') IN ('tool', 'step-finish')`,
      )
      .all(...chunk) as OpencodePartRow[];
    // Never `push(...parts)`: 500 busy sessions can hold 100k+ parts, and the
    // spread overflows V8's call stack.
    for (const m of messages) rows.messages.push(m);
    for (const p of parts) rows.parts.push(p);
    const [count] = db
      .prepare(
        `SELECT
         (SELECT count(*) FROM message WHERE session_id IN (${placeholders}) AND NOT json_valid(data)) +
         (SELECT count(*) FROM part WHERE session_id IN (${placeholders}) AND NOT json_valid(data)) AS bad`,
      )
      .all(...chunk, ...chunk) as { bad: number }[];
    rows.unparseableRows = (rows.unparseableRows ?? 0) + (count?.bad ?? 0);
  }
  return rows;
}

export interface OpencodeIngestOptions {
  /** Defaults to `opencodeDbPath()`. */
  db?: string;
  days?: number;
  project?: string;
}

function emptyDataset(warnings: string[]): Dataset {
  return { events: [], window: { from: "", to: "", days: 0 }, sources: [], warnings };
}

export const OPENCODE_V2_WARNING =
  "opencode: history from opencode 2.0 (session_v2) isn't read yet, only 1.x sessions";

// Names the Node in use and the way out, so the note says what to do.
export const OPENCODE_SQLITE_WARNING = `opencode history skipped: it needs Node 22.13 or later, and this is Node ${process.versions.node} (nvm install 22, or update Node)`;

/** A database that is there but failed to read; the reason follows in brackets. */
export const OPENCODE_READ_FAILED = "opencode history skipped: it couldn't be read";

/**
 * opencode 2.0 writes `session_v2` and `session_message` and stops writing
 * the 1.x tables. Which of the two this database has.
 */
export function opencodeSchema(db: SqliteDb): { v1: boolean; v2: boolean } {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name),
  );
  const v2 =
    tables.has("session_v2") && db.prepare("SELECT 1 FROM session_v2 LIMIT 1").all().length > 0;
  return { v1: tables.has("session"), v2 };
}

export async function ingestOpencode(opts: OpencodeIngestOptions = {}): Promise<Dataset> {
  const file = opts.db ?? opencodeDbPath();
  // Most people don't use opencode, so its absence at the default path is no news.
  if (!fs.existsSync(file)) {
    return emptyDataset(opts.db ? [`No opencode history found at ${file}`] : []);
  }

  const sqlite = await loadSqlite();
  if (!sqlite) return emptyDataset([OPENCODE_SQLITE_WARNING]);

  try {
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    let mapped: OpencodeMapped;
    let schema: ReturnType<typeof opencodeSchema>;
    try {
      schema = opencodeSchema(db);
      if (schema.v2 && !schema.v1) return emptyDataset([OPENCODE_V2_WARNING]);
      const rows = readOpencodeRows(db, {
        since: opts.days ? Date.now() - opts.days * 86_400_000 : 0,
      });
      mapped = mapOpencodeRows(rows, opts);
    } finally {
      db.close();
    }
    const { events, compactions, titles } = mapped;
    const warnings = schema.v2 ? [OPENCODE_V2_WARNING, ...mapped.warnings] : mapped.warnings;
    const from = events[0]?.ts ?? "";
    const to = events[events.length - 1]?.ts ?? "";
    const days =
      from && to
        ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000)
        : 0;
    return { events, window: { from, to, days }, sources: [file], warnings, compactions, titles };
  } catch (err) {
    return emptyDataset([
      `${OPENCODE_READ_FAILED} (${path.basename(file)}: ${err instanceof Error ? err.message : String(err)})`,
    ]);
  }
}
