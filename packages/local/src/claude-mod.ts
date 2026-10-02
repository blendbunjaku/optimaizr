import fs from "node:fs";
import path from "node:path";

import { priceFor, projectName } from "@optimaizr/core";
import type {
  OptimizationFinding,
  ProposedChange,
  RequestRewriter,
  TrafficSlice,
} from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";
import {
  type ModelOverride,
  overridesPath,
  readOverrides,
  sameSlot,
  writeOverrides,
} from "./overrides.js";

/**
 * The optimAIzr mod for Claude Code (mods/optimaizr in the repo). Every session
 * running it keeps a small file under ~/.optimaizr/mod/sessions, so `live` can
 * tell whether accepting a swap reaches a running session. The mod reads its
 * entries in overrides.json before each request.
 */

export interface ModSession {
  id: string;
  version: string;
  cwd: string;
  startedAt: string;
  seenAt: string;
  endedAt?: string;
}

export function modSessionsDir(): string {
  return path.join(optimaizrDir(), "mod", "sessions");
}

// The mod rewrites its file every minute, so three missed beats mean it's gone.
const ALIVE_MS = 3 * 60_000;
// Files of sessions that stopped long ago are removed as they're read.
const KEEP_MS = 7 * 24 * 60 * 60_000;

function isModSession(v: unknown): v is ModSession {
  const s = v as ModSession;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.id === "string" &&
    typeof s.cwd === "string" &&
    typeof s.seenAt === "string" &&
    !Number.isNaN(Date.parse(s.seenAt))
  );
}

/** Every session the mod has reported from, newest first. */
export function readModSessions(dir = modSessionsDir(), now = new Date()): ModSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ModSession[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const s: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isModSession(s)) continue;
      if (now.getTime() - Date.parse(s.seenAt) > KEEP_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      out.push(s);
    } catch {
      // A file mid-write reads as broken; the next beat fixes it.
    }
  }
  return out.sort((a, b) => b.seenAt.localeCompare(a.seenAt));
}

/** Sessions with the mod loaded right now. */
export function activeModSessions(opts: { dir?: string; now?: Date } = {}): ModSession[] {
  const now = opts.now ?? new Date();
  return readModSessions(opts.dir, now).filter(
    (s) => !s.endedAt && now.getTime() - Date.parse(s.seenAt) < ALIVE_MS,
  );
}

const label = (id: string) => priceFor(id)?.label ?? id;

/**
 * The repository a folder belongs to. Claude Code records the folder each call
 * ran in, which can be a subfolder, while the mod matches a session by the
 * root it started in.
 */
export function projectRoot(dir: string): string {
  for (let d = dir; ;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return dir;
    d = up;
  }
}

/** `shop-api subagents: Opus 5.5 -> Sonnet 5.5`. */
export function describeClaudeOverride(o: ModelOverride): string {
  const who = o.subagent === true ? " subagents" : o.subagent === false ? " main" : "";
  const what = o.effort
    ? `${label(o.from)} at ${o.effort} effort`
    : `${label(o.from)} -> ${label(o.to)}`;
  return `${projectName(o.project)}${who}: ${what}`;
}

/**
 * A switch moves every request in its slice, so a finding must cover most of
 * that slice's spend first. Same bar as the global settings change, but per
 * project and per agent, where findings are far more uniform.
 */
const MIN_SLICE_SHARE = 0.8;

export interface ClaudeModRewriterOptions {
  /** Override the overrides file, for tests. */
  file?: string;
  /** Override where the mod's session files are, for tests. */
  sessionsDir?: string;
  minShare?: number;
  now?: () => Date;
}

/**
 * Apply a model swap, or lower reasoning effort, in running Claude Code sessions
 * through the mod, from their next request. Supported only while at least one
 * session has it loaded.
 */
export function claudeModRewriter(opts: ClaudeModRewriterOptions = {}): RequestRewriter {
  const file = opts.file ?? overridesPath();
  const now = opts.now ?? (() => new Date());
  const minShare = opts.minShare ?? MIN_SLICE_SHARE;
  const running = () => activeModSessions({ dir: opts.sessionsDir, now: now() });

  return {
    kind: "optimAIzr mod",

    supports(change: ProposedChange): boolean {
      if (change.kind !== "swap-model" && change.kind !== "lower-effort") return false;
      if (!change.traffic?.slices.some((s) => s.source === "claude-code")) return false;
      return running().length > 0;
    },

    install(change: ProposedChange, finding: OptimizationFinding) {
      const slices = change.traffic?.slices.filter((s) => s.source === "claude-code") ?? [];
      const at = now().toISOString();
      const added: ModelOverride[] = [];
      const narrow: TrafficSlice[] = [];

      // An effort switch keeps the model and asks it to think less.
      const effort = change.kind === "lower-effort" ? (finding.candidate?.to ?? "low") : undefined;

      for (const s of slices) {
        const to = effort ? s.model : (finding.candidate?.targetFor?.(s.model) ?? change.toModelId);
        if (!to || priceFor(to)?.provider !== "anthropic") continue;
        if (!effort && to === s.model) continue;
        if ((s.share ?? 1) < minShare) {
          narrow.push(s);
          continue;
        }
        added.push({
          rule: finding.rule,
          source: "claude-code",
          project: projectRoot(s.project),
          ...(s.subagent !== undefined ? { subagent: s.subagent } : {}),
          from: s.model,
          to,
          ...(effort ? { effort } : {}),
          at,
        });
      }

      if (added.length === 0) {
        const top = Math.max(0, ...narrow.map((s) => s.share ?? 0));
        return {
          ok: false,
          declined: true,
          detail:
            narrow.length > 0
              ? `the flagged calls are only ${Math.round(top * 100)}% of their project's spend ` +
                `on that model, so a switch would move work the rule never called mechanical`
              : effort
                ? "no Claude Code call in this finding runs on an Anthropic model"
                : "no Claude Code call in this finding has an Anthropic model to move to",
        };
      }

      try {
        const kept = readOverrides(file).filter((o) => !added.some((a) => sameSlot(o, a)));
        writeOverrides([...kept, ...added], file);
      } catch (err) {
        return {
          ok: false,
          detail: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const n = running().length;
      return {
        ok: true,
        detail:
          `${added.map(describeClaudeOverride).join(", ")}. ` +
          `${n} Claude Code session${n === 1 ? "" : "s"} running the optimAIzr mod ` +
          `switch${n === 1 ? "es" : ""} from the next request, no restart. ` +
          // Changing the model or the effort means the cached conversation can't be reused.
          "A conversation already under way reads its context once more without the cache. " +
          `Harder task? \`/optimaizr off\` in a session goes back for that session; ` +
          `\`optimaizr undo ${finding.rule}\` reverts it everywhere.`,
      };
    },
  };
}
