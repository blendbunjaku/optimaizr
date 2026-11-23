import type { CheckKind, ToolCall, UsageEvent } from "../domain/types.js";
import { commandOf, isEdit, isMutating } from "./tasks.js";

/**
 * Pieces of work: a conversation, or the part of one after a long break. /clear
 * already starts a new conversation. Each piece says what it cost and whether
 * its last test, build or typecheck passed, so a change can be judged per
 * finished piece and not only per prompt.
 */

/** Back after this long without a prompt: a new piece. Inferred, nothing records it. */
export const PIECE_GAP_MS = 2 * 3_600_000;

/** Fewer judged pieces than this on a side and the per-piece rows stay out. */
export const MIN_PIECES = 5;

/** Checks that say the work is done. Lint only tidies, so it never decides. */
const DECIDES: ReadonlySet<CheckKind> = new Set(["test", "build", "typecheck"]);

/** Only these keep what a check printed; opencode drops tool output. */
const READS_CHECKS: ReadonlySet<UsageEvent["source"]> = new Set(["claude-code", "codex"]);

/**
 * passed or failed: what its last readable test, build or typecheck said.
 * unknown: checks ran but none said either. unchecked: none ran.
 */
export type PieceOutcome = "passed" | "failed" | "unknown" | "unchecked";

export interface WorkPiece {
  sessionId: string;
  /** 0 for a conversation's first piece, 1 after the first long break, and so on. */
  part: number;
  project: string;
  source: UsageEvent["source"];
  firstTs: string;
  lastTs: string;
  /** Subagents included. */
  costUsd: number;
  prompts: number;
  calls: number;
  /** Edits that went through. */
  edits: number;
  /** Test, build and typecheck runs. */
  checks: number;
  outcome: PieceOutcome;
  /** Fix loops closed in it: a check failed, files changed, the same check passed. */
  fixLoops: number;
  /** What those loops cost, from the call after the failure to the one that passed. */
  fixUsd: number;
}

/** A piece's calls in order, subagents placed by time. */
function splitConversation(list: readonly UsageEvent[]): UsageEvent[][] {
  const sorted = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
  const main = sorted.filter((e) => !e.isSubagent);
  // Where each piece starts: a prompt sent long after the last reply ended.
  const starts: number[] = [];
  let prevTurn: string | undefined;
  let prevEnd = -Infinity;
  for (const e of main) {
    if (e.turnId !== prevTurn) {
      const start = Date.parse(e.turnStartedAt ?? e.ts);
      if (starts.length === 0 || start - prevEnd > PIECE_GAP_MS) starts.push(start);
      prevTurn = e.turnId;
    }
    prevEnd = Math.max(prevEnd, Date.parse(e.endTs ?? e.ts));
  }
  if (starts.length <= 1) return [sorted];

  const pieces: UsageEvent[][] = starts.map(() => []);
  for (const e of sorted) {
    const t = Date.parse(e.turnStartedAt && !e.isSubagent ? e.turnStartedAt : e.ts);
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1]! <= t) k++;
    pieces[k]!.push(e);
  }
  return pieces.filter((p) => p.length > 0);
}

/** Work between a failure and the next run: an edit, or a command that writes. */
function changesFiles(t: ToolCall): boolean {
  if (isEdit(t)) return !t.isError;
  return !t.check && commandOf(t) !== null && isMutating(t);
}

function judge(
  events: readonly UsageEvent[],
): Pick<WorkPiece, "edits" | "checks" | "outcome" | "fixLoops" | "fixUsd"> {
  let edits = 0;
  let checks = 0;
  let last: "passed" | "failed" | null = null;
  // Per kind, where its oldest open failure was and whether files changed since.
  const open = new Map<CheckKind, { at: number; changed: boolean }>();
  const inLoop = new Set<number>();
  let fixLoops = 0;

  events.forEach((e, i) => {
    for (const t of e.tools) {
      if (isEdit(t) && !t.isError) edits++;
      if (changesFiles(t)) for (const o of open.values()) o.changed = true;
      const run = t.check;
      if (!run || !DECIDES.has(run.kind)) continue;
      checks++;
      if (run.outcome === "unknown") continue;
      last = run.outcome === "pass" ? "passed" : "failed";
      const was = open.get(run.kind);
      if (run.outcome === "fail") {
        if (!was) open.set(run.kind, { at: i, changed: false });
      } else if (was) {
        open.delete(run.kind);
        if (was.changed) {
          fixLoops++;
          for (let j = was.at + 1; j <= i; j++) inLoop.add(j);
        }
      }
    }
  });

  const outcome: PieceOutcome = last ?? (checks > 0 ? "unknown" : "unchecked");
  let fixUsd = 0;
  for (const j of inLoop) fixUsd += events[j]!.cost.total;
  return { edits, checks, outcome, fixLoops, fixUsd };
}

/**
 * Pieces of work in these calls, oldest first. Claude Code and Codex only:
 * opencode keeps no tool output, so its checks can't be read.
 */
export function workPieces(events: readonly UsageEvent[]): WorkPiece[] {
  const bySession = new Map<string, UsageEvent[]>();
  for (const e of events) {
    if (!READS_CHECKS.has(e.source)) continue;
    const list = bySession.get(e.sessionId);
    if (list) list.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const out: WorkPiece[] = [];
  for (const [sessionId, list] of bySession) {
    splitConversation(list).forEach((piece, part) => {
      const main = piece.filter((e) => !e.isSubagent);
      if (main.length === 0) return;
      out.push({
        sessionId,
        part,
        project: main[0]!.project,
        source: main[0]!.source,
        firstTs: piece[0]!.ts,
        lastTs: piece.reduce(
          (a, e) => ((e.endTs ?? e.ts) > a ? (e.endTs ?? e.ts) : a),
          piece[0]!.ts,
        ),
        costUsd: piece.reduce((s, e) => s + e.cost.total, 0),
        prompts: new Set(main.flatMap((e) => (e.turnId ? [e.turnId] : []))).size,
        calls: piece.length,
        ...judge(piece),
      });
    });
  }
  return out.sort((a, b) => a.firstTs.localeCompare(b.firstTs));
}

export interface PieceTally {
  pieces: number;
  passed: number;
  failed: number;
  unknown: number;
  unchecked: number;
  costUsd: number;
  /** Median cost of a piece that ended on a pass; null under MIN_PIECES of them. */
  finishedUsd: number | null;
  fixLoops: number;
  fixUsd: number;
}

export function tallyPieces(pieces: readonly WorkPiece[]): PieceTally {
  const count = (o: PieceOutcome) => pieces.filter((p) => p.outcome === o).length;
  const finished = pieces
    .filter((p) => p.outcome === "passed")
    .map((p) => p.costUsd)
    .sort((a, b) => a - b);
  return {
    pieces: pieces.length,
    passed: finished.length,
    failed: count("failed"),
    unknown: count("unknown"),
    unchecked: count("unchecked"),
    costUsd: pieces.reduce((s, p) => s + p.costUsd, 0),
    finishedUsd: finished.length >= MIN_PIECES ? finished[Math.floor(finished.length / 2)]! : null,
    fixLoops: pieces.reduce((s, p) => s + p.fixLoops, 0),
    fixUsd: pieces.reduce((s, p) => s + p.fixUsd, 0),
  };
}

/** Pieces a check judged, passed or failed. */
export const judgedPieces = (t: PieceTally): number => t.passed + t.failed;
