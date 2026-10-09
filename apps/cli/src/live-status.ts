import {
  blue,
  contextOf,
  COUNTDOWN_MS,
  dim,
  green,
  minutesLabel,
  modelLabel,
  tokens as fmtTokens,
  usd,
  yellow,
} from "@optimaizr/core";
import type { CacheWatch, UsageEvent } from "@optimaizr/core";

/**
 * The one line at the bottom of `optimaizr live` that says it is working: what
 * it watches, what this run has seen and spent, the last call, and when it last
 * checked. Redrawn in place, never scrolled, and only on an interactive
 * terminal; while a question is on screen it steps aside.
 */

/** A conversation counts as active this long after its last call. */
const ACTIVE_MS = 15 * 60_000;

export interface StatusState {
  startedAt: number;
  calls: number;
  spendUsd: number;
  /** Session id -> last call time. */
  sessions: Map<string, number>;
  last?: { model: string; costUsd: number; context: number; at: number };
  checkedAt?: number;
  /** Findings shown this run, by rule, with what each could have saved. */
  found: Map<string, number>;
  /** Long conversations and how long their cache stays warm. */
  cache?: CacheWatch;
}

export function emptyStatus(now = Date.now()): StatusState {
  return { startedAt: now, calls: 0, spendUsd: 0, sessions: new Map(), found: new Map() };
}

/** Fold one call into the state. */
export function recordCall(s: StatusState, e: UsageEvent, now = Date.now()): void {
  s.calls++;
  s.spendUsd += e.cost.total;
  s.sessions.set(e.sessionId, now);
  s.last = { model: e.model, costUsd: e.cost.total, context: contextOf(e), at: now };
  s.checkedAt = now;
}

function ago(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
}

/** The warm cache that expires first, or how long a Codex one has sat idle. */
function cachePart(s: StatusState, now: number): string | null {
  const warm = s.cache?.warm(now) ?? [];
  const first = warm[0];
  if (!first) return null;
  if (first.expiresAt === null) {
    return dim(
      `codex ${fmtTokens(first.context)} idle ${minutesLabel(now - Date.parse(first.event.ts))}`,
    );
  }
  const left = first.expiresAt - now;
  const text =
    warm.length === 1
      ? `cache ${fmtTokens(first.context)} warm ${minutesLabel(left)}`
      : `${warm.length} warm caches, first expires in ${minutesLabel(left)}`;
  return left <= COUNTDOWN_MS ? yellow(text) : dim(text);
}

/** The line itself, without colour codes counted against the width. */
export function renderStatus(s: StatusState, now = Date.now(), width = 120): string {
  const active = [...s.sessions.values()].filter((t) => now - t < ACTIVE_MS).length;
  // Each part with how much it matters: on a narrow terminal the least goes first.
  const parts: Array<{ text: string; keep: number }> = [
    { text: `${blue("◉")} optimAIzr live`, keep: 9 },
  ];
  if (s.calls === 0) {
    parts.push({ text: dim("watching for Claude Code, Codex and API calls..."), keep: 8 });
  } else {
    parts.push({ text: dim(`${active} active session${active === 1 ? "" : "s"}`), keep: 3 });
    parts.push({
      text: dim(`${s.calls} call${s.calls === 1 ? "" : "s"} · ${usd(s.spendUsd)} this run`),
      keep: 7,
    });
    if (s.last) {
      parts.push({
        text: dim(
          `last ${modelLabel(s.last.model)} ${usd(s.last.costUsd)}, ${fmtTokens(s.last.context)} context`,
        ),
        keep: 5,
      });
    }
    const cache = cachePart(s, now);
    if (cache) parts.push({ text: cache, keep: 6 });
    const found = [...s.found.values()].reduce((t, v) => t + v, 0);
    parts.push({
      text:
        s.found.size === 0
          ? green("no issues")
          : yellow(`${s.found.size} found, ${usd(found)} avoidable`),
      keep: 8,
    });
    if (s.checkedAt !== undefined) {
      parts.push({ text: dim(`checked ${ago(now - s.checkedAt)}`), keep: 4 });
    }
  }
  const line = () => parts.map((p) => p.text).join(dim(" · "));
  while (plain(line()).length > width - 2) {
    const least = parts.reduce((a, p) => (p.keep < a.keep ? p : a));
    if (least.keep >= 8) break;
    parts.splice(parts.indexOf(least), 1);
  }
  // The name and the verdict are never dropped, so past that the line is cut:
  // a wrapped line leaves a copy behind on every redraw.
  return clip(line(), width - 2);
}

const ESC = String.fromCharCode(27);
const plain = (x: string) => x.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

/** Cut a coloured line to `max` visible characters. Colour codes cost nothing. */
function clip(text: string, max: number): string {
  let out = "";
  let shown = 0;
  let inCode = false;
  for (const ch of text) {
    if (ch === ESC) inCode = true;
    if (inCode) {
      out += ch;
      if (ch === "m") inCode = false;
      continue;
    }
    if (shown >= max) return `${out}${ESC}[0m`;
    out += ch;
    shown++;
  }
  return out;
}

/** One line on stopping: what the run saw, what it found. */
export function renderRunSummary(s: StatusState, now = Date.now()): string {
  const mins = Math.max(1, Math.round((now - s.startedAt) / 60_000));
  const found = [...s.found.values()].reduce((t, v) => t + v, 0);
  const head = `  ${green("✓")} optimAIzr live ${dim(`· ${mins} min · ${s.calls} call${s.calls === 1 ? "" : "s"} · ${usd(s.spendUsd)} spent`)}`;
  if (s.found.size === 0) return `${head} ${dim("· nothing worth changing came up")}`;
  return `${head} ${dim("·")} ${yellow(`${s.found.size} opportunit${s.found.size === 1 ? "y" : "ies"}, ${usd(found)} avoidable in this run`)}`;
}

export interface StatusLine {
  update(): void;
  /** Step aside while a question is on screen. */
  hold(): void;
  release(): void;
  /** Wrap console.log so ordinary output never collides with the line. */
  attach(): () => void;
  stop(): void;
}

/** A status line that does nothing: --json, piped output, or not a terminal. */
const SILENT: StatusLine = {
  update: () => {},
  hold: () => {},
  release: () => {},
  attach: () => () => {},
  stop: () => {},
};

export function createStatusLine(
  state: StatusState,
  opts: { enabled: boolean; now?: () => number } = { enabled: true },
): StatusLine {
  if (!opts.enabled || !process.stdout.isTTY) return SILENT;
  const now = opts.now ?? Date.now;
  let held = 0;
  let shown = false;
  let lastDraw = 0;
  let drawn = "";
  const write = (t: string) => process.stdout.write(t);
  const clear = () => {
    if (shown) write("\r\x1b[2K");
    shown = false;
  };
  const draw = () => {
    if (held > 0) return;
    const line = renderStatus(state, now(), process.stdout.columns || 120);
    // Some terminal panes are narrower than they report. Skipping unchanged
    // redraws and turning autowrap off while drawing keeps copies from stacking.
    if (shown && line === drawn) return;
    write(`\r\x1b[2K\x1b[?7l${line}\x1b[?7h`);
    shown = true;
    drawn = line;
    lastDraw = now();
  };
  const onResize = () => {
    clear();
    draw();
  };
  process.stdout.on("resize", onResize);
  // Refresh "checked 3s ago" without spamming: every few seconds at most.
  const timer = setInterval(() => {
    if (held === 0) draw();
  }, 5_000);
  timer.unref();

  return {
    update() {
      if (now() - lastDraw >= 250) draw();
    },
    hold() {
      held++;
      clear();
    },
    release() {
      held = Math.max(0, held - 1);
      draw();
    },
    attach() {
      const original = console.log;
      console.log = (...args: unknown[]) => {
        clear();
        original(...args);
        draw();
      };
      draw();
      return () => {
        console.log = original;
      };
    },
    stop() {
      clearInterval(timer);
      process.stdout.off("resize", onResize);
      clear();
    },
  };
}
