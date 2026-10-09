import fs from "node:fs";
import path from "node:path";

import { codexHome, COMPACT_AT } from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";
import { claudeSettingsPath } from "./rewriters.js";

/**
 * The compaction lever, applied: Claude Code compacts at COMPACT_AT, or the
 * point passed with `--at`, when its `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env is
 * set (the settings key is behind a flag, the env is not), and Codex when
 * `model_auto_compact_token_limit` is in its config.toml. Both are read when a session starts, so a change reaches the
 * next session. The previous value is kept, so `undo` puts it back exactly.
 */

export type CompactAgent = "claude-code" | "codex";

const CLAUDE_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const CODEX_KEY = "model_auto_compact_token_limit";
const AGENT_NAME: Record<CompactAgent, string> = { "claude-code": "Claude Code", codex: "Codex" };

interface Change {
  agent: CompactAgent;
  file: string;
  /** What was there before, verbatim; null when the setting was absent. */
  previous: string | null;
  value: string;
  at: string;
}

export interface CompactionPaths {
  claudeSettings?: string;
  codexConfig?: string;
  /** Where the previous values are kept for undo. */
  ledger?: string;
}

export interface CompactionResult {
  agent: CompactAgent;
  ok: boolean;
  detail: string;
}

function paths(opts: CompactionPaths) {
  return {
    claude: opts.claudeSettings ?? claudeSettingsPath(),
    codex: opts.codexConfig ?? path.join(codexHome(), "config.toml"),
    ledger: opts.ledger ?? path.join(optimaizrDir(), "settings-changes.json"),
  };
}

function readLedger(file: string): Change[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.changes) ? parsed.changes : [];
  } catch {
    return [];
  }
}

function writeLedger(file: string, changes: Change[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, changes }, null, 2) + "\n");
}

/* ------------------------------------------------------------------ *
 * Claude Code: settings.json
 * ------------------------------------------------------------------ */

function readJson(file: string): Record<string, unknown> | string {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : `${file} is not a JSON object; leaving it alone`;
  } catch (err) {
    return `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Set (or with `value: null`, remove) the env var, merging into the user's file. */
function setClaudeEnv(file: string, value: string | null): string | null {
  const settings = readJson(file);
  if (typeof settings === "string") return settings;
  const env = { ...((settings.env as Record<string, string> | undefined) ?? {}) };
  if (value === null) delete env[CLAUDE_ENV];
  else env[CLAUDE_ENV] = value;
  const next = { ...settings, env };
  if (Object.keys(env).length === 0) delete (next as Record<string, unknown>).env;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return null;
}

function claudeValue(file: string): string | null {
  const settings = readJson(file);
  if (typeof settings === "string") return null;
  const v = (settings.env as Record<string, unknown> | undefined)?.[CLAUDE_ENV];
  return typeof v === "string" ? v : null;
}

/* ------------------------------------------------------------------ *
 * Codex: config.toml, edited as text so comments and order survive
 * ------------------------------------------------------------------ */

const CODEX_LINE = new RegExp(`^\\s*${CODEX_KEY}\\s*=\\s*(.*?)\\s*$`);

/** Top-level keys must come before the first [table]; that's the region searched. */
function topLevel(lines: string[]): number {
  const table = lines.findIndex((l) => /^\s*\[/.test(l));
  return table === -1 ? lines.length : table;
}

function codexValue(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const end = topLevel(lines);
  for (let i = 0; i < end; i++) {
    const m = CODEX_LINE.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

function setCodexKey(file: string, value: string | null): string | null {
  let text = "";
  try {
    if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const lines = text === "" ? [] : text.split("\n");
  const end = topLevel(lines);
  const at = lines.slice(0, end).findIndex((l) => CODEX_LINE.test(l));
  if (value === null) {
    if (at !== -1) lines.splice(at, 1);
  } else if (at !== -1) {
    lines[at] = `${CODEX_KEY} = ${value}`;
  } else {
    // Before the first table, after any top-level keys and blank lines.
    let insert = end;
    while (insert > 0 && lines[insert - 1]!.trim() === "") insert--;
    lines.splice(insert, 0, `${CODEX_KEY} = ${value}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
  return null;
}

/* ------------------------------------------------------------------ *
 * Apply, undo, status
 * ------------------------------------------------------------------ */

/** What each agent is set to compact at now, as written in its file. */
export function compactionStatus(opts: CompactionPaths = {}): Record<CompactAgent, string | null> {
  const p = paths(opts);
  return { "claude-code": claudeValue(p.claude), codex: codexValue(p.codex) };
}

export function applyCompaction(
  agents: CompactAgent[],
  opts: CompactionPaths & { now?: Date; tokens?: number } = {},
): CompactionResult[] {
  const p = paths(opts);
  const ledger = readLedger(p.ledger);
  const at = (opts.now ?? new Date()).toISOString();
  const tokens = opts.tokens ?? COMPACT_AT;
  const value = String(tokens);
  const results: CompactionResult[] = [];

  for (const agent of agents) {
    const file = agent === "claude-code" ? p.claude : p.codex;
    const current = agent === "claude-code" ? claudeValue(file) : codexValue(file);
    if (current === value) {
      results.push({ agent, ok: true, detail: `${file} already compacts at ${value}` });
      continue;
    }
    const error = agent === "claude-code" ? setClaudeEnv(file, value) : setCodexKey(file, value);
    if (error) {
      results.push({ agent, ok: false, detail: error });
      continue;
    }
    // Keep the first previous value: applying twice must still undo to the original.
    if (!ledger.some((c) => c.agent === agent)) {
      ledger.push({ agent, file, previous: current, value, at });
    }
    const was = current === null ? "unset" : current;
    const how =
      agent === "claude-code"
        ? `${file}: env ${CLAUDE_ENV} ${was} -> ${value}`
        : `${file}: ${CODEX_KEY} ${was} -> ${value}`;
    // Claude Code compacts short of its window: with 200000 set it fired at 166-170K.
    const point = `${agent === "claude-code" ? "a little before" : "at"} ${Math.round(tokens / 1000)}K`;
    results.push({
      agent,
      ok: true,
      detail: `${how}. ${AGENT_NAME[agent]} compacts ${point} from its next session.`,
    });
  }
  writeLedger(p.ledger, ledger);
  return results;
}

/** Put back exactly what was there before `applyCompaction`. */
export function undoCompaction(opts: CompactionPaths = {}): CompactionResult[] {
  const p = paths(opts);
  const ledger = readLedger(p.ledger);
  const results: CompactionResult[] = [];
  for (const c of ledger) {
    const error =
      c.agent === "claude-code"
        ? setClaudeEnv(c.file, c.previous)
        : setCodexKey(c.file, c.previous);
    results.push({
      agent: c.agent,
      ok: error === null,
      detail:
        error ??
        `${c.file}: ${c.previous === null ? "setting removed" : `back to ${c.previous}`}. ${AGENT_NAME[c.agent]} picks it up from its next session.`,
    });
  }
  writeLedger(
    p.ledger,
    ledger.filter((c) => results.some((r) => r.agent === c.agent && !r.ok)),
  );
  return results;
}

/** Whether an undo is waiting, for `optimaizr undo` with no rule. */
export function compactionApplied(opts: CompactionPaths = {}): CompactAgent[] {
  return readLedger(paths(opts).ledger).map((c) => c.agent);
}
