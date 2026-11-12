import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { optimaizrDir } from "./ledger.js";

/**
 * Write a whole file in one step: a temp file next to it, then a rename, so a
 * crash or a full disk leaves the old file, never half of the new one. A
 * symlink (a dotfiles repo, say) is followed, so the link stays a link.
 */
export function writeFileAtomic(file: string, data: string): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // Not there yet: write it where asked.
  }
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // A new file gets the usual mode.
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? {} : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Why a write failed, in a line that names the file. */
export function writeError(file: string, err: unknown): string {
  return `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * False when `~/.optimaizr/config.json` has `"manageSettings": false`: then
 * optimAIzr never writes Claude Code's or Codex's settings, and says what to
 * add by hand instead. For settings kept in a dotfiles repo.
 */
export function settingsManaged(file = path.join(optimaizrDir(), "config.json")): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as { manageSettings?: unknown };
    return config?.manageSettings !== false;
  } catch {
    return true;
  }
}

export const HANDS_OFF =
  "manageSettings is false in ~/.optimaizr/config.json, so nothing was written";
