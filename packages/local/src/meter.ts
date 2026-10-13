import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeterReading, WindowRate } from "@optimaizr/core";
import { optimaizrDir } from "./ledger.js";

/**
 * Claude's five-hour meter over time, so what 1% of it costs can be learned.
 * Two sources: the history Claude Desktop keeps, and the readings the status
 * line logs while Claude Code runs in a terminal.
 */

export function meterLogPath(): string {
  return path.join(optimaizrDir(), "meter.jsonl");
}

/** The learned rate, for the mod: it can't read the history itself. */
export function windowRatePath(): string {
  return path.join(optimaizrDir(), "window-rate.json");
}

export function desktopHistoryPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "plan-usage-history.json");
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.join(config, "Claude", "plan-usage-history.json");
}

interface DesktopSample {
  t: number;
  org?: string;
  u: { fh: number };
}

const isSample = (s: unknown): s is DesktopSample => {
  const x = s as { t?: unknown; u?: { fh?: unknown } } | null;
  return typeof x?.t === "number" && typeof x?.u?.fh === "number";
};

/** Claude Desktop's readings for the account it used last; it keeps every account it has seen. */
export function readDesktopMeter(file = desktopHistoryPath()): MeterReading[] {
  try {
    const samples: unknown = JSON.parse(fs.readFileSync(file, "utf8"))?.samples;
    if (!Array.isArray(samples)) return [];
    const ok = samples.filter(isSample);
    const latest = ok.reduce<DesktopSample | null>((a, s) => (!a || s.t > a.t ? s : a), null);
    return ok.filter((s) => s.org === latest?.org).map((s) => ({ t: s.t, percent: s.u.fh }));
  } catch {
    return [];
  }
}

export function readMeterLog(file = meterLogPath()): MeterReading[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const r = JSON.parse(line);
          return typeof r?.t === "number" && typeof r?.fh === "number"
            ? [{ t: r.t, percent: r.fh }]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Both sources, oldest first. */
export function readMeter(): MeterReading[] {
  return [...readDesktopMeter(), ...readMeterLog()].sort((a, b) => a.t - b.t);
}

/**
 * Log a status line reading, only when the meter moved: Claude Code runs the
 * status line many times a minute. Reads just the end of the log to compare.
 */
export function recordMeter(percent: number, now = Date.now(), file = meterLogPath()): boolean {
  if (!Number.isFinite(percent)) return false;
  let last: number | null = null;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const tail = buf.toString("utf8").trim().split("\n").at(-1) ?? "";
      const fh = JSON.parse(tail)?.fh;
      if (typeof fh === "number") last = fh;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No log yet, or a torn last line: write this reading.
  }
  if (last === percent) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ t: now, fh: percent })}\n`);
  return true;
}

/**
 * What turns dollars into a share of the 5h window: learned from the meter
 * (`windows` says from how many), or the plan's estimated limit over 100.
 */
export type ShareRate =
  ({ basis: "meter" } & WindowRate) | { basis: "plan"; usdPerPercent: number };

export function writeWindowRate(rate: ShareRate, file = windowRatePath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...rate, at: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // The mod then leaves the share out.
  }
}

export function readWindowRate(file = windowRatePath()): (ShareRate & { at: string }) | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof r?.usdPerPercent === "number" && r.usdPerPercent > 0 ? r : null;
  } catch {
    return null;
  }
}
