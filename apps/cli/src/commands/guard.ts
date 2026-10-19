import { spawn } from "node:child_process";
import {
  BIG_READ_BYTES,
  blue,
  bold,
  dim,
  green,
  guardSaved,
  HOLD_MIN_USD,
  red,
  savedText,
  weekCompare,
  weekText,
} from "@optimaizr/core";
import {
  applyGuard,
  compactionStatus,
  guardApplied,
  guardHook,
  type HookInput,
  ownCommand,
  readReceipts,
  saveWeekLine,
  undoGuard,
} from "@optimaizr/local";
import type { Args } from "../args.js";
import { load } from "../data.js";
import { readStdin } from "./statusline.js";

/**
 * `optimaizr guard`: Claude Code hooks that hold a costly step once, before it
 * is paid. Alone it says whether it is on and what it held this week.
 */
export function cmdGuard(args: Args): void | Promise<void> {
  const what = args.positional[0];
  if (what === "on") return guardOn();
  if (what === "off") return guardOff();
  if (what === undefined || what === "status") return guardStatus();
  if (what === "week") return guardWeek(args);
  console.log("");
  console.log(
    `  ${red("usage:")} optimaizr guard ${dim("[")}on ${dim("|")} off ${dim("|")} week${dim("]")}`,
  );
  console.log("");
  process.exitCode = 1;
}

/** `optimaizr guard hook`: what Claude Code runs. JSON in, JSON out, never a failure. */
export async function cmdGuardHook(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin(2_000)) as HookInput;
    const set = input.hook_event_name === "Stop" ? compactionStatus()["claude-code"] : null;
    const out = guardHook(input, {
      compactAt: set && Number(set) > 0 ? Number(set) : null,
      weekRun: () => {
        const cmd = ownCommand("guard week");
        if (cmd) spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref();
      },
    });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // Say nothing and Claude Code goes on as if guard were off.
  }
}

/**
 * `optimaizr guard week`: the last 7 days against the 7 before, saved for the
 * first conversation of the week. The Stop hook runs it in the background.
 */
async function guardWeek(args: Args): Promise<void> {
  const data = await load({ ...args, flags: { ...args.flags, days: "14", source: "agents" } });
  const w = weekCompare(data.events);
  if (!w) return;
  const text = weekText(w);
  saveWeekLine(text);
  if (process.stdout.isTTY) console.log(`\n  ${dim("Last 7 days:")} ${text}\n`);
}

/** `optimaizr guard on`, also reached as `apply guard`. */
export function guardOn(): void {
  const r = applyGuard(ownCommand("guard hook"));
  console.log("");
  const tag = !r.ok ? red("Not applied") : r.changed ? green("Applied") : green("Already on");
  console.log(`  ${tag} ${dim(r.detail)}`);
  if (r.ok) {
    console.log(
      `  ${dim("It holds a message to an expired cache, a whole big file read and a retry of a")}`,
    );
    console.log(
      `  ${dim("failing command, once each; sent again, each goes through. New conversations pick it up.")}`,
    );
    console.log(
      `  ${dim("What it did:")} ${blue("optimaizr guard")}  ${dim("Turn it off:")} ${blue("optimaizr guard off")}`,
    );
  } else {
    process.exitCode = 1;
  }
  console.log("");
}

/** `optimaizr guard off`, also reached as `undo guard`. */
export function guardOff(): void {
  const r = undoGuard();
  console.log("");
  if (!r) console.log(`  ${dim("optimAIzr has not set guard's hooks in Claude Code.")}`);
  else console.log(`  ${r.ok ? green("Reverted") : red("Could not revert")} ${dim(r.detail)}`);
  console.log("");
}

const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function guardStatus(): void {
  const on = guardApplied();
  console.log("");
  console.log(
    `  ${bold("Guard")}  ${on ? green("on") : dim("off")} ${dim("· Claude Code hooks, in a terminal or VS Code")}`,
  );
  console.log("");
  console.log(`  ${dim("It holds each of these once, and lets it through when it comes again:")}`);
  const row = (name: string, what: string) => console.log(`    ${name.padEnd(12)} ${dim(what)}`);
  row(
    "Cold cache",
    `a message to a conversation idle past its cache, when the rewrite is ${money(HOLD_MIN_USD)} or more`,
  );
  row(
    "Big reads",
    `a whole file over ${BIG_READ_BYTES / 1024}KB, so Claude reads the part it needs`,
  );
  row("Retries", "a command that failed twice in a row with nothing changed since");
  console.log(`  ${dim("And says once per conversation:")}`);
  row("Compact", "near the compaction point, at the end of a turn: a good moment to /compact");

  const week = readReceipts(Date.now() - 7 * 86_400_000);
  const count = (k: string) => week.filter((r) => r.kind === k).length;
  const held = week.filter((r) => r.kind === "cold-hold");
  const atStake = held.reduce((t, r) => t + (r.usd ?? 0), 0);
  console.log("");
  if (week.length === 0) {
    console.log(`  ${dim("Last 7 days")}  ${dim(on ? "nothing held yet" : "nothing held")}`);
  } else {
    const fresh = count("handoff-used");
    const sent = count("cold-sent");
    const outcome = [
      fresh ? `${fresh} started fresh from the note` : "",
      sent ? `${sent} sent anyway` : "",
    ].filter(Boolean);
    console.log(
      `  ${dim("Last 7 days")}  ${plural(held.length, "message")} held${held.length ? ` ${dim(`(${money(atStake)} at stake${outcome.length ? `: ${outcome.join(", ")}` : ""})`)}` : ""}`,
    );
    console.log(
      `               ${plural(count("big-read"), "big read")}, ${plural(count("retry"), "retry", "retries")}, ${plural(count("compact"), "compact nudge")}`,
    );
    const kept = savedText(guardSaved(week));
    if (kept) {
      console.log(`               ${green(kept)} ${dim("(only holds that stuck count)")}`);
    }
  }
  console.log("");
  console.log(
    on
      ? `  ${blue("optimaizr guard off")} ${dim("takes it out")}`
      : `  ${blue("optimaizr guard on")} ${dim("turns it on; your own hooks stay as they are")}`,
  );
  console.log("");
}
