import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

import { costOf, providerOf } from "../pricing.js";
import type {
  CallEvent,
  Dataset,
  RateLimitSnapshot,
  RateLimitWindow,
  ToolCall,
} from "../domain/types.js";

/**
 * Codex CLI transcripts, the OpenAI counterpart to `ingestClaudeCode`. Codex
 * writes one rollout per session to `~/.codex/sessions/YYYY/MM/DD/`, one
 * `{ type, timestamp, payload }` per line. The lines that matter:
 * - `session_meta`: session id and cwd, once at the top.
 * - `turn_context`: model and reasoning effort for the next turn (can change).
 * - `response_item`: `function_call` / `function_call_output` pairs.
 * - `event_msg` with `payload.type === "token_count"`: one billable response,
 *   whose `last_token_usage` delta becomes a `UsageEvent`.
 *
 * Counts are OpenAI-style (input includes cached, output includes reasoning),
 * so they go through `normalizeUsage` rather than being unpicked here.
 */

/** Codex's own folder: `CODEX_HOME` when set, else ~/.codex. */
export function codexHome(): string {
  const set = process.env.CODEX_HOME?.trim();
  return set ? path.resolve(set) : path.join(os.homedir(), ".codex");
}

export interface CodexIngestOptions {
  /** Defaults to `$CODEX_HOME/sessions`, i.e. `~/.codex/sessions`. */
  root?: string;
  days?: number;
  project?: string;
}

/** Codex's per-call token counts, as written to the rollout. */
interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Codex's counts in `normalizeUsage`'s vocabulary, so the provider's cache
 * policy does the subtraction rather than a second copy of it here.
 */
function usageShape(u: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: num(u.input_tokens),
    input_tokens_details: { cached_tokens: num(u.cached_input_tokens) },
    output_tokens: num(u.output_tokens),
    output_tokens_details: { reasoning_tokens: num(u.reasoning_output_tokens) },
  };
}

/** Mirrors the Claude adapter's convention so `repeat-tool-calls` can match across vendors. */
function signatureOf(name: string, args: unknown): string {
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  const text = raw.trim().replace(/\s+/g, " ");
  return `${name}:${text.length > 200 ? text.slice(0, 200) : text}`;
}

/** Tool output can be a string or a wrapped object; only its size matters here. */
function outputChars(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.output === "string") return o.output.length;
    if (typeof o.content === "string") return o.content.length;
    try {
      return JSON.stringify(output).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Every rollout file under the sessions root, which is nested by date. */
function listRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable day directory must not lose the rest
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Resumable parse state for one rollout. Each `token_count` is a complete
 * billable unit, so nothing needs to settle; what persists is the turn's
 * model, the session, tools seen since the last event, and the running total.
 */
export interface CodexState {
  file: string;
  sessionId: string;
  cwd: string;
  model: string;
  effort: string | null;
  seq: number;
  lastTotal: number;
  /** Tool calls seen since the previous billable event, by call id. */
  pending: Map<string, ToolCall>;
  /** The prompt being answered: calls sharing it are one task. */
  turnId?: string;
  turns: number;
  /** Compactions so far: what was read before one is gone from context. */
  epoch: number;
  /** The latest limit meter, including one from a refresh that billed nothing. */
  limits?: RateLimitSnapshot;
}

export function createCodexState(file: string): CodexState {
  return {
    file,
    sessionId: path.basename(file, ".jsonl"),
    cwd: "unknown",
    model: "",
    effort: null,
    seq: 0,
    lastTotal: 0,
    pending: new Map(),
    turns: 0,
    epoch: 0,
  };
}

/** Codex reports a command's exit status inside its output text. */
function failed(output: unknown): boolean {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const m = /Process exited with code (\d+)|"exit_code":\s*(\d+)/.exec(text ?? "");
  return Boolean(m && Number(m[1] ?? m[2]) !== 0);
}

/**
 * Fold one rollout line into the state, returning an event when the line
 * completed a call. Shared by batch and live reading; never throws.
 */
export function consumeCodexLine(state: CodexState, line: string): CallEvent | null {
  if (!line.trim()) return null;

  let row: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }

  const p = row.payload ?? {};

  if (row.type === "session_meta") {
    if (typeof p.id === "string") state.sessionId = p.id;
    if (typeof p.cwd === "string") state.cwd = p.cwd;
    return null;
  }

  if (row.type === "turn_context") {
    if (typeof p.model === "string") state.model = p.model;
    state.effort = typeof p.effort === "string" ? p.effort : null;
    return null;
  }

  if (row.type === "response_item") {
    const kind = p.type;
    if (kind === "function_call" || kind === "custom_tool_call") {
      const id = typeof p.call_id === "string" ? p.call_id : `t${state.pending.size}`;
      const name = typeof p.name === "string" ? p.name : "unknown";
      state.pending.set(id, { id, name, signature: signatureOf(name, p.arguments ?? p.input) });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : "";
      const tool = state.pending.get(id);
      if (tool) {
        tool.resultChars = outputChars(p.output);
        if (failed(p.output)) tool.isError = true;
      }
    }
    return null;
  }

  if (row.type === "event_msg" && p.type === "context_compacted") {
    state.epoch++;
    return null;
  }

  if (row.type === "event_msg" && p.type === "user_message") {
    state.turnId = `${state.sessionId}:t${state.turns++}`;
    return null;
  }

  // The billable unit.
  if (row.type !== "event_msg" || p.type !== "token_count") return null;

  // Read before the billing checks: Codex also re-emits token_count purely to
  // refresh the meter, and that refresh is still the freshest reading.
  const limits = rateLimitsOf(p.rate_limits, row.timestamp);
  if (limits) state.limits = limits;

  const info = p.info as { total_token_usage?: TokenUsage; last_token_usage?: TokenUsage } | null;
  // Sessions open with an empty token_count before anything has been spent.
  if (!info || !info.last_token_usage) return null;

  const last = info.last_token_usage;
  const total = num(info.total_token_usage?.total_tokens);
  // Codex also re-emits token_count when nothing was billed (a limit refresh).
  // An unchanged running total means no new call.
  if (total > 0 && total <= state.lastTotal) return null;
  if (num(last.total_tokens) === 0) return null;
  state.lastTotal = total;

  const ts = row.timestamp ?? new Date().toISOString();
  const usage = usageShape(last);
  const resolved = state.model || "gpt-5";
  const tools = [...state.pending.values()];
  state.pending = new Map();

  return {
    // Deterministic, so re-reading the same rollout yields the same ids and
    // decisions stay attached to the calls they were made about.
    id: `${state.sessionId}#${state.seq++}`,
    source: "codex",
    ts,
    model: resolved,
    provider: providerOf(resolved),
    sessionId: state.sessionId,
    project: state.cwd,
    inputTokens: num(last.input_tokens) - num(last.cached_input_tokens),
    outputTokens: num(last.output_tokens),
    thinkingTokens: num(last.reasoning_output_tokens),
    cacheReadTokens: num(last.cached_input_tokens),
    // Codex never reports a cache write: OpenAI caches automatically and
    // bills nothing to create one.
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    effort: state.effort,
    ...(state.turnId ? { turnId: state.turnId } : {}),
    ...(state.epoch ? { contextEpoch: state.epoch } : {}),
    tools,
    ...(state.limits ? { rateLimits: state.limits } : {}),
    cost: costOf(usage, resolved, { at: ts }),
  };
}

/**
 * Codex's `rate_limits` block, normalised. Accepts `resets_at` (epoch seconds,
 * newer builds) or `resets_in_seconds` (older). Undefined when there's no
 * usable window, as in API-key sessions.
 */
export function rateLimitsOf(raw: unknown, at?: string): RateLimitSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const base = at ? Date.parse(at) : NaN;
  const windows: RateLimitWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = r[key] as Record<string, unknown> | null | undefined;
    if (!w || typeof w !== "object") continue;
    const used = Number(w.used_percent);
    const minutes = Number(w.window_minutes);
    let resets = NaN;
    if (Number.isFinite(Number(w.resets_at))) resets = Number(w.resets_at) * 1000;
    else if (Number.isFinite(Number(w.resets_in_seconds)) && Number.isFinite(base))
      resets = base + Number(w.resets_in_seconds) * 1000;
    if (!Number.isFinite(used) || !Number.isFinite(minutes) || !Number.isFinite(resets)) continue;
    windows.push({
      usedPercent: used,
      windowMinutes: minutes,
      resetsAt: new Date(resets).toISOString(),
    });
  }
  if (windows.length === 0) return undefined;
  return { planType: typeof r.plan_type === "string" ? r.plan_type : null, windows };
}

async function readRollout(file: string, warnings: string[]): Promise<CallEvent[]> {
  const events: CallEvent[] = [];
  const state = createCodexState(file);
  let bad = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    const event = consumeCodexLine(state, line);
    if (event) events.push(event);
  }

  if (bad) warnings.push(`${path.basename(file)}: skipped ${bad} unparseable line(s)`);
  return events;
}

export async function ingestCodex(opts: CodexIngestOptions = {}): Promise<Dataset> {
  const root = opts.root ?? path.join(codexHome(), "sessions");
  const warnings: string[] = [];

  if (!fs.existsSync(root)) {
    return {
      events: [],
      window: { from: "", to: "", days: 0 },
      sources: [],
      warnings: [`No Codex transcripts found at ${root}`],
    };
  }

  const files = listRollouts(root);
  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : null;
  const events: CallEvent[] = [];

  for (const file of files) {
    let parsed: CallEvent[];
    try {
      parsed = await readRollout(file, warnings);
    } catch (err) {
      // One corrupt rollout must not cost the user the rest of their history.
      warnings.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const e of parsed) {
      if (cutoff && new Date(e.ts).getTime() < cutoff) continue;
      if (opts.project && !e.project.toLowerCase().includes(opts.project.toLowerCase())) continue;
      events.push(e);
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days =
    from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) : 0;

  return { events, window: { from, to, days }, sources: [root], warnings };
}
