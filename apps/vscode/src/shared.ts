import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { claudeConfigDir } from "@optimaizr/core";
import { optimaizrDir } from "@optimaizr/local";
import type { Snapshot } from "./types.js";

// What every VS Code window shares through ~/.optimaizr/vscode: the last
// snapshot, so a second window does not read the history again, and claims,
// so a heads-up shows in one window instead of all of them.

export function extensionDir(): string {
  return path.join(optimaizrDir(), "vscode");
}

export function snapshotPath(dir = extensionDir()): string {
  return path.join(dir, "snapshot.json");
}

export function readCachedSnapshot(
  days: number,
  maxAgeMs: number,
  opts: { dir?: string; now?: number } = {},
): Snapshot | null {
  try {
    const s = JSON.parse(fs.readFileSync(snapshotPath(opts.dir), "utf8")) as Snapshot;
    const age = (opts.now ?? Date.now()) - Date.parse(s.at);
    return s.version === 1 && s.days === days && age >= 0 && age < maxAgeMs ? s : null;
  } catch {
    return null;
  }
}

export function writeCachedSnapshot(s: Snapshot, dir = extensionDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Written whole then renamed, so another window never reads half a file.
    const tmp = `${snapshotPath(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, snapshotPath(dir));
  } catch {
    // A window that cannot share its snapshot still has its own.
  }
}

export function runWorker(file: string, days: number, timeoutMs = 180_000): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(file, { workerData: { days } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Reading the history took too long."));
    }, timeoutMs);
    worker.once("message", (m: { ok: boolean; snapshot?: Snapshot; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.ok && m.snapshot) resolve(m.snapshot);
      else reject(new Error(m.error ?? "The analysis stopped without a result."));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** True for the one window that gets to say this; the rest stay quiet. */
export function claim(key: string, dir = path.join(extensionDir(), "claims")): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.createHash("sha1").update(key).digest("hex").slice(0, 20);
    fs.writeFileSync(path.join(dir, name), String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export function pruneClaims(
  dir = path.join(extensionDir(), "claims"),
  maxAgeMs = 86_400_000,
  now = Date.now(),
): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {
        // Another window removed it first.
      }
    }
  } catch {
    // No claims yet.
  }
  return removed;
}

/**
 * Claude Code names a project's folder after its path, every character that is
 * not a letter or digit turned into a dash.
 */
export function projectDirName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The newest main transcript Claude Code wrote for a folder. */
export function newestTranscript(
  folder: string,
  root = path.join(claudeConfigDir(), "projects"),
): string | null {
  const dir = path.join(root, projectDirName(folder));
  let best: { file: string; at: number } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const at = fs.statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    }
  } catch {
    return null;
  }
  return best?.file ?? null;
}

const caseless = process.platform === "darwin" || process.platform === "win32";

/** A call made in one of these folders, or in a folder inside one. */
export function inFolders(project: string, folders: readonly string[]): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return caseless ? r.toLowerCase() : r;
  };
  const p = norm(project);
  return folders.some((f) => {
    const root = norm(f);
    return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}
