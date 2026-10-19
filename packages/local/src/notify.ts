import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * System notifications for `live --notify`, for when it runs in a tab nobody
 * is looking at. macOS through osascript, Linux through notify-send.
 */

// An AppleScript string literal: backslashes and quotes escaped, one line.
const quote = (s: string) =>
  `"${s.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The command that shows one notification here, or null where there is none. */
export function notifyCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] | null {
  if (platform === "darwin") {
    return [
      "osascript",
      ["-e", `display notification ${quote(body)} with title "optimAIzr" subtitle ${quote(title)}`],
    ];
  }
  if (platform === "linux") return ["notify-send", ["--app-name=optimAIzr", title, body]];
  return null;
}

/** Whether a notification can be shown: macOS, or Linux with notify-send on the PATH. */
export function canNotify(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => fs.existsSync(path.join(d, "notify-send")));
}

/** Show one notification. Never waits for it and never throws. */
export function notify(title: string, body: string): void {
  const cmd = notifyCommand(title, body);
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // A notification that can't be shown is not worth stopping live for.
  }
}
