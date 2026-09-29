import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  createLiveAnalyzer,
  createTranscriptState,
  consumeTranscriptLine,
  takeSettled,
  createCodexState,
  consumeCodexLine,
  type LiveOptions,
  type LiveRecommendation,
  type TranscriptState,
  type CodexState,
} from "@optimaizr/core";
import type { CallEvent } from "@optimaizr/core";
import { ledgerPath } from "./ledger.js";
import { createJevJudge, type JevJudge, type JevOptions } from "./jev.js";

/**
 * The host side of live analysis. Two ways in: pass `onEvent` to `wrap()` to
 * get recommendations inside the running app, or use `tailLedger()` so
 * `optimaizr live` can watch an app from another terminal. Both feed the same
 * analyzer and the same rules as the batch commands.
 */

export interface LiveSessionOptions {
  /** Called once per newly actionable finding. */
  onRecommendation: (rec: LiveRecommendation) => void;
  /** Tuning for the rolling window. See `LIVE_DEFAULTS`. */
  analyzer?: Omit<LiveOptions, "judge">;
  /**
   * Opt in to the Jev second opinion. Without it, the session never touches
   * the network. With it, only route metadata is sent (see `jev.ts`).
   */
  jev?: JevOptions;
}

export interface LiveSession {
  /** Hand this to `wrap({ onEvent })`, or drive it from `tailLedger`. */
  onEvent: (event: CallEvent) => void;
  /** Analyse whatever is buffered, regardless of the interval. */
  flush: () => LiveRecommendation[];
  /** Present only when Jev was opted into, for egress inspection. */
  jev?: JevJudge;
}

export function createLiveSession(opts: LiveSessionOptions): LiveSession {
  const jev = opts.jev ? createJevJudge(opts.jev) : undefined;

  const analyzer = createLiveAnalyzer({
    ...opts.analyzer,
    // A synchronous cache read. The network refresh below never sits on this
    // path, so a slow or dead Jev cannot delay analysis or the recorded call.
    ...(jev ? { judge: jev.judge } : {}),
  });

  function emit(recs: LiveRecommendation[]): void {
    for (const rec of recs) {
      try {
        opts.onRecommendation(rec);
      } catch {
        /* a broken renderer must not stop the stream */
      }
    }
  }

  return {
    onEvent(event: CallEvent): void {
      try {
        jev?.observe(event);
        emit(analyzer.push(event));
        // Fire and forget: self-throttled, and its result is only ever read
        // from the verdict cache on some later call.
        if (jev) void jev.refresh();
      } catch {
        /* never break the caller, same as the recorder */
      }
    },
    flush(): LiveRecommendation[] {
      const recs = analyzer.flush();
      emit(recs);
      return recs;
    },
    ...(jev ? { jev } : {}),
  };
}

export interface TailOptions {
  /** Replay this many existing events before following. Default 0. */
  backfill?: number;
  /** Poll interval in ms. Default 500. */
  intervalMs?: number;
  /** Path override, for tests. */
  path?: string;
  /**
   * Hold the event loop open. Off by default so a library watching a file never
   * keeps its host from exiting; `optimaizr live` turns it on.
   */
  keepAlive?: boolean;
}

/**
 * Follow the ledger as it grows. Polls the file size and reads only new bytes,
 * holding back a partial last line (the writer flushes in batches). Polling
 * instead of `fs.watch`, whose behaviour differs across platforms.
 */
export function tailLedger(
  onEvent: (event: CallEvent) => void,
  opts: TailOptions = {},
): { stop: () => void } {
  const file = opts.path ?? ledgerPath();
  const intervalMs = opts.intervalMs ?? 500;
  let offset = 0;
  let remainder = "";
  let reading = false;
  // A read can end mid-character, and `buf.toString()` would corrupt it into
  // U+FFFD. StringDecoder holds the partial sequence until the rest arrives.
  const decoder = new StringDecoder("utf8");

  function parse(chunk: string): void {
    const lines = (remainder + chunk).split("\n");
    // The last element is either "" (chunk ended on a newline) or a partial
    // line still being written. Either way it is not ours to parse yet.
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as CallEvent);
      } catch {
        /* a malformed line costs one event, not the stream */
      }
    }
  }

  // Start at the end unless backfill was asked for, so `live` reports on
  // traffic happening now rather than replaying the whole history.
  try {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (opts.backfill && size > 0) {
      const all = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line of all.slice(-opts.backfill)) {
        try {
          onEvent(JSON.parse(line) as CallEvent);
        } catch {
          /* ignore */
        }
      }
    }
    offset = size;
  } catch {
    offset = 0;
  }

  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    try {
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      // Truncated or rotated underneath us: start again from the top.
      if (size < offset) {
        offset = 0;
        remainder = "";
      }
      if (size === offset) return;
      const fd = fs.openSync(file, "r");
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        offset = size;
        parse(decoder.write(buf));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* transient fs errors are expected while another process writes */
    } finally {
      reading = false;
    }
  }, intervalMs);

  if (!opts.keepAlive && typeof timer.unref === "function") timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Agent transcripts
 * ------------------------------------------------------------------ */

/** Where Claude Code keeps its session transcripts. */
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Where Codex keeps its session rollouts. */
export function codexSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export interface TranscriptTailOptions {
  /** Defaults to the vendor's own root. */
  roots?: string[];
  /** Poll interval in ms. Default 1000. */
  intervalMs?: number;
  /**
   * How long a Claude Code response must sit untouched before it counts as
   * finished (it's written across several records, the last carrying usage).
   * Codex marks its own billable moment and ignores this. Default 2s.
   */
  quietMs?: number;
  /** Read existing files from the beginning rather than from their end. */
  backfill?: number | boolean;
  keepAlive?: boolean;
}

interface Followed<S> {
  offset: number;
  remainder: string;
  /** Holds a multi-byte character split across two reads. See tailLedger. */
  decoder: StringDecoder;
  state: S;
}

/**
 * The shared part of following a directory of growing JSONL session files:
 * finding files, per-file offsets, decoding across reads, holding back a
 * half-written line. `createState`, `onLine` and `drain` supply the parsing.
 */
function followFiles<S>(opts: {
  roots: string[];
  intervalMs: number;
  backfill: boolean;
  keepAlive: boolean;
  createState: (file: string) => S;
  onLine: (state: S, line: string, file: string) => CallEvent | null;
  /** Events that have become final since the last call. `force` on shutdown. */
  drain?: (state: S, force: boolean) => CallEvent[];
  onEvent: (event: CallEvent) => void;
}): { stop: () => void; flush: () => void } {
  const following = new Map<string, Followed<S>>();
  let reading = false;
  let startup = true;

  function files(): string[] {
    const out: string[] = [];
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
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
      }
    };
    for (const root of opts.roots) if (fs.existsSync(root)) walk(root);
    return out;
  }

  function follow(file: string, atStartup: boolean): Followed<S> {
    let f = following.get(file);
    if (f) return f;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* gone already */
    }
    // Files that already exist start at their end (`live` is about now;
    // `backfill` opts into history). A file that appears later is a new session,
    // so it's read from the start, or its first calls would be lost.
    f = {
      offset: opts.backfill || !atStartup ? 0 : size,
      remainder: "",
      decoder: new StringDecoder("utf8"),
      state: opts.createState(file),
    };
    following.set(file, f);
    return f;
  }

  function emit(event: CallEvent | null): void {
    if (!event) return;
    try {
      opts.onEvent(event);
    } catch {
      /* a broken consumer must not stop the stream */
    }
  }

  function poll(force = false): void {
    for (const file of files()) {
      const f = follow(file, startup);
      try {
        const size = fs.statSync(file).size;
        if (size < f.offset) {
          // Truncated or rotated underneath us.
          f.offset = 0;
          f.remainder = "";
        }
        if (size > f.offset) {
          const fd = fs.openSync(file, "r");
          try {
            const len = size - f.offset;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, f.offset);
            f.offset = size;
            const lines = (f.remainder + f.decoder.write(buf)).split("\n");
            // The tail is either "" or a line still being written.
            f.remainder = lines.pop() ?? "";
            for (const line of lines) emit(opts.onLine(f.state, line, file));
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        /* a session file can vanish mid-poll; the rest still matter */
      }

      if (opts.drain) for (const event of opts.drain(f.state, force)) emit(event);
    }
    startup = false;
  }

  // Seed the existing files immediately, so a session that starts a moment
  // later is correctly treated as new rather than as history.
  poll();

  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    try {
      poll();
    } finally {
      reading = false;
    }
  }, opts.intervalMs);

  if (!opts.keepAlive && typeof timer.unref === "function") timer.unref();

  return {
    /**
     * Emit everything still buffered, settled or not, so a shutdown doesn't
     * lose the response in flight.
     */
    flush(): void {
      poll(true);
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

/**
 * Follow Claude Code transcripts as a session writes them, so `live` works
 * without `wrap()`. Parse state is kept per file between polls, and it's the
 * same parser `scan` uses, so live and batch numbers agree.
 */
export function tailTranscripts(
  onEvent: (event: CallEvent) => void,
  opts: TranscriptTailOptions = {},
): { stop: () => void; flush: () => void } {
  const quietMs = opts.quietMs ?? 2000;
  return followFiles<TranscriptState>({
    roots: opts.roots ?? [claudeProjectsRoot()],
    intervalMs: opts.intervalMs ?? 1000,
    backfill: Boolean(opts.backfill),
    keepAlive: Boolean(opts.keepAlive),
    createState: () => createTranscriptState(),
    onLine: (state, line, file) => {
      consumeTranscriptLine(state, line, file);
      return null; // a transcript response is only final once it goes quiet
    },
    drain: (state, force) => takeSettled(state, force ? 0 : quietMs),
    onEvent,
  });
}

/**
 * Follow Codex rollouts as a session writes them. Codex writes a `token_count`
 * line when a call completes, so events are emitted immediately with nothing
 * to settle.
 */
export function tailCodex(
  onEvent: (event: CallEvent) => void,
  opts: TranscriptTailOptions = {},
): { stop: () => void; flush: () => void } {
  return followFiles<CodexState>({
    roots: opts.roots ?? [codexSessionsRoot()],
    intervalMs: opts.intervalMs ?? 1000,
    backfill: Boolean(opts.backfill),
    keepAlive: Boolean(opts.keepAlive),
    createState: (file) => createCodexState(file),
    onLine: (state, line) => consumeCodexLine(state, line),
    onEvent,
  });
}
