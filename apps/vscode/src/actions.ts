import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { COMPACT_AT } from "@optimaizr/core";
import {
  applyCompaction,
  type ChangeEntry,
  guardApplied,
  openChanges,
  recordChange,
  undoCompaction,
  undoGuard,
} from "@optimaizr/local";
import { compactionNow, doneAt, guardNow } from "./snapshot.js";
import type { FixItem, Snapshot } from "./types.js";

export interface ActionResult {
  ok: boolean;
  message: string;
}

/* Guard. Its hooks run the CLI, so the CLI turns it on and off. */

const WINDOWS = process.platform === "win32";

/** The optimaizr CLI: the setting when it points at a file, else the first one on PATH. */
export function findCli(setting = "", env: NodeJS.ProcessEnv = process.env): string | null {
  if (setting.trim()) return fs.existsSync(setting.trim()) ? setting.trim() : null;
  const names = WINDOWS ? ["optimaizr.cmd", "optimaizr.exe", "optimaizr"] : ["optimaizr"];
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  // An editor started from the Dock can miss the shell's PATH; npm's usual homes.
  const home = os.homedir();
  dirs.push(
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  );
  if (WINDOWS && env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export function runCli(
  bin: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        // A .cmd shim only runs through the shell.
        shell: WINDOWS && /\.cmd$/i.test(bin),
      },
      (err, stdout, stderr) => {
        const out = stripVTControlCharacters(`${stdout}\n${stderr}`).trim();
        resolve({ ok: !err, out });
      },
    );
  });
}

/** The CLI's own line for what happened, minus the padding. */
export function cliDetail(out: string): string {
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^(Applied|Already on|Not applied|Reverted|Could not revert)/.test(l));
  return (
    line ??
    out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ??
    ""
  );
}

export async function setGuard(bin: string, on: boolean): Promise<ActionResult> {
  const r = await runCli(bin, ["guard", on ? "on" : "off"]);
  const now = guardApplied();
  if (now === on) {
    return {
      ok: true,
      message: on
        ? "Guard is on. New Claude Code conversations pick it up."
        : "Guard is off. Its hooks are out of Claude Code's settings.",
    };
  }
  return { ok: false, message: cliDetail(r.out) || "The CLI did not change guard." };
}

/** Off needs no CLI: it only takes guard's own hooks out of the settings. */
export function guardOff(): ActionResult {
  const r = undoGuard();
  if (!r) return { ok: true, message: "Guard was already off." };
  return r.ok
    ? { ok: true, message: "Guard is off. Its hooks are out of Claude Code's settings." }
    : { ok: false, message: r.detail };
}

/* Compaction: one setting in Claude Code's settings file, undone the same way. */

export function compactOn(tokens = COMPACT_AT): ActionResult {
  const results = applyCompaction(["claude-code"], { tokens });
  const r = results[0];
  if (!r) return { ok: false, message: "Nothing was changed." };
  return {
    ok: r.ok,
    message: r.ok
      ? `Claude Code now compacts a little before ${Math.round(tokens / 1000)}K. New conversations pick it up.`
      : r.detail,
  };
}

export function compactOff(): ActionResult {
  const results = undoCompaction();
  if (results.length === 0) {
    if (doneAt("context-compaction")) return undoDone("context-compaction");
    return { ok: true, message: "optimAIzr had not changed when Claude Code compacts." };
  }
  const bad = results.find((r) => !r.ok);
  return bad
    ? { ok: false, message: bad.detail }
    : { ok: true, message: "Claude Code compacts where it did before." };
}

/* Habits: you make the change, optimAIzr notes the day so results can measure it. */

export function markDone(fix: Pick<FixItem, "rule" | "scope">, now = new Date()): ActionResult {
  const entry: ChangeEntry = {
    kind: "record",
    rule: fix.rule,
    ...fix.scope,
    at: now.toISOString(),
  } as ChangeEntry;
  const already = openChanges(fix.rule).find(
    (c) =>
      (c.source ?? null) === (entry.source ?? null) &&
      (c.project ?? null) === (entry.project ?? null) &&
      (c.value ?? null) === (entry.value ?? null),
  );
  if (already) return { ok: true, message: "Already recorded. Results will show how it is going." };
  recordChange(entry);
  return {
    ok: true,
    message: "Recorded as done today. In a few days of use, results show what it changed.",
  };
}

export function undoDone(rule: string, now = new Date()): ActionResult {
  if (!openChanges(rule).some((c) => c.how === "by-hand")) {
    return { ok: true, message: "There was nothing recorded to undo." };
  }
  recordChange({ kind: "undo", rule, at: now.toISOString() });
  return { ok: true, message: "Undone. Results stop counting it from today." };
}

/** What the files say now, laid over a snapshot, so a click shows at once. */
export function withLocalState(s: Snapshot): Snapshot {
  return {
    ...s,
    compaction: compactionNow(),
    guard: guardNow(),
    fixes: s.fixes.map((f) => ({ ...f, doneAt: doneAt(f.rule) })),
  };
}
