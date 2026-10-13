import fs from "node:fs";
import path from "node:path";

import { type AppliedChange, sameLever } from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";
import { type ModelOverride, readOverrides } from "./overrides.js";

/**
 * Every change optimAIzr made or you told it about, one JSON line each, so
 * `optimaizr results` can split your usage at the moment it happened. Nothing
 * is ever rewritten: an undo is a line of its own.
 */

export interface ChangeEntry {
  kind: "apply" | "record" | "undo";
  rule: string;
  source?: AppliedChange["source"];
  project?: string;
  subagent?: boolean;
  from?: string;
  to?: string;
  value?: string;
  at: string;
}

export interface ChangePaths {
  journal?: string;
  /** Compaction settings written before 0.11, which kept no journal. */
  settingsLedger?: string;
  overrides?: string;
}

export function changesPath(): string {
  return path.join(optimaizrDir(), "changes.jsonl");
}

function isEntry(v: unknown): v is ChangeEntry {
  const e = v as ChangeEntry;
  return (
    typeof e === "object" &&
    e !== null &&
    (e.kind === "apply" || e.kind === "record" || e.kind === "undo") &&
    typeof e.rule === "string" &&
    typeof e.at === "string" &&
    Number.isFinite(Date.parse(e.at))
  );
}

export function readChanges(file = changesPath()): ChangeEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line);
      return isEntry(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export function recordChange(entry: ChangeEntry, file = changesPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

/** Compaction settings written before the journal existed, as apply entries. */
function fromSettingsLedger(file: string): ChangeEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
    return changes.flatMap((c: { agent?: unknown; value?: unknown; at?: unknown }) =>
      (c.agent === "claude-code" || c.agent === "codex") && typeof c.at === "string"
        ? [
            {
              kind: "apply" as const,
              rule: "context-compaction",
              source: c.agent,
              value: typeof c.value === "string" ? c.value : undefined,
              at: c.at,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/** A model override as a journal entry. An effort switch keeps the model and records the level. */
export function overrideEntry(o: ModelOverride): ChangeEntry {
  return {
    kind: "apply",
    rule: o.rule,
    source: o.source ?? "sdk",
    project: o.project,
    ...(o.subagent !== undefined ? { subagent: o.subagent } : {}),
    from: o.from,
    ...(o.effort ? { value: o.effort } : { to: o.to }),
    at: o.at,
  };
}

/** Model overrides the mod and `live` write straight to overrides.json. */
function fromOverrides(file: string): ChangeEntry[] {
  return readOverrides(file).map(overrideEntry);
}

const MINUTE = 60_000;

/** The same change seen twice: in the journal and in the file it was written to. */
function sameEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  return (
    a.kind === b.kind &&
    a.rule === b.rule &&
    (a.source ?? null) === (b.source ?? null) &&
    (a.project ?? null) === (b.project ?? null) &&
    (a.to ?? null) === (b.to ?? null) &&
    Math.abs(Date.parse(a.at) - Date.parse(b.at)) < MINUTE
  );
}

/**
 * Every change with its own period: from when it was made until it was undone
 * or replaced by the next change to the same lever.
 */
export function appliedChanges(paths: ChangePaths = {}): AppliedChange[] {
  const journal = readChanges(paths.journal);
  const extra = [
    ...fromSettingsLedger(
      paths.settingsLedger ?? path.join(optimaizrDir(), "settings-changes.json"),
    ),
    ...fromOverrides(paths.overrides ?? path.join(optimaizrDir(), "overrides.json")),
  ].filter((e) => !journal.some((j) => sameEntry(j, e)));
  return changesFrom([...journal, ...extra]);
}

export function changesFrom(entries: readonly ChangeEntry[]): AppliedChange[] {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const out: AppliedChange[] = [];
  const open: AppliedChange[] = [];
  const close = (match: (c: AppliedChange) => boolean, at: string) => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (!match(open[i]!)) continue;
      open[i]!.until = at;
      open.splice(i, 1);
    }
  };
  for (const e of sorted) {
    if (e.kind === "undo") {
      close(
        (c) =>
          c.rule === e.rule &&
          (!e.source || c.source === e.source) &&
          (!e.project || c.project === e.project),
        e.at,
      );
      continue;
    }
    const change: AppliedChange = {
      id: `${e.rule}:${e.source ?? "all"}:${e.at}`,
      rule: e.rule,
      ...(e.source ? { source: e.source } : {}),
      ...(e.project ? { project: e.project } : {}),
      ...(e.subagent !== undefined ? { subagent: e.subagent } : {}),
      ...(e.from ? { from: e.from } : {}),
      ...(e.to ? { to: e.to } : {}),
      ...(e.value ? { value: e.value } : {}),
      how: e.kind === "record" ? "by-hand" : "optimaizr",
      at: e.at,
    };
    // Applying the same value again changes nothing, so it isn't a new period.
    const same = open.find((c) => sameLever(c, change));
    if (same && same.value === change.value && same.to === change.to) continue;
    close((c) => sameLever(c, change), e.at);
    open.push(change);
    out.push(change);
  }
  return out;
}

/**
 * Undoing removes the record of what was applied, so that goes into the
 * journal first, then the undo itself.
 */
export function recordUndo(
  rule: string,
  undone: readonly ChangeEntry[],
  opts: { journal?: string; now?: Date } = {},
): void {
  const file = opts.journal ?? changesPath();
  const journal = readChanges(file);
  for (const e of undone) if (!journal.some((j) => sameEntry(j, e))) recordChange(e, file);
  const at = (opts.now ?? new Date()).toISOString();
  for (const source of new Set(undone.map((e) => e.source))) {
    recordChange({ kind: "undo", rule, ...(source ? { source } : {}), at }, file);
  }
}

/** Changes still in place for a rule, newest first, for `undo` to journal. */
export function openChanges(rule: string, paths: ChangePaths = {}): AppliedChange[] {
  return appliedChanges(paths)
    .filter((c) => c.rule === rule && !c.until)
    .sort((a, b) => b.at.localeCompare(a.at));
}
