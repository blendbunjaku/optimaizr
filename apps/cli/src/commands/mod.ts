import { bold, dim, green, wrap as wrapText, yellow } from "@optimaizr/core";
import { activeModSessions, readModSessions, readOverrides } from "@optimaizr/local";
import { Args } from "../args.js";
import { describeOverride } from "./live.js";

/** What to type in Claude Code to install the mod from this repo's marketplace. */
export const MOD_INSTALL = [
  "/plugin marketplace add blendbunjaku/optimaizr",
  "/plugin install optimaizr@optimaizr",
  "/reload-plugins",
];

function ago(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** `optimaizr mod`: how to install the Claude Code mod, and whether it is running. */
export function cmdMod(args: Args): void {
  const now = new Date();
  const active = activeModSessions({ now });
  const last = readModSessions(undefined, now)[0];
  const switches = readOverrides().filter((o) => o.source === "claude-code");

  if (args.flags.json) {
    console.log(
      JSON.stringify(
        { running: active, lastSeen: last?.seenAt ?? null, switches, install: MOD_INSTALL },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| mod for Claude Code")}`);
  console.log("");
  for (const line of wrapText(
    "Runs inside Claude Code 2.1.287 or later. While Claude works, the spinner shows " +
      "what the turn has cost and the band above the prompt shows your 5-hour window " +
      "and how long it lasts at this pace. Y in optimaizr live switches the running " +
      "session's model or effort from its next request, and each answer says what the " +
      "switch saved. It counts down a long conversation's cache, /optimaizr handoff " +
      "writes a note to start fresh from, and it holds a command that failed twice unchanged.",
    72,
  )) {
    console.log(`  ${line}`);
  }
  console.log("");
  console.log(`  ${bold("Install")} ${dim("in a Claude Code session:")}`);
  for (const line of MOD_INSTALL) console.log(`    ${line}`);
  console.log("");
  console.log(
    `  ${dim("Optional: the CLI needs none of it. Without the mod, optimaizr statusline on")}`,
  );
  console.log(`  ${dim("puts the context and cache countdown under Claude Code's prompt.")}`);
  console.log("");

  if (active.length > 0) {
    const versions = [...new Set(active.map((s) => s.version))].join(", ");
    console.log(
      `  ${bold("Status".padEnd(10))}${green(`running in ${active.length} session${active.length === 1 ? "" : "s"}`)} ${dim(`· mod ${versions} · seen ${ago(active[0]!.seenAt, now)}`)}`,
    );
  } else if (last) {
    console.log(
      `  ${bold("Status".padEnd(10))}${yellow("not running")} ${dim(`· last seen ${ago(last.seenAt, now)}`)}`,
    );
  } else {
    console.log(
      `  ${bold("Status".padEnd(10))}${dim("not seen yet: it reports here once a session with it starts")}`,
    );
  }
  for (const [i, o] of switches.entries()) {
    console.log(
      `  ${bold((i === 0 ? "Switches" : "").padEnd(10))}${describeOverride(o)} ${dim(`· optimaizr undo ${o.rule}`)}`,
    );
  }
  console.log("");
  console.log(
    `  ${dim("Fully local: usage figures and the commands Claude runs, never your prompts.")}`,
  );
  console.log(`  ${dim("Source: github.com/blendbunjaku/optimaizr/tree/main/mods/optimaizr")}`);
  console.log("");
}
