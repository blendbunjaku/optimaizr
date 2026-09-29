import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

import { costOf, providerOf } from "../pricing.js";
import { estimateImageTokens } from "./images.js";
import type { CallEvent, Dataset, ToolCall } from "../types.js";

/**
 * Ingest Claude Code session transcripts. Claude Code writes one JSONL record
 * per content block, each stamped with the whole response's `usage`, so summing
 * rows overcounts (1.91x on real transcripts). Records are grouped by
 * `message.id`, keeping the one with the largest token sum: early blocks carry
 * a placeholder `output_tokens`, the last one the real total.
 */

const CACHE_ROOT = path.join(os.homedir(), ".claude", "projects");

const CHARS_PER_TOKEN = 4;

/**
 * What a tool result cost to put in context: about four characters per token
 * for text, pixel dimensions for images (a screenshot is huge in base64 but
 * only about 1,600 tokens).
 */
function measureResult(content: unknown): {
  chars: number;
  tokens: number;
  images: number;
} {
  if (typeof content === "string") {
    return { chars: content.length, tokens: content.length / CHARS_PER_TOKEN, images: 0 };
  }
  if (!Array.isArray(content)) {
    if (content == null) return { chars: 0, tokens: 0, images: 0 };
    const s = JSON.stringify(content);
    return { chars: s.length, tokens: s.length / CHARS_PER_TOKEN, images: 0 };
  }

  let chars = 0;
  let tokens = 0;
  let images = 0;
  for (const block of content as any[]) {
    if (block?.type === "image" && typeof block?.source?.data === "string") {
      images++;
      tokens += estimateImageTokens(block.source.data);
      // The base64 payload isn't what the model reads, so it's not counted.
      continue;
    }
    if (block?.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
      tokens += block.text.length / CHARS_PER_TOKEN;
      continue;
    }
    const s = JSON.stringify(block ?? {});
    chars += s.length;
    tokens += s.length / CHARS_PER_TOKEN;
  }
  return { chars, tokens, images };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  };
  service_tier?: string;
  speed?: string;
}

interface ToolResultInfo {
  chars: number;
  tokens: number;
  images: number;
  isError: boolean;
}

/** Accumulator for one API response, assembled from its many JSONL records. */
interface Partial {
  messageId: string;
  usage: RawUsage;
  usageWeight: number;
  model: string;
  ts: string;
  sessionId: string;
  cwd?: string;
  effort?: string | null;
  isSubagent: boolean;
  stopReason?: string | null;
  tools: Map<string, ToolCall>;
}

/**
 * Parse state carried between reads. Batch ingestion pours a directory through
 * one; live tailing keeps one per file between polls.
 */
export interface TranscriptState {
  partials: Map<string, Partial>;
  toolResults: Map<string, ToolResultInfo>;
  /** messageId -> when it last changed, so a tailer can tell when it settled. */
  touchedAt: Map<string, number>;
}

export function createTranscriptState(): TranscriptState {
  return { partials: new Map(), toolResults: new Map(), touchedAt: new Map() };
}

function tokenWeight(u: RawUsage | undefined): number {
  if (!u) return -1;
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/** `Read:/abs/path`, `Bash:npm run build`, ...: used to detect repeated work. */
function signatureOf(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  switch (name) {
    case "Read":
    case "NotebookEdit":
      return `${name}:${pick("file_path") ?? ""}`;
    case "Edit":
    case "Write":
      return `${name}:${pick("file_path") ?? ""}`;
    case "Bash":
      return `Bash:${(pick("command") ?? "").trim().replace(/\s+/g, " ")}`;
    case "Grep":
      return `Grep:${pick("pattern") ?? ""}|${pick("path") ?? ""}`;
    case "Glob":
      return `Glob:${pick("pattern") ?? ""}`;
    case "WebFetch":
      return `WebFetch:${pick("url") ?? ""}`;
    default: {
      const json = JSON.stringify(i ?? {});
      return `${name}:${json.length > 200 ? json.slice(0, 200) : json}`;
    }
  }
}

function decodeProjectDir(dirName: string): string {
  // Claude Code encodes the cwd by replacing "/" with "-", which is lossy for
  // real hyphens. Only used as a fallback; `cwd` from the records wins.
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Fold one transcript line into the state. Returns false only when the line
 * couldn't be parsed. Live tailing uses this same function, so both paths agree
 * on what a call cost.
 */
export function consumeTranscriptLine(
  state: TranscriptState,
  line: string,
  file: string,
  at: number = Date.now(),
): boolean {
  const out = state.partials;
  const toolResults = state.toolResults;
  if (!line.trim()) return true;
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return false;
  }

  // Tool results live on the user side and tell us how much each tool pushed into context.
  if (rec.type === "user") {
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const m = measureResult(block.content);
        toolResults.set(block.tool_use_id, {
          chars: m.chars,
          tokens: m.tokens,
          images: m.images,
          isError: Boolean(block.is_error),
        });
      }
    }
    return true;
  }

  if (rec.type !== "assistant") return true;
  const msg = rec.message;
  if (!msg) return true;
  const model: string = msg.model ?? "";
  if (!model || model === "<synthetic>") return true;

  const messageId: string = msg.id ?? rec.requestId ?? rec.uuid;
  if (!messageId) return true;

  const usage: RawUsage = msg.usage ?? {};
  const weight = tokenWeight(usage);

  let p = out.get(messageId);
  if (!p) {
    p = {
      messageId,
      usage,
      usageWeight: weight,
      model,
      ts: rec.timestamp ?? new Date().toISOString(),
      sessionId: rec.sessionId ?? path.basename(file, ".jsonl"),
      cwd: rec.cwd,
      effort: rec.effort ?? null,
      isSubagent: Boolean(rec.isSidechain),
      stopReason: msg.stop_reason ?? null,
      tools: new Map(),
    };
    out.set(messageId, p);
  } else if (weight > p.usageWeight) {
    // A later record for the same response carries the completed usage.
    p.usage = usage;
    p.usageWeight = weight;
    if (msg.stop_reason) p.stopReason = msg.stop_reason;
  }

  // Every record that touches this response resets its settle clock.
  state.touchedAt.set(messageId, at);

  // Tool calls are spread across sibling records, so union them.
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type !== "tool_use") continue;
      const id = block.id ?? `${messageId}:${p.tools.size}`;
      if (!p.tools.has(id)) {
        p.tools.set(id, {
          id,
          name: block.name ?? "unknown",
          signature: signatureOf(block.name ?? "unknown", block.input),
        });
      }
    }
  }
  return true;
}

async function readTranscript(
  file: string,
  fallbackProject: string,
  state: TranscriptState,
  warnings: string[],
): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let bad = 0;
  for await (const line of rl) {
    if (!consumeTranscriptLine(state, line, file)) bad++;
  }
  if (bad > 0) warnings.push(`${path.basename(file)}: skipped ${bad} unparseable line(s)`);
  void fallbackProject;
}

function listTranscripts(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  return files;
}

export interface IngestOptions {
  /** Defaults to `~/.claude/projects`. */
  root?: string;
  /** Only include calls from the last N days. */
  days?: number;
  /** Substring match against the project path. */
  project?: string;
}

export async function ingestClaudeCode(opts: IngestOptions = {}): Promise<Dataset> {
  const root = opts.root ?? CACHE_ROOT;
  const warnings: string[] = [];

  if (!fs.existsSync(root)) {
    return {
      events: [],
      window: { from: "", to: "", days: 0 },
      sources: [],
      warnings: [`No Claude Code transcripts found at ${root}`],
    };
  }

  const files = listTranscripts(root);
  const state = createTranscriptState();

  for (const file of files) {
    const projectDir = path.relative(root, file).split(path.sep)[0] ?? "";
    try {
      await readTranscript(file, decodeProjectDir(projectDir), state, warnings);
    } catch (err) {
      // One unreadable transcript mustn't cost the rest of the history; keep what it gave.
      warnings.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : null;
  const events: CallEvent[] = [];

  for (const p of state.partials.values()) {
    const at = new Date(p.ts);
    if (cutoff && at.getTime() < cutoff) continue;

    const project = p.cwd ?? "unknown";
    if (opts.project && !project.toLowerCase().includes(opts.project.toLowerCase())) continue;

    events.push(buildTranscriptEvent(p, state));
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days =
    from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) : 0;

  const unpriced = new Set(events.filter((e) => e.cost.unpriced).map((e) => e.model));
  for (const m of unpriced) warnings.push(`Unknown model "${m}", priced at $0`);

  return { events, window: { from, to, days }, sources: files, warnings };
}

/**
 * One accumulated response as a `UsageEvent`. Shared by batch and live, so the
 * same call produces the same event either way.
 */
export function buildTranscriptEvent(p: Partial, state: TranscriptState): CallEvent {
  const u = p.usage;
  const tools = [...p.tools.values()].map((t) => {
    const r = state.toolResults.get(t.id);
    return r
      ? {
          ...t,
          resultChars: r.chars,
          resultTokens: r.tokens,
          imageCount: r.images,
          isError: r.isError,
        }
      : t;
  });

  return {
    id: p.messageId,
    source: "claude-code",
    ts: p.ts,
    model: p.model,
    provider: providerOf(p.model),
    sessionId: p.sessionId,
    project: p.cwd ?? "unknown",
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: Math.max(
      0,
      (u.cache_creation_input_tokens ?? 0) - (u.cache_creation?.ephemeral_1h_input_tokens ?? 0),
    ),
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
    stopReason: p.stopReason,
    effort: p.effort,
    speed: u.speed ?? null,
    serviceTier: u.service_tier ?? null,
    isSubagent: p.isSubagent,
    tools,
    cost: costOf(u, p.model, { at: p.ts, speed: u.speed }),
  };
}

/**
 * Remove and return responses that have stopped changing. A response arrives
 * across several records, the last carrying the final usage, so it's emitted
 * only after `quietMs` without an update.
 */
export function takeSettled(
  state: TranscriptState,
  quietMs: number,
  at: number = Date.now(),
): CallEvent[] {
  const out: CallEvent[] = [];
  for (const [id, touched] of state.touchedAt) {
    if (at - touched < quietMs) continue;
    const p = state.partials.get(id);
    if (p) out.push(buildTranscriptEvent(p, state));
    state.partials.delete(id);
    state.touchedAt.delete(id);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}
