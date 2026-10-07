import {
  blue,
  bold,
  dim,
  green,
  red,
  renderStatusline,
  type StatuslineMeter,
} from "@optimaizr/core";
import {
  applyStatusline,
  latestClaudeTranscript,
  statuslineApplied,
  statuslineCommand,
  transcriptCacheState,
  undoStatusline,
} from "@optimaizr/local";
import type { Args } from "../args.js";

/**
 * `optimaizr statusline`: the line Claude Code runs under its prompt. It gets the
 * session as JSON on stdin and prints one line. It must never fail loudly: on
 * anything unexpected it still prints the name.
 */
export async function cmdStatusline(): Promise<void> {
  if (process.stdin.isTTY) return statuslineOverview();
  let line = "◉ optimAIzr";
  try {
    const input = JSON.parse(await readStdin(1_000)) as StatuslineStdin;
    const state = input.transcript_path ? transcriptCacheState(input.transcript_path) : null;
    line = renderStatusline({
      state,
      contextTokens: input.context_window?.total_input_tokens ?? null,
      fiveHour: meter(input.rate_limits?.five_hour),
      sevenDay: meter(input.rate_limits?.seven_day),
      now: Date.now(),
      color: !process.env.NO_COLOR,
    });
  } catch {
    // The name alone still says it is installed.
  }
  process.stdout.write(`${line}\n`);
}

/** `optimaizr statusline on|off`. */
export function cmdStatuslineSwitch(args: Args): void {
  const what = args.positional[0];
  if (what === "on") return statuslineOn();
  if (what === "off") return statuslineOff();
  console.log("");
  console.log(`  ${red("usage:")} optimaizr statusline on ${dim("|")} off`);
  console.log("");
  process.exitCode = 1;
}

/** Run in a terminal: whether it is on, and what it shows for the latest conversation. */
function statuslineOverview(): void {
  const on = statuslineApplied();
  console.log("");
  console.log(
    `  ${bold("Status line")}  ${on ? green("on") : dim("off")} ${dim("· under Claude Code's prompt, in a terminal")}`,
  );
  const file = latestClaudeTranscript();
  const state = file ? transcriptCacheState(file) : null;
  if (state) {
    console.log("");
    console.log(`  ${dim("For your latest conversation it shows:")}`);
    console.log(`  ${renderStatusline({ state, now: Date.now(), color: !process.env.NO_COLOR })}`);
  }
  console.log("");
  console.log(
    on
      ? `  ${blue("optimaizr statusline off")} ${dim("takes it out")}`
      : `  ${blue("optimaizr statusline on")} ${dim("turns it on")}`,
  );
  console.log("");
}

/** The parts of Claude Code's status line input that are used here. */
interface StatuslineStdin {
  transcript_path?: string;
  context_window?: { total_input_tokens?: number };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

function meter(m: { used_percentage?: number; resets_at?: number } | undefined) {
  if (typeof m?.used_percentage !== "number") return null;
  return { usedPercent: m.used_percentage, resetsAt: m.resets_at ?? null } as StatuslineMeter;
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    // Stop listening either way, so a stdin left open can't keep the process up.
    const done = () => {
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** `optimaizr statusline on`, also reached as `apply statusline`. */
export function statuslineOn(): void {
  const r = applyStatusline(statuslineCommand());
  console.log("");
  const tag = !r.ok ? red("Not applied") : r.changed ? green("Applied") : green("Already on");
  console.log(`  ${tag} ${dim(r.detail)}`);
  if (r.ok) {
    console.log(
      `  ${dim("It shows the context size, what a call pays to re-read it, and how long the cache stays warm.")}`,
    );
    console.log(
      `  ${dim("Claude Code draws it in a terminal. The VS Code chat panel shows no status line;")}`,
    );
    console.log(
      `  ${dim("there, run")} ${blue("optimaizr live")} ${dim("in a terminal tab for the same countdown.")}`,
    );
    console.log(`  ${dim("Turn it off:")} ${blue("optimaizr statusline off")}`);
  } else {
    process.exitCode = 1;
  }
  console.log("");
}

/** `optimaizr statusline off`, also reached as `undo statusline`. */
export function statuslineOff(): void {
  const r = undoStatusline();
  console.log("");
  if (!r) console.log(`  ${dim("optimAIzr has not set a Claude Code status line.")}`);
  else console.log(`  ${r.ok ? green("Reverted") : red("Could not revert")} ${dim(r.detail)}`);
  console.log("");
}
