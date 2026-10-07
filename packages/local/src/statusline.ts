import fs from "node:fs";
import path from "node:path";

import {
  type CacheState,
  consumeTranscriptLine,
  createCacheWatch,
  createTranscriptState,
  takeSettled,
} from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";
import { claudeProjectsRoot } from "./live.js";
import { claudeSettingsPath } from "./rewriters.js";

/**
 * Claude Code's status line, run by `optimaizr statusline`: it reads the end
 * of the session's transcript for the cache state, and `optimaizr statusline on`
 * sets the command in ~/.claude/settings.json. A status line someone already has
 * is never replaced.
 */

/** How much of the transcript's end is read: a few hundred calls. */
const TAIL_BYTES = 512 * 1024;
/** Claude Code also re-runs the command this often, so the countdown moves. */
const REFRESH_SECONDS = 30;

/** The cache state of the conversation in this transcript, from its last calls. */
export function transcriptCacheState(file: string, maxBytes = TAIL_BYTES): CacheState | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    // Reading from the middle starts inside a line.
    if (start > 0) lines.shift();
    const state = createTranscriptState();
    for (const line of lines) consumeTranscriptLine(state, line, file, 0);
    const watch = createCacheWatch();
    const events = takeSettled(state, 0, Infinity).sort((a, b) => a.ts.localeCompare(b.ts));
    for (const e of events) watch.push(e);
    return watch.latest();
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The Claude Code conversation written to last, for a preview in the terminal. */
export function latestClaudeTranscript(root: string = claudeProjectsRoot()): string | null {
  let best: { file: string; at: number } | null = null;
  try {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        const at = fs.statSync(file).mtimeMs;
        if (!best || at > best.at) best = { file, at };
      }
    }
  } catch {
    // No Claude Code here, or a folder that can't be read.
  }
  return best?.file ?? null;
}

export interface StatuslinePaths {
  claudeSettings?: string;
  /** Where apply notes what it set, for undo. */
  record?: string;
}

export interface StatuslineResult {
  ok: boolean;
  /** False when it was already set. */
  changed: boolean;
  detail: string;
}

function paths(opts: StatuslinePaths) {
  return {
    settings: opts.claudeSettings ?? claudeSettingsPath(),
    record: opts.record ?? path.join(optimaizrDir(), "statusline.json"),
  };
}

function readSettings(file: string): Record<string, unknown> | string {
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

function writeSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

function commandOf(settings: Record<string, unknown>): string | null {
  const line = settings.statusLine as { command?: unknown } | undefined;
  return typeof line?.command === "string" ? line.command : null;
}

/** Ours: `optimaizr statusline`, or the full-path form, whose path names the package. */
const isOurs = (command: string | null) =>
  command !== null && /optimaizr/i.test(command) && /\bstatusline"?\s*$/.test(command);

/**
 * The command Claude Code should run: this node and this script by full path.
 * Claude Code's shell can find another node first (an nvm default, say), and
 * a global install updates in place, so the path keeps working. Null when run
 * through npx, whose copy can be cleaned away and is slow to start each time.
 */
export function statuslineCommand(
  script: string = process.argv[1] ?? "",
  node: string = process.execPath,
): string | null {
  if (!script) return null;
  let real = script;
  try {
    real = fs.realpathSync(script);
  } catch {
    // Keep the path as given.
  }
  const slash = (p: string) => p.replaceAll("\\", "/");
  if (slash(real).includes("/_npx/")) return null;
  return `"${slash(node)}" "${slash(real)}" statusline`;
}

export function statuslineApplied(opts: StatuslinePaths = {}): boolean {
  const settings = readSettings(paths(opts).settings);
  return typeof settings !== "string" && isOurs(commandOf(settings));
}

export function applyStatusline(
  command: string | null,
  opts: StatuslinePaths = {},
): StatuslineResult {
  const p = paths(opts);
  if (command === null) {
    return {
      ok: false,
      changed: false,
      detail:
        "optimAIzr is running through npx. Install it so Claude Code can run it quickly: npm i -g optimaizr, then optimaizr statusline on",
    };
  }
  const settings = readSettings(p.settings);
  if (typeof settings === "string") return { ok: false, changed: false, detail: settings };
  const current = commandOf(settings);
  if (isOurs(current)) {
    return { ok: true, changed: false, detail: `statusLine is set in ${p.settings}.` };
  }
  if (current !== null) {
    return {
      ok: false,
      changed: false,
      detail: `Claude Code already runs your own status line (${current}); optimAIzr leaves it alone. To show both, print the output of \`optimaizr statusline\` from your script, passing it the same input.`,
    };
  }
  writeSettings(p.settings, {
    ...settings,
    statusLine: { type: "command", command, refreshInterval: REFRESH_SECONDS },
  });
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
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
    detail: `statusLine in ${p.settings}. Claude Code shows it under the prompt; restart a session that doesn't pick it up.`,
  };
}

/** Take the status line out again. Null when optimAIzr had not set one. */
export function undoStatusline(opts: StatuslinePaths = {}): StatuslineResult | null {
  const p = paths(opts);
  fs.rmSync(p.record, { force: true });
  const settings = readSettings(p.settings);
  if (typeof settings === "string") return { ok: false, changed: false, detail: settings };
  if (!isOurs(commandOf(settings))) return null;
  const next = { ...settings };
  delete next.statusLine;
  writeSettings(p.settings, next);
  return { ok: true, changed: true, detail: `statusLine removed from ${p.settings}.` };
}
