#!/usr/bin/env node
import { bold, dim, red, setDecisionStore, setVerificationStore } from "@optimaizr/core";
import { fileDecisionStore, fileVerificationStore } from "@optimaizr/local";
import { parseArgs } from "./args.js";
import {
  cmdAudit,
  cmdMetrics,
  cmdRecommend,
  cmdReport,
  cmdScan,
  cmdTokens,
  cmdWaste,
  cmdWhy,
} from "./commands/analyze.js";
import { cmdApply, cmdShow, cmdSimulate } from "./commands/apply.js";
import { cmdChangelog } from "./commands/changelog.js";
import { cmdImport } from "./commands/import.js";
import {
  cmdFeedback,
  cmdGuide,
  cmdHelp,
  cmdPrivacy,
  cmdProviders,
  cmdVersion,
  HELP_COMMANDS,
} from "./commands/info.js";
import { cmdLive, cmdUndo } from "./commands/live.js";
import { cmdMod } from "./commands/mod.js";
import { cmdCard, cmdLimit, cmdProfile } from "./commands/plan.js";
import { cmdVerify } from "./commands/verify.js";
import { activeConfig, initConfig } from "./config.js";
import { afterCommand, runUpdateCheck, updatesEnabled } from "./update.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // `--help` and `--version` arrive as flags, so handle them before the switch
  // (which would fall back to `profile`) and before loading config, so a broken
  // config file can't break --help.
  const first = args.command;
  if (args.flags.help || first === "help" || first === "-h") return cmdHelp();
  if (args.flags.version || first === "version" || first === "-v") return cmdVersion();
  // The detached background half of the update check: no output, ever.
  if (first === "__update-check") return runUpdateCheck();

  initConfig();
  await run(args);
  const enabled = updatesEnabled({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    json: Boolean(args.flags.json),
    configured: activeConfig().updateCheck,
  });
  if (enabled && process.argv[1]) afterCommand(process.argv[1]);
}

async function run(args: ReturnType<typeof parseArgs>): Promise<void> {
  switch (args.command) {
    case "scan":
      return cmdScan(args);
    case "waste":
      return cmdWaste(args);
    case "tokens":
    case "analytics":
      return cmdTokens(args);
    case "why":
      return cmdWhy(args);
    case "recommend":
    case "recommendations":
      return cmdRecommend(args);
    case "show":
      return cmdShow(args);
    case "simulate":
      return cmdSimulate(args);
    case "audit":
      return cmdAudit(args);
    case "profile":
      return cmdProfile(args);
    case "limit":
      return cmdLimit(args);
    case "card":
      return cmdCard(args);
    case "live":
    case "watch":
      return cmdLive(args);
    case "privacy":
    case "security":
      return cmdPrivacy();
    case "providers":
      return cmdProviders();
    case "metrics":
      return cmdMetrics(args);
    case "verify":
      return cmdVerify(args);
    case "apply":
      return cmdApply(args);
    case "undo":
      return cmdUndo(args);
    case "mod":
    case "mods":
      return cmdMod(args);
    case "import":
      return cmdImport(args);
    case "report":
      return cmdReport(args);
    case "guide":
    case "models":
      return cmdGuide();
    case "feedback":
      return cmdFeedback();
    case "changelog":
    case "whatsnew":
      return cmdChangelog(args);
    default: {
      // Exit non-zero so scripts notice a typo.
      const names = HELP_COMMANDS.map(([c]) => c.split(" ")[1]!);
      const guess = names.find((n) => n.startsWith(args.command.slice(0, 2)));
      console.log("");
      console.log(
        `  ${red(`unknown command "${args.command}"`)}${guess ? ` ${dim("- did you mean")} ${bold(`optimaizr ${guess}`)}${dim("?")}` : ""}`,
      );
      console.log(`  ${dim("optimaizr --help lists them all")}`);
      console.log("");
      process.exitCode = 1;
      return;
    }
  }
}

// Core keeps decisions and verifications in memory; the CLI persists them under
// ~/.optimaizr. `apply` gates on the verification store.
setDecisionStore(fileDecisionStore());

setVerificationStore(fileVerificationStore());

main().catch((err) => {
  console.error(`  ${red("optimAIzr failed:")} ${err?.message ?? err}`);
  process.exitCode = 1;
});
