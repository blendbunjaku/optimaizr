import fs from "node:fs";
import path from "node:path";

import { priceFor, providerOf } from "@optimaizr/core";
import type { OptimizationFinding, ProposedChange, RequestRewriter } from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";

/**
 * Model overrides applied before a request is sent, so accepting a live
 * recommendation reaches a running app (`wrap()`) or Claude Code session (the
 * optimAIzr mod) with no restart. Each entry is as narrow as its finding: one
 * service or project, one route (or none), one source model.
 */

export interface ModelOverride {
  /** The finding that produced it, so `optimaizr undo <rule>` can find it. */
  rule: string;
  /** Who applies it: absent for `wrap()`, `claude-code` for the optimAIzr mod. */
  source?: "claude-code";
  /** `service` as the app passed it to `wrap()`, or Claude Code's working directory. */
  project: string;
  /** Exact route; absent means calls made without one. */
  route?: string;
  /** Claude Code only: subagents (true), the main conversation (false), or both (absent). */
  subagent?: boolean;
  from: string;
  to: string;
  /** Claude Code only: an effort switch, the same model asked to think less. */
  effort?: string;
  /** Applied by `live --auto`, with no one pressing Y. */
  auto?: boolean;
  /** ISO 8601, when it was accepted. */
  at: string;
}

interface OverrideFile {
  version: 1;
  overrides: ModelOverride[];
}

export function overridesPath(): string {
  return path.join(optimaizrDir(), "overrides.json");
}

export function readOverrides(file = overridesPath()): ModelOverride[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OverrideFile>;
    return Array.isArray(parsed.overrides) ? parsed.overrides.filter(isOverride) : [];
  } catch {
    return [];
  }
}

function isOverride(o: unknown): o is ModelOverride {
  const v = o as ModelOverride;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.rule === "string" &&
    typeof v.project === "string" &&
    typeof v.from === "string" &&
    typeof v.to === "string" &&
    (v.route === undefined || typeof v.route === "string") &&
    (v.source === undefined || v.source === "claude-code") &&
    (v.subagent === undefined || typeof v.subagent === "boolean") &&
    (v.effort === undefined || typeof v.effort === "string") &&
    (v.auto === undefined || typeof v.auto === "boolean")
  );
}

/**
 * Replace the file in one step. A wrapped app reads it on a hot path, and a
 * reader that caught a half-written file would see no overrides at all.
 */
export function writeOverrides(overrides: ModelOverride[], file = overridesPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: OverrideFile = { version: 1, overrides };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Remove every override a rule installed. Returns what was removed. */
export function removeOverrides(rule: string, file = overridesPath()): ModelOverride[] {
  const all = readOverrides(file);
  const kept = all.filter((o) => o.rule !== rule);
  if (kept.length < all.length) writeOverrides(kept, file);
  return all.filter((o) => o.rule === rule);
}

export const sameSlot = (a: ModelOverride, b: Omit<ModelOverride, "rule" | "to" | "at">) =>
  (a.source ?? null) === (b.source ?? null) &&
  a.project === b.project &&
  (a.route ?? null) === (b.route ?? null) &&
  (a.subagent ?? null) === (b.subagent ?? null) &&
  Boolean(a.effort) === Boolean(b.effort) &&
  a.from === b.from;

/** The override for one outbound `wrap()` request, if there is one. */
export function overrideFor(
  overrides: readonly ModelOverride[],
  call: { project: string; route?: string | undefined; model: string },
): ModelOverride | undefined {
  return overrides.find((o) => sameSlot(o, { ...call, from: call.model }));
}

const label = (id: string) => priceFor(id)?.label ?? id;

export interface SdkOverrideRewriterOptions {
  /** Override the file, for tests. */
  file?: string;
  now?: () => Date;
}

/**
 * Apply a model swap to apps using `wrap()` from their next request. SDK
 * traffic only: Claude Code's entries are written by `claudeModRewriter`.
 */
export function sdkOverrideRewriter(opts: SdkOverrideRewriterOptions = {}): RequestRewriter {
  const file = opts.file ?? overridesPath();
  const now = opts.now ?? (() => new Date());

  return {
    kind: "sdk wrapper",

    supports(change: ProposedChange, finding: OptimizationFinding): boolean {
      if (change.kind !== "swap-model") return false;
      if (!change.toModelId && !finding.candidate?.targetFor) return false;
      return Boolean(change.traffic?.slices.some((s) => s.source === "sdk"));
    },

    install(change: ProposedChange, finding: OptimizationFinding) {
      const slices = change.traffic?.slices.filter((s) => s.source === "sdk") ?? [];
      const at = now().toISOString();
      const added: ModelOverride[] = [];

      for (const s of slices) {
        // A finding can span providers: each model moves only to a target its
        // own client can call.
        const to = finding.candidate?.targetFor?.(s.model) ?? change.toModelId;
        if (!to || to === s.model) continue;
        if (providerOf(to) !== providerOf(s.model)) continue;
        added.push({
          rule: finding.rule,
          project: s.project,
          ...(s.route !== undefined ? { route: s.route } : {}),
          from: s.model,
          to,
          at,
        });
      }

      if (added.length === 0) {
        return {
          ok: false,
          declined: true,
          detail: "no SDK call in this finding has a same-provider model to move to",
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

      const where = added
        .map(
          (o) => `${o.project}${o.route ? `/${o.route}` : ""}: ${label(o.from)} -> ${label(o.to)}`,
        )
        .join(", ");
      return {
        ok: true,
        detail:
          `${where}. Wrapped clients pick this up on their next request, no restart. ` +
          `\`optimaizr undo ${finding.rule}\` reverts it.`,
      };
    },
  };
}
