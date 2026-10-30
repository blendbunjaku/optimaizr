import {
  type CacheState,
  createCacheWatch,
  createContextWatch,
  endsTurn,
  type GuardReceipt,
  turnCalls,
  type UsageEvent,
  workMs,
} from "@optimaizr/core";
import {
  type GuardPaths,
  latestClaudeWindows,
  tailReceipts,
  tailTranscripts,
  transcriptCacheState,
} from "@optimaizr/local";
import { folder } from "./format.js";
import { GUARD_SAID } from "./notices.js";
import { inFolders, newestTranscript } from "./shared.js";
import type { LiveConvo, LiveState, Snapshot } from "./types.js";

/** A turn this long is worth a "Claude is done", as in `live --notify`. */
export const DONE_ALERT_MS = 45_000;
/** A conversation older than this is history, not "right now". */
const STALE_MS = 12 * 3_600_000;

interface About {
  key: string;
  sessionId: string;
  title: string;
  project: string;
}

export type LiveNotice =
  | (About & { kind: "expiring"; leftMs: number; rewriteUsd: number })
  | (About & { kind: "cold"; rewriteTokens: number; rewriteUsd: number })
  | (About & { kind: "long"; context: number; rereadUsd: number })
  | (About & { kind: "done"; workMs: number; costUsd: number; percent: number | null })
  | (About & { kind: "guard"; receipt: GuardReceipt });

export interface LiveOptions {
  folders: () => readonly string[];
  onNotice: (n: LiveNotice) => void;
  onChange: () => void;
  /** For tests: where transcripts and guard's log are. */
  roots?: string[];
  guard?: GuardPaths;
  intervalMs?: number;
}

/**
 * The same watches `optimaizr live` runs, over Claude Code's transcripts as
 * they are written: the cache, the context, finished turns and guard's holds.
 */
export function createLiveWatch(opts: LiveOptions) {
  const cache = createCacheWatch();
  const context = createContextWatch();
  const titles = new Map<string, string>();
  const projects = new Map<string, string>();
  const convos = new Map<string, UsageEvent[]>();
  const seen = new Set<string>();
  // Every Claude Code call since the snapshot, for the 5h estimate.
  let spent: Array<{ ts: number; usd: number }> = [];
  let snapshot: Snapshot | null = null;
  let seeded = false;
  let lastTurn: LiveState["lastTurn"] = null;
  const cold = { count: 0, usd: 0 };
  let fallback: { folder: string; state: CacheState } | null = null;
  let windows: { at: number; value: ReturnType<typeof latestClaudeWindows> } | null = null;
  const timers: NodeJS.Timeout[] = [];
  let tail: { stop: () => void } | null = null;

  const titleOf = (id: string, project: string) => titles.get(id) ?? folder(project);
  const about = (key: string, e: UsageEvent): About => ({
    key,
    sessionId: e.sessionId,
    title: titleOf(e.sessionId, e.project),
    project: e.project,
  });

  const fold = (e: UsageEvent, quiet: boolean): void => {
    if (e.source !== "claude-code") return;
    if (seen.has(e.id)) return;
    seen.add(e.id);
    if (seen.size > 20_000) seen.clear();
    if (!snapshot || Date.parse(e.ts) > Date.parse(snapshot.at)) {
      spent.push({ ts: Date.parse(e.ts), usd: e.cost.total });
    }
    if (e.isSubagent) return;
    projects.set(e.sessionId, e.project);
    const list = convos.get(e.sessionId) ?? [];
    list.push(e);
    if (list.length > 400) list.splice(0, list.length - 400);
    convos.set(e.sessionId, list);

    const back = cache.push(e);
    const notices = context.push(e);
    if (quiet) return;
    if (back) {
      cold.count++;
      cold.usd += back.rewriteUsd;
      opts.onNotice({
        kind: "cold",
        ...about(`cold|${e.id}`, e),
        rewriteTokens: back.rewriteTokens,
        rewriteUsd: back.rewriteUsd,
      });
    }
    for (const n of notices) {
      if (n.kind !== "long") continue;
      opts.onNotice({
        kind: "long",
        ...about(`long|${e.sessionId}|${e.contextEpoch ?? 0}`, e),
        context: n.contextTokens,
        rereadUsd: n.rereadUsd,
      });
    }
    if (endsTurn(e)) {
      const turn = turnCalls(list, e);
      const costUsd = turn.reduce((s, x) => s + x.cost.total, 0);
      const ms = workMs(turn);
      const rate = snapshot?.rate?.usdPerPercent ?? null;
      const percent = rate ? costUsd / rate : null;
      if (costUsd >= 0.005) {
        lastTurn = {
          title: titleOf(e.sessionId, e.project),
          workMs: ms,
          costUsd,
          percent,
          at: Date.now(),
        };
      }
      if (ms >= DONE_ALERT_MS) {
        opts.onNotice({ kind: "done", ...about(`done|${e.id}`, e), workMs: ms, costUsd, percent });
      }
    }
    opts.onChange();
  };

  const checkExpiring = (): void => {
    const now = Date.now();
    for (const s of cache.expiring(now)) {
      const e = s.event;
      opts.onNotice({
        kind: "expiring",
        ...about(`expiring|${e.sessionId}|${s.expiresAt}`, e),
        leftMs: (s.expiresAt ?? now) - now,
        rewriteUsd: s.rewriteUsd,
      });
    }
  };

  const receipts = () => tailReceipts(opts.guard);
  let guardLog: ReturnType<typeof tailReceipts> | null = null;
  const checkGuard = (): void => {
    for (const r of guardLog?.poll() ?? []) {
      if (!GUARD_SAID.has(r.kind)) continue;
      const project = projects.get(r.session) ?? "";
      opts.onNotice({
        kind: "guard",
        key: `guard|${r.at}|${r.session}|${r.kind}`,
        sessionId: r.session,
        title: titles.get(r.session) ?? (project ? folder(project) : "Claude Code"),
        project,
        receipt: r,
      });
    }
  };

  /** Before the snapshot: the folder's newest transcript, read from its tail. */
  const readFallback = (): void => {
    for (const f of opts.folders()) {
      const file = newestTranscript(f);
      const state = file ? transcriptCacheState(file) : null;
      if (state) {
        fallback = { folder: f, state };
        return;
      }
    }
    fallback = null;
  };

  const toConvo = (s: CacheState): LiveConvo => ({
    sessionId: s.event.sessionId,
    title: titleOf(s.event.sessionId, s.event.project),
    project: s.event.project,
    model: s.event.model,
    context: s.context,
    expiresAt: s.expiresAt,
    rewriteUsd: s.rewriteUsd,
    readUsd: s.readUsd,
    lastAt: Date.parse(s.event.ts),
  });

  const fiveHour = (now: number): LiveState["fiveHour"] => {
    if (!windows || now - windows.at > 15_000) windows = { at: now, value: latestClaudeWindows() };
    const real = windows.value?.fiveHour;
    if (real) {
      return { percent: real.percentUsed, resetsAt: real.resetsAt ?? null, basis: "claude" };
    }
    const plan = snapshot?.plan;
    const limit = plan?.limitUsd ?? (snapshot?.rate ? snapshot.rate.usdPerPercent * 100 : null);
    const current = plan?.current;
    if (!current || !limit || now >= Date.parse(current.end)) return null;
    const since = spent.reduce((s, x) => s + x.usd, 0);
    return {
      percent: ((current.usd + since) / limit) * 100,
      resetsAt: current.end,
      basis: "estimate",
    };
  };

  return {
    /** Fold in what the snapshot knew, once; later snapshots only refresh titles and rates. */
    seed(s: Snapshot): void {
      snapshot = s;
      for (const [id, t] of Object.entries(s.titles)) if (!titles.has(id)) titles.set(id, t);
      const after = Date.parse(s.at);
      spent = spent.filter((x) => x.ts > after);
      if (!seeded) {
        seeded = true;
        const events = (s.recent as UsageEvent[]).slice().sort((a, b) => a.ts.localeCompare(b.ts));
        for (const e of events) fold(e, true);
        for (const list of convos.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
      }
      opts.onChange();
    },

    start(): void {
      readFallback();
      guardLog = receipts();
      tail = tailTranscripts((e) => fold(e, false), {
        intervalMs: opts.intervalMs ?? 1500,
        ...(opts.roots ? { roots: opts.roots } : {}),
        onTitle: (id, t) => {
          titles.set(id, t);
          opts.onChange();
        },
      });
      timers.push(setInterval(checkExpiring, 15_000));
      timers.push(setInterval(checkGuard, 3_000));
      timers.push(setInterval(() => !seeded && readFallback(), 30_000));
    },

    stop(): void {
      tail?.stop();
      tail = null;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },

    /** Run the checks now instead of on their timers; for tests. */
    tick(): void {
      checkExpiring();
      checkGuard();
    },

    push(e: UsageEvent): void {
      fold(e, false);
    },

    state(now = Date.now()): LiveState {
      const folders = opts.folders();
      let mine: CacheState | null = null;
      for (const [id, project] of projects) {
        if (!inFolders(project, folders)) continue;
        const s = cache.of(id);
        if (s && (!mine || s.event.ts > mine.event.ts)) mine = s;
      }
      if (!mine && fallback && folders.includes(fallback.folder)) mine = fallback.state;
      const convo = mine && now - Date.parse(mine.event.ts) < STALE_MS ? toConvo(mine) : null;
      const warm = cache
        .warm(now)
        .filter((s) => s.event.sessionId !== convo?.sessionId)
        .slice(0, 3)
        .map(toConvo);
      return { now, convo, warm, fiveHour: fiveHour(now), lastTurn, cold: { ...cold } };
    },

    titleOf(id: string): string | undefined {
      return titles.get(id);
    },

    projectOf(id: string): string | undefined {
      return projects.get(id);
    },
  };
}

export type LiveWatch = ReturnType<typeof createLiveWatch>;
