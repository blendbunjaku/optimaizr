import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  BIG_READ_BYTES,
  blue,
  bold,
  type Dataset,
  dim,
  green,
  guardSaved,
  HOLD_MIN_USD,
  observedCompactPoint,
  paceCheck,
  paceText,
  red,
  savedText,
  type UsageEvent,
  weekCompare,
  weekText,
  wouldHold,
  wrap,
} from "@optimaizr/core";
import {
  appliedChanges,
  applyGuard,
  compactionStatus,
  guardApplied,
  guardHook,
  guardOffered,
  type HookInput,
  markGuardOffered,
  ownCommand,
  readReceipts,
  readWindowRate,
  saveCompactPoint,
  savePace,
  saveWeekLine,
  undoGuard,
} from "@optimaizr/local";
import type { Args } from "../args.js";
import { limitHits, load } from "../data.js";
import { planLimitUsd, shareRate } from "../share.js";
import { readStdin } from "./statusline.js";

// A rate older than this may belong to a plan since changed.
const RATE_MAX_AGE_MS = 30 * 86_400_000;

/** What 1% of the 5-hour window costs, as last learned, if it is recent. */
function savedRate(now = Date.now()): number | null {
  const r = readWindowRate();
  return r && now - Date.parse(r.at) < RATE_MAX_AGE_MS ? r.usdPerPercent : null;
}

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
  if (what === "pace") return guardPace(args);
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
      usdPerPercent: input.hook_event_name === "UserPromptSubmit" ? savedRate() : null,
      weekRun: () => inBackground("guard week"),
      // Only a plan with a learned limit has a pace to keep.
      paceRun:
        input.hook_event_name === "Stop" && savedRate()
          ? () => inBackground("guard pace")
          : undefined,
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
  learnCompactPoint(data);
  // Keeps the rate the holds quote fresh, for people who never open sessions or live.
  shareRate(data.events, { limitUsd: planLimitUsd(args, data) });
  const w = weekCompare(data.events, Date.now(), limitHits(data));
  if (!w) return;
  const text = weekText(w);
  saveWeekLine(text);
  if (process.stdout.isTTY) console.log(`\n  ${dim("Last 7 days:")} ${text}\n`);
}

function inBackground(what: string): void {
  const cmd = ownCommand(what);
  if (cmd) spawn(cmd, { shell: true, detached: true, stdio: "ignore" }).unref();
}

/**
 * `optimaizr guard pace`: whether the 5-hour limit runs out before the reset
 * at the last hour's pace, saved for guard's end-of-turn hook.
 */
async function guardPace(args: Args): Promise<void> {
  const rate = savedRate();
  if (!rate) return;
  // A day back is enough to find where the window running now started.
  const data = await load({ ...args, flags: { ...args.flags, days: "1", source: "agents" } });
  const pace = paceCheck(data.events, rate * 100);
  savePace(pace);
  if (!process.stdout.isTTY) return;
  console.log(
    `\n  ${pace ? paceText(pace) : dim("Nothing to warn about in this 5-hour window.")}\n`,
  );
}

/**
 * Claude Code compacts under its setting (168K with 200K set, on my machine),
 * so the nudge goes by where it really did since the setting last changed.
 */
function learnCompactPoint(data: Pick<Dataset, "compactions">): void {
  const setting = Number(compactionStatus()["claude-code"]);
  if (!(setting > 0)) return;
  const since = appliedChanges()
    .filter((c) => c.rule === "context-compaction" && (!c.source || c.source === "claude-code"))
    .map((c) => (c.until && c.until > c.at ? c.until : c.at))
    .sort()
    .pop();
  const point = observedCompactPoint(data.compactions ?? [], since);
  if (point) saveCompactPoint({ ...point, setting });
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

const OFFER_DAYS = 30;
// Under this the pitch is too small to make: a later run, with more behind it, asks.
const OFFER_MIN_USD = 5;

/**
 * Asked once, after the first report: turn guard on, with what it would have
 * held in the last 30 days. Only in a terminal, and only once that is $5 or more.
 */
export async function offerGuard(
  events: readonly UsageEvent[],
  opts: { onPlan: boolean },
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) return;
  if (guardOffered() || guardApplied()) return;
  const held = wouldHold(events, Date.now() - OFFER_DAYS * 86_400_000);
  if (!held || held.usd < OFFER_MIN_USD) return;
  // Marked first, so leaving the question with Ctrl-C doesn't bring it back.
  markGuardOffered();

  const n = held.count;
  const sent =
    n === 1
      ? "a message you sent after a break went to a Claude Code conversation whose cache had expired, and wrote all of it into the cache again"
      : `${n} messages you sent after a break went to a Claude Code conversation whose cache had expired, each writing all of it into the cache again for ${money(HOLD_MIN_USD)} or more`;
  const text =
    `In the last ${OFFER_DAYS} days, ${sent}: ${money(held.usd)}${n === 1 ? "" : " in all"}${opts.onPlan ? " at API prices" : ""}, ` +
    `where a warm cache would have read it for ${money(held.warmUsd)}. Guard holds a message like that once, ` +
    "with its price, so you can /clear and go on from a short note of where it stood. Send it again and it goes through.";
  console.log(`  ${bold(`Guard would have held ${plural(n, "message")}`)}`);
  for (const line of wrap(text, 78)) console.log(`  ${line}`);
  console.log("");
  const more =
    "It adds optimAIzr's hooks to ~/.claude/settings.json, next to your own, and also holds a whole big file read and a third try of a failing command, once each.";
  for (const line of wrap(more, 78)) console.log(`  ${dim(line)}`);
  console.log(`  ${dim("Undo any time:")} ${blue("optimaizr guard off")}`);
  console.log("");

  if (await yes(`  ${bold("Turn guard on?")} ${dim("[Y/n]")} `)) return guardOn();
  console.log(`  ${dim("Any time:")} ${blue("optimaizr guard on")}`);
  console.log("");
}

// Enter is yes. Ctrl-C or Ctrl-D is no.
function yes(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer: string | null = null;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (answer === null) process.stdout.write("\n");
      resolve(answer !== null && /^\s*(y|yes)?\s*$/i.test(answer));
    });
    rl.question(question, (a) => {
      answer = a;
      rl.close();
    });
  });
}

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
