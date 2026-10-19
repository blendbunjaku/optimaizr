import {
  blue,
  contextOf,
  convoColor,
  convoName,
  COUNTDOWN_MS,
  dim,
  endsTurn,
  green,
  minutesLabel,
  modelLabel,
  NAME_WIDTH,
  tokens as fmtTokens,
  usd,
  workLabel,
  yellow,
} from "@optimaizr/core";
import type { CacheWatch, UsageEvent } from "@optimaizr/core";

/**
 * The block at the bottom of `optimaizr live`: a row for each open
 * conversation (working or idle, and how long its cache stays warm), then one
 * line with what this run has seen and spent. Redrawn in place, never
 * scrolled, and only on an interactive terminal; while a question is on
 * screen it steps aside.
 */

/** A conversation keeps its row this long after its last call: the longest cache. */
const OPEN_MS = 60 * 60_000;
/** A turn with no new call for this long was most likely stopped. */
const STALE_MS = 10 * 60_000;
/** Where the log doesn't say when a turn ends (Codex), a call this recent counts as working. */
const RECENT_MS = 30_000;
const MAX_ROWS = 4;
/** How often the block is redrawn, so both spinners move. Slow on purpose. */
const TICK_MS = 300;
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** A square of dots with a gap going round it, after "watching". */
const ROUND = "⣾⣽⣻⢿⡿⣟⣯⣷";
const AGENT: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "opencode",
};

/** One conversation as live sees it now. */
export interface ConvoNow {
  source: string;
  project: string;
  /** When its last call finished. */
  lastAt: number;
  /** Whether its last reply ended the turn; null where the log doesn't say. */
  ended: boolean | null;
  turnId?: string;
  turnStart: number;
  turnUsd: number;
  /** What it spent during this run. */
  runUsd: number;
  context: number;
  /** The model and effort of its latest main call, not a subagent's. */
  model?: string;
  effort?: string | null;
}

export interface StatusState {
  startedAt: number;
  calls: number;
  spendUsd: number;
  /** Agent conversations seen this run, by session id. */
  convos: Map<string, ConvoNow>;
  /** A conversation's title, once its agent has named it. */
  titleOf?: (sessionId: string) => string | undefined;
  last?: { model: string; costUsd: number; context: number; at: number };
  /** Findings shown this run, by rule, with what each could have saved. It is paid. */
  found: Map<string, number>;
  /** The same findings, by what each goes on costing per call until it changes. */
  perCall: Map<string, number>;
  /** Long conversations and how long their cache stays warm. */
  cache?: CacheWatch;
  /** Calls this run that came back to an expired cache, and what they paid. */
  cold: { count: number; usd: number };
  /** True when `?` and `n` answer, so the line can say so. */
  keys?: boolean;
  /** What this run reads, as the header names it. */
  watched?: string[];
}

const DEFAULT_WATCHED = ["Claude Code", "Codex", "opencode", "API calls"];

/** "Claude Code, Codex and opencode". */
export function andList(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The population rules need this many calls before "no waste found" means anything. */
export const QUORUM = 50;

export function emptyStatus(now = Date.now()): StatusState {
  return {
    startedAt: now,
    calls: 0,
    spendUsd: 0,
    convos: new Map(),
    found: new Map(),
    perCall: new Map(),
    cold: { count: 0, usd: 0 },
  };
}

const sum = (m: Map<string, number>) => [...m.values()].reduce((t, v) => t + v, 0);

/** "$1.80 already paid, ~$0.043 a call still avoidable": what is spent, and what is not yet. */
function paidAndAvoidable(s: StatusState): string {
  const each = sum(s.perCall);
  const rest = each > 0 ? `, ~${usd(each)} a call still avoidable` : "";
  return `${usd(sum(s.found))} already paid${rest}`;
}

const timeOf = (ts: string | undefined, fallback: number) => {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

/** Fold one call into the state. */
export function recordCall(s: StatusState, e: UsageEvent, now = Date.now()): void {
  s.calls++;
  s.spendUsd += e.cost.total;
  s.last = { model: e.model, costUsd: e.cost.total, context: contextOf(e), at: now };
  if (e.source !== "claude-code" && e.source !== "codex" && e.source !== "opencode") return;

  const at = timeOf(e.endTs ?? e.ts, now);
  let c = s.convos.get(e.sessionId);
  if (!c) {
    c = {
      source: e.source,
      project: e.project,
      lastAt: at,
      ended: true,
      turnStart: at,
      turnUsd: 0,
      runUsd: 0,
      context: 0,
    };
    s.convos.set(e.sessionId, c);
  }
  // A reply that ended its turn, or a new prompt, starts the next turn.
  const newPrompt = !e.isSubagent && e.turnId !== undefined && e.turnId !== c.turnId;
  if (c.ended === true || newPrompt) {
    c.turnStart = timeOf(e.turnStartedAt ?? e.ts, at);
    c.turnUsd = 0;
  }
  c.turnUsd += e.cost.total;
  c.runUsd += e.cost.total;
  c.lastAt = Math.max(c.lastAt, at);
  if (e.isSubagent) {
    c.ended = false;
    return;
  }
  c.turnId = e.turnId;
  c.context = contextOf(e);
  c.model = e.model;
  c.effort = e.effort ?? null;
  c.ended = e.stopReason ? endsTurn(e) : null;
}

function working(c: ConvoNow, now: number): boolean {
  const idle = now - c.lastAt;
  return c.ended === null ? idle < RECENT_MS : !c.ended && idle < STALE_MS;
}

/** 12s, 5m, 1h 05m. */
function since(ms: number): string {
  return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : minutesLabel(ms);
}

const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 3)}...` : t);

export function nameOf(s: StatusState, id: string, c: ConvoNow): string {
  return convoName(id, c.project, s.titleOf?.(id));
}

/** "Opus 5.5 xhigh": what the conversation runs on, so a forgotten effort shows. */
export function choiceOf(c: ConvoNow): string {
  if (!c.model) return "";
  const effort = c.effort && /^[a-z]{1,8}$/i.test(c.effort) ? ` ${c.effort}` : "";
  return `${cut(modelLabel(c.model), 20)}${effort}`;
}

/** One conversation: a spinner while its agent works, its cache once it waits. */
function row(s: StatusState, id: string, c: ConvoNow, now: number, withModel = true): string {
  const color = convoColor(id);
  const name = color(cut(nameOf(s, id, c), NAME_WIDTH).padEnd(NAME_WIDTH));
  const choice = withModel ? choiceOf(c) : "";
  if (working(c, now)) {
    const frame = SPIN[Math.floor(now / TICK_MS) % SPIN.length]!;
    const parts = [
      `${AGENT[c.source] ?? "agent"} working`,
      workLabel(now - c.turnStart),
      `${usd(c.turnUsd)} so far`,
    ];
    if (c.context > 0) parts.push(dim(fmtTokens(c.context)));
    if (choice) parts.push(dim(choice));
    return `  ${color(frame)} ${name}  ${parts.join(dim(" · "))}`;
  }
  const parts = [dim(`idle ${since(now - c.lastAt)}`)];
  if (c.context > 0) parts.push(dim(fmtTokens(c.context)));
  const cache = s.cache?.of(id);
  if (cache && cache.expiresAt !== null) {
    const left = cache.expiresAt - now;
    const text = left <= 0 ? "cache expired" : `cache warm ${minutesLabel(left)} more`;
    parts.push(left > 0 && left <= COUNTDOWN_MS ? yellow(text) : dim(text));
  }
  if (choice) parts.push(dim(choice));
  return `  ${dim("○")} ${name}  ${parts.join(dim(" · "))}`;
}

/** The rows above the line: each conversation with a call in the last hour, working ones first. */
export function renderNow(s: StatusState, now = Date.now(), width = 120): string[] {
  const open = [...s.convos.entries()]
    .filter(([, c]) => working(c, now) || now - c.lastAt < OPEN_MS)
    .sort(
      ([, a], [, b]) => Number(working(b, now)) - Number(working(a, now)) || b.lastAt - a.lastAt,
    );
  if (open.length === 0) return [];
  // The model goes first on a narrow terminal, before anything is cut.
  const fit = (id: string, c: ConvoNow) => {
    const full = row(s, id, c, now);
    return clip(plain(full).length <= width - 2 ? full : row(s, id, c, now, false), width - 2);
  };
  const rows = open.slice(0, MAX_ROWS).map(([id, c]) => fit(id, c));
  if (open.length > MAX_ROWS) rows.push(dim(`    and ${open.length - MAX_ROWS} more open`));
  const line = "─".repeat(Math.max(0, Math.min(width - 12, 64)));
  return [dim(`  ── now ${line}`), ...rows];
}

/** The conversation that cost this run the most, when there are two or more. */
export function mostSpent(s: StatusState): { id: string; convo: ConvoNow } | null {
  const spent = [...s.convos.entries()].filter(([, c]) => c.runUsd > 0);
  if (spent.length < 2) return null;
  const [id, convo] = spent.reduce((a, b) => (b[1].runUsd > a[1].runUsd ? b : a));
  return { id, convo };
}

/** The line itself, without colour codes counted against the width. */
export function renderStatus(s: StatusState, now = Date.now(), width = 120): string {
  // A turning square, so it reads as watching even when nothing comes in.
  const round = ` ${ROUND[Math.floor(now / TICK_MS) % ROUND.length]!}`;
  // Each part with how much it matters: on a narrow terminal the least goes first.
  const parts: Array<{ text: string; keep: number }> = [
    { text: `  ${blue("◉")} optimAIzr live`, keep: 9 },
  ];
  if (s.calls === 0) {
    parts.push({
      text: dim(`watching for ${andList(s.watched ?? DEFAULT_WATCHED)}${round}`),
      keep: 8,
    });
  } else {
    parts.push({
      text: dim(`${usd(s.spendUsd)} this run · ${s.calls} call${s.calls === 1 ? "" : "s"}`),
      keep: 6,
    });
    // With no conversation rows above, the last call stands in for them.
    if (s.last && s.convos.size === 0) {
      parts.push({
        text: dim(
          `last ${modelLabel(s.last.model)} ${usd(s.last.costUsd)}, ${fmtTokens(s.last.context)} context`,
        ),
        keep: 5,
      });
    }
    const most = mostSpent(s);
    if (most) {
      parts.push({
        text: dim(`most: ${cut(nameOf(s, most.id, most.convo), 28)} ${usd(most.convo.runUsd)}`),
        keep: 4,
      });
    }
    const verdict =
      s.found.size > 0
        ? yellow(`${s.found.size} found: ${paidAndAvoidable(s)}`)
        : s.calls < QUORUM
          ? green("nothing found yet")
          : green("no waste found");
    const hint = s.keys ? dim(s.found.size > 0 ? " (n next step)" : " (? why)") : "";
    parts.push({ text: verdict + hint, keep: 8 });
    parts.push({ text: dim(`watching${round}`), keep: 7 });
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
  const head = `  ${green("✓")} optimAIzr live ${dim(`· ${mins} min · ${s.calls} call${s.calls === 1 ? "" : "s"} · ${usd(s.spendUsd)} spent`)}`;
  if (s.found.size === 0 && s.calls > 0) return head;
  if (s.found.size === 0) return `${head} ${dim("· nothing worth changing came up")}`;
  return `${head} ${dim("·")} ${yellow(`${s.found.size} opportunit${s.found.size === 1 ? "y" : "ies"}: ${paidAndAvoidable(s)}`)}`;
}

export interface StatusLine {
  update(): void;
  /** Step aside while a question is on screen. */
  hold(): void;
  release(): void;
  /** Wrap console.log so ordinary output never collides with the block. */
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
  // How many lines the block takes on screen now; the cursor sits on the last.
  let lines = 0;
  let lastDraw = 0;
  let drawn = "";
  const write = (t: string) => process.stdout.write(t);
  // Up to the block's first line, then erase from there to the bottom.
  const erase = () => {
    const seq = lines > 0 ? `\r${lines > 1 ? `\x1b[${lines - 1}A` : ""}\x1b[J` : "";
    lines = 0;
    return seq;
  };
  const clear = () => write(erase());
  const draw = () => {
    if (held > 0) return;
    const width = process.stdout.columns || 120;
    const block = [...renderNow(state, now(), width), renderStatus(state, now(), width)];
    const text = block.join("\n");
    // Some terminal panes are narrower than they report. Skipping unchanged
    // redraws and turning autowrap off while drawing keeps copies from stacking.
    if (lines > 0 && text === drawn) return;
    // Erase and draw in one write, so the block never shows half cleared.
    write(`${erase()}\x1b[?7l${text}\x1b[?7h`);
    lines = block.length;
    drawn = text;
    lastDraw = now();
  };
  const onResize = () => {
    clear();
    draw();
  };
  process.stdout.on("resize", onResize);
  const timer = setInterval(() => {
    if (held === 0) draw();
  }, TICK_MS);
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
