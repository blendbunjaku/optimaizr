import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

import type { CallEvent, Dataset } from "@optimaizr/core";

/**
 * Append-only JSONL store for recorded calls. No daemon, database or network,
 * and every write is best-effort: the recorder must never fail a request.
 */

export function optimaizrDir(): string {
  return process.env.OPTIMAIZR_DIR ?? path.join(os.homedir(), ".optimaizr");
}

export function ledgerPath(): string {
  return path.join(optimaizrDir(), "events.jsonl");
}

let queue: string[] = [];
let flushing = false;
let flushTimer: NodeJS.Timeout | null = null;

function flushSync(): void {
  if (queue.length === 0) return;
  const batch = queue.join("");
  queue = [];
  try {
    fs.mkdirSync(optimaizrDir(), { recursive: true });
    fs.appendFileSync(ledgerPath(), batch);
  } catch {
    /* recording must never break the caller */
  }
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.join("");
  queue = [];
  try {
    await fs.promises.mkdir(optimaizrDir(), { recursive: true });
    await fs.promises.appendFile(ledgerPath(), batch);
  } catch {
    /* best effort */
  } finally {
    flushing = false;
    if (queue.length > 0) void flush();
  }
}

let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  // Synchronous drain so short-lived scripts don't lose their tail.
  process.once("exit", flushSync);
  process.once("beforeExit", flushSync);
}

/** Queue an event for durable append. Never throws. */
export function append(event: CallEvent): void {
  try {
    queue.push(`${JSON.stringify(event)}\n`);
    hookExit();
    if (queue.length >= 32) {
      void flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, 1000);
      // Don't hold the event loop open on the recorder's account.
      if (typeof flushTimer.unref === "function") flushTimer.unref();
    }
  } catch {
    /* best effort */
  }
}

/** Force a drain (used by the CLI and by tests). */
export async function drain(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

export interface ReadOptions {
  days?: number;
  project?: string;
  route?: string;
}

/** Read recorded SDK events back out of the ledger. */
export async function readLedger(opts: ReadOptions = {}): Promise<Dataset> {
  const file = ledgerPath();
  const warnings: string[] = [];
  if (!fs.existsSync(file)) {
    return {
      events: [],
      window: { from: "", to: "", days: 0 },
      sources: [],
      warnings: [],
    };
  }

  const cutoff = opts.days ? Date.now() - opts.days * 86_400_000 : null;
  const events: CallEvent[] = [];
  let bad = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as CallEvent;
      if (cutoff && new Date(e.ts).getTime() < cutoff) continue;
      if (opts.project && !e.project?.includes(opts.project)) continue;
      if (opts.route && e.route !== opts.route) continue;
      events.push(e);
    } catch {
      bad++;
    }
  }

  if (bad) warnings.push(`ledger: skipped ${bad} unparseable line(s)`);
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days =
    from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) : 0;

  return { events, window: { from, to, days }, sources: [file], warnings };
}
