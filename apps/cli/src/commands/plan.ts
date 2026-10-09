import fs from "node:fs";
import path from "node:path";
import {
  analyze,
  bold,
  buildProfile,
  cardData,
  claudeConfigDir,
  dim,
  green,
  localTime,
  parsePlan,
  planView,
  red,
  renderCardHtml,
  renderCardSvg,
  renderProfile,
  ruleErrorWarning,
  sessionBlocks,
  summarize,
  usd,
  wrap as wrapText,
} from "@optimaizr/core";
import { latestClaudeWindows, optimaizrDir } from "@optimaizr/local";
import type { Args } from "../args.js";
import { budgetOf, planNote, resolvePlan } from "../config.js";
import {
  emptyNotice,
  limitsPath,
  load,
  loadForBudget,
  readLimitHits,
  summaryOptions,
} from "../data.js";

/**
 * `optimaizr limit`: record that Claude just said the session limit was hit.
 * The limit isn't published, so it's learned as the median of what sessions
 * had used at each hit. `--at` records one after the fact; `undo` removes the last.
 */
export async function cmdLimit(args: Args): Promise<void> {
  const file = limitsPath();
  if (args.positional[0] === "undo") {
    const hits = readLimitHits();
    const last = hits.pop();
    fs.mkdirSync(optimaizrDir(), { recursive: true });
    fs.writeFileSync(file, hits.map((ts) => JSON.stringify({ ts }) + "\n").join(""));
    console.log("");
    console.log(
      last ? `  Removed the hit recorded at ${last}.` : `  ${dim("No limit hits recorded.")}`,
    );
    console.log("");
    return;
  }

  let at = new Date();
  if (typeof args.flags.at === "string") {
    // "15:10" means today at 15:10 local; anything else is handed to Date.
    const hm = /^(\d{1,2}):(\d{2})$/.exec(args.flags.at.trim());
    const parsed = hm
      ? new Date(new Date().setHours(Number(hm[1]), Number(hm[2]), 0, 0))
      : new Date(args.flags.at);
    if (Number.isNaN(parsed.getTime())) {
      console.log(`  ${red(`could not read --at "${args.flags.at}"`)} ${dim("try --at 15:10")}`);
      process.exitCode = 1;
      return;
    }
    at = parsed;
  }

  fs.mkdirSync(optimaizrDir(), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: at.toISOString() }) + "\n");

  const data = await load({ ...args, flags: { ...args.flags, days: "46" } });
  const hits = readLimitHits();
  const session = sessionBlocks(data.events, [], [at.toISOString()]).find(
    (s) => s.usdAtLimit !== undefined,
  );
  const learned = planView(data.events, [], { plan: "pro", limitHits: hits }).limit;

  console.log("");
  console.log(
    `  ${bold("optimAIzr")} ${dim("|")} limit hit recorded at ${localTime(at.toISOString())}`,
  );
  console.log("");
  if (session) {
    console.log(
      `  This session used ${bold(usd(session.usdAtLimit!))} ${dim(
        `(API-equivalent) between ${localTime(session.start)} and the hit; it resets ${localTime(session.end)}.`,
      )}`,
    );
  } else {
    console.log(
      `  ${dim("No Claude Code calls found in the five hours before it, so it adds nothing yet.")}`,
    );
  }
  if (learned) {
    console.log(
      `  Your session limit: ${bold(`~${usd(learned.usd)}`)} ${dim(`from ${learned.hits} hit${learned.hits === 1 ? "" : "s"}.`)}`,
    );
  }
  console.log(`  ${dim(`See it with: ${seeLimitCommand(args)}   ·   undo: optimaizr limit undo`)}`);
  console.log(`  ${dim(`${hits.length} recorded in ${file}`)}`);
  console.log("");
}

/**
 * The command that shows the learned limit: bare `profile` when the plan is
 * known without a flag (config or Claude Code's sign-in), else the plan passed
 * here, with `pro` as the example.
 */
export function seeLimitCommand(args: Args): string {
  const flag = typeof args.flags.plan === "string" ? parsePlan(args.flags.plan) : null;
  const { plan: _flag, ...rest } = args.flags;
  const known = resolvePlan({ ...args, flags: rest }).plan;
  if (known && (!flag || flag === known)) return "optimaizr profile";
  return `optimaizr profile --plan ${flag ?? "pro"}`;
}

/** Plan options for `buildProfile`: the plan, where it came from, recorded hits and live meters. */
function planOptions(args: Args) {
  const choice = resolvePlan(args);
  return {
    choice,
    options:
      choice.plan === null
        ? undefined
        : {
            plan: choice.plan,
            source: choice.source ?? undefined,
            limitHits: readLimitHits(),
            windows: latestClaudeWindows(),
            dir: path.join(claudeConfigDir(), "projects"),
          },
  };
}

/**
 * `optimaizr card`: the last 30 days as an image to post (an HTML page that
 * exports a PNG, plus the SVG). Totals only, so it's safe to share unread.
 */
export async function cmdCard(args: Args): Promise<void> {
  // The headline is the profile's own, so the card never quotes a different
  // monthly figure. The tiles cover the last 30 days (or --days).
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();
  const dayOpts = summaryOptions(args);
  const { findings } = analyze(data);
  const profile = buildProfile(
    data,
    summarize(data, dayOpts),
    findings,
    undefined,
    planOptions(args).options,
  );
  const recent = args.flags.days
    ? data
    : await load({ ...args, flags: { ...args.flags, days: "30" } });
  const card = cardData(profile, summarize(recent, dayOpts));

  const out =
    typeof args.flags.out === "string"
      ? args.flags.out
      : path.resolve(process.cwd(), "optimaizr-card.html");
  const svgOut = out.replace(/\.html?$/i, "") + ".svg";
  fs.writeFileSync(out, renderCardHtml(card));
  fs.writeFileSync(svgOut, renderCardSvg(card));

  if (args.flags.json) {
    console.log(JSON.stringify({ ...card, html: out, svg: svgOut }, null, 2));
    return;
  }
  console.log("");
  console.log(`  ${green("Card written")} ${dim(out)}`);
  console.log(`  ${dim(`and ${svgOut}`)}`);
  console.log("");
  console.log(`  ${dim("Open it to download a PNG or copy the image. Post text:")}`);
  for (const line of wrapText(card.shareText, 64)) console.log(`    ${line}`);
  console.log("");
  console.log(`  ${dim("Totals only: no project names, paths or prompts are on it.")}`);
  console.log("");
}

/**
 * `optimaizr profile`: usage, waste and the biggest lever on one screen.
 * Read-only: unlike `show` and `simulate`, it records no decision status.
 */
export async function cmdProfile(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();

  const dayOpts = summaryOptions(args);
  const summary = summarize(data, dayOpts);
  const { findings, errors } = analyze(data);
  const limitUsd = budgetOf(args);
  const plan = planOptions(args);
  const profile = buildProfile(
    data,
    summary,
    findings,
    limitUsd === null
      ? undefined
      : {
          limitUsd,
          timeZone: dayOpts.timeZone,
          events: await loadForBudget(args),
        },
    plan.options,
  );

  if (args.flags.json) {
    console.log(
      JSON.stringify({ ...profile, detectedPlan: plan.choice.detected, errors }, null, 2),
    );
    return;
  }

  console.log(renderProfile(profile));
  const note = planNote(plan.choice, data.events);
  if (note) {
    for (const line of note) console.log(`  ${line}`);
    console.log("");
  }
  for (const e of errors) console.log(`  ${red(`warning: ${ruleErrorWarning(e)}`)}`);
  if (errors.length) console.log("");
}
