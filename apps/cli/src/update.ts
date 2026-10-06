import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { blue, bold, dim, yellow } from "@optimaizr/core";
import { optimaizrDir } from "@optimaizr/local";
import { VERSION } from "./version.js";

/**
 * Update awareness. At most once a day a detached process asks the npm registry
 * for the latest version number; nothing about you or your usage is sent, and a
 * command never waits for it. The answer is shown, once a day, on a later run.
 */

const DAY = 86_400_000;
const REGISTRY = "https://registry.npmjs.org/optimaizr/latest";

export interface UpdateState {
  checkedAt?: string;
  latest?: string;
  /** The last version that ran here, so an upgrade can say what's new once. */
  seenVersion?: string;
  noticedAt?: string;
}

/** A few lines on what a version changed, shown once after upgrading to it. */
const WHATS_NEW: Record<string, string[]> = {
  "0.9.0": [
    "Your Claude plan is detected, no --plan needed.",
    "Savings in exact dollars, split by how sure they are, plus the levers worth testing.",
    "live shows its work: a status line, context warnings, and Y to compact earlier.",
    "Detection is stricter, so figures are lower than 0.8 and hold up when checked.",
  ],
};

export function updatePath(): string {
  return path.join(optimaizrDir(), "update.json");
}

export function readUpdateState(file = updatePath()): UpdateState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeUpdateState(file: string, state: UpdateState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  } catch {
    /* an unwritable home must not break a command */
  }
}

/** True when `a` is a later release than `b` (x.y.z, pre-release tags ignored). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** Off in CI, for --json, when output isn't a terminal, or when switched off. */
export function updatesEnabled(opts: {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  json: boolean;
  configured?: boolean;
}): boolean {
  const off = opts.env.OPTIMAIZR_NO_UPDATE_CHECK;
  if (off && off !== "0" && off.toLowerCase() !== "false") return false;
  if (opts.env.CI) return false;
  return opts.isTTY && !opts.json && opts.configured !== false;
}

/**
 * What to print after a command: what's new after an upgrade, then a newer
 * release. `usedBefore` covers upgrades from versions that kept no record.
 */
export function updateLines(
  state: UpdateState,
  now: number,
  opts: { version?: string; usedBefore?: boolean } = {},
): string[] {
  const version = opts.version ?? VERSION;
  const out: string[] = [];
  const seen = state.seenVersion ?? (opts.usedBefore ? "0.0.0" : undefined);
  if (seen && seen !== version && newer(version, seen)) {
    const notes = WHATS_NEW[version];
    out.push(`  ${yellow("✨")} ${bold(`optimAIzr ${version}`)} ${dim("· what's new")}`);
    for (const line of notes ?? [`Updated from ${seen}.`]) {
      out.push(`     ${dim(line)}`);
    }
    out.push(`     ${dim("Everything that changed:")} ${blue("optimaizr changelog")}`);
  }
  const due = !state.noticedAt || now - Date.parse(state.noticedAt) > DAY;
  if (state.latest && newer(state.latest, version) && due) {
    if (out.length) out.push("");
    out.push(
      `  ${yellow("✨")} ${bold(`optimAIzr ${state.latest} is available`)} ${dim(`· you have ${version}`)}`,
    );
    out.push(
      `     ${blue("npm i -g optimaizr@latest")} ${dim("· what's in it: optimaizr changelog")}`,
    );
  }
  return out;
}

/**
 * After a command: print any notice, remember what was shown, and start a
 * background check when the last one is over a day old.
 */
export function afterCommand(cliPath: string, file = updatePath(), now = Date.now()): void {
  const state = readUpdateState(file);
  const usedBefore = !fs.existsSync(file) && fs.existsSync(path.dirname(file));
  const lines = updateLines(state, now, { usedBefore });
  if (lines.length) {
    console.log("");
    for (const line of lines) console.log(line);
    console.log("");
  }
  const next: UpdateState = { ...state, seenVersion: VERSION };
  if (state.latest && newer(state.latest, VERSION) && lines.some((l) => l.includes("available"))) {
    next.noticedAt = new Date(now).toISOString();
  }
  writeUpdateState(file, next);

  const stale = !state.checkedAt || now - Date.parse(state.checkedAt) > DAY;
  if (!stale) return;
  try {
    const child = spawn(process.execPath, [cliPath, "__update-check"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    /* no background check this time */
  }
}

/** The background half: one request for one version number, with a short timeout. */
export async function runUpdateCheck(file = updatePath()): Promise<void> {
  const state = readUpdateState(file);
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { version?: unknown };
    const latest = typeof body.version === "string" ? body.version : undefined;
    writeUpdateState(file, {
      ...readUpdateState(file),
      latest,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    // Offline or blocked: try again tomorrow rather than on every command.
    writeUpdateState(file, { ...state, checkedAt: new Date().toISOString() });
  }
}
