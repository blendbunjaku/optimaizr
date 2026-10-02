import {
  blue,
  bold,
  dim,
  geminiEnabled,
  green,
  listAdapters,
  listProviders,
  MODELS,
  ratesFor,
  red,
  rule,
  tokens as fmtTokens,
  wrap as wrapText,
  yellow,
} from "@optimaizr/core";
import { optimaizrDir } from "@optimaizr/local";
import { VERSION } from "../version.js";

/** `optimaizr guide`: which model for which job, with prices attached. */
export function cmdGuide(): void {
  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| model routing guide")}`);
  console.log("");
  console.log(`  ${dim("Prices are USD per million tokens, from the live catalogue.")}`);
  console.log(`  ${dim("Cache reads bill at a fraction of the input rate - a tenth or")}`);
  console.log(`  ${dim("less on current models, half on some older ones - so a stable")}`);
  console.log(`  ${dim("prefix is the largest single lever on cost.")}`);
  console.log("");

  const tiers: Array<[string, string]> = [
    ["frontier", "Reach for these when the work is genuinely hard"],
    ["balanced", "The default for almost everything"],
    ["fast", "Mechanical, well-specified work"],
  ];

  for (const [tier, blurb] of tiers) {
    const models = MODELS.filter((m) => m.tier === tier);
    if (models.length === 0) continue;
    console.log(`  ${bold(tier.toUpperCase())} ${dim(`- ${blurb}`)}`);
    for (const m of models) {
      const now = ratesFor(m, {});
      const prior = m.rates.length > 1 ? m.rates[m.rates.length - 2] : null;
      const note = prior
        ? dim(`  (was $${prior.inputPerM}/$${prior.outputPerM} until ${prior.until})`)
        : dim(`  (since ${now.card.from})`);
      console.log(
        `    ${blue(m.label.padEnd(12))} ${dim("$")}${String(now.inputPerM).padStart(2)} in ${dim("/")} ${dim("$")}${String(now.outputPerM).padStart(2)} out${note}`,
      );
      console.log(
        `      ${dim(`${m.provider} | ${fmtTokens(m.contextTokens)} ctx | ${m.capabilities.join(", ")}`)}`,
      );
      // Show the long-context band too, not just the cheaper headline rate.
      const band = now.card.longContext;
      if (band) {
        console.log(
          `      ${dim(`above ${fmtTokens(band.aboveTokens)} prompt: $${band.inputPerM} in / $${band.outputPerM} out`)}`,
        );
      }
      for (const line of wrapText(m.bestFor, 62)) console.log(`      ${dim(line)}`);
    }
    console.log("");
  }

  console.log(rule());
  console.log("");
  console.log(`  ${bold("Rules of thumb")}`);
  console.log("");
  const rules: Array<[string, string]> = [
    [
      "Do not",
      "run classification, extraction or formatting on a frontier model. That is a 5x premium for work Haiku does correctly.",
    ],
    [
      "Do not",
      "put anything that varies - a timestamp, a request id, a user name - above your cache breakpoint. It invalidates the whole prefix.",
    ],
    ["Do not", "assume a cheaper model is equivalent. Verify it on your own traffic first."],
    [
      "Do",
      "keep tool definitions in a fixed order at the very front of the request. Reordering them is a silent cache miss.",
    ],
    [
      "Do",
      "use the Batches API for anything that does not need an answer now. It is half price for identical output.",
    ],
    [
      "Do",
      "route sub-agents to a cheaper model than the orchestrator. The orchestrator plans; the sub-agents fetch.",
    ],
    [
      "Do",
      "filter tool output at the source. A 200KB log dump is paid for on every later call in the session, not just once.",
    ],
  ];
  for (const [kind, text] of rules) {
    const tag = kind === "Do" ? green("Do    ") : red("Do not");
    const lines = wrapText(text, 66);
    console.log(`  ${tag} ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`         ${line}`);
  }
  console.log("");
}

/** `optimaizr privacy`: what this tool collects, stores and sends. */
export function cmdPrivacy(): void {
  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| data handling")}`);
  console.log("");
  const rows: Array<[string, string]> = [
    [
      "Where data goes",
      "Nowhere, unless you opt in with 'live --jev'. Everything else stays on this machine.",
    ],
    [
      "Network calls",
      "During 'verify', to your own model providers. To api.typesafe.ai only when you pass --jev.",
    ],
    [
      "Jev (live --jev)",
      "Off by default. Sends route names, model ids, token medians and tool names - never prompts, completions or tool payloads. Run 'live --jev --dry-run' to print the exact bytes first.",
    ],
    ["Telemetry", "None. No analytics, no phone-home, no crash reporting."],
    ["Usage records", `${optimaizrDir()}/events.jsonl - tokens, cost, latency, model.`],
    [
      "Live overrides",
      `${optimaizrDir()}/overrides.json - model swaps you accepted in 'live'; wrap() and the Claude Code mod apply them. 'optimaizr undo' lists them.`,
    ],
    [
      "Claude Code mod",
      `Reads usage figures and the commands Claude runs (in memory, for the retry guard), never prompts or file contents, and makes no network calls. Each session it runs in keeps ${optimaizrDir()}/mod/sessions/<id>.json: id, folder, version, times.`,
    ],
    ["Prompt contents", "Not stored unless you explicitly enable capture."],
    ["Capture", "Off by default. Sampled, redacted and local-only when on."],
    ["Redaction", "Emails, API keys, bearer tokens and long digit runs are masked before write."],
    ["API keys", "Never read, stored or logged. verify uses your environment variable directly."],
    ["Model training", "Your data is never used to train anything."],
    ["Retention", `Until you delete it. 'rm -rf ${optimaizrDir()}' removes everything.`],
  ];
  for (const [k, v] of rows) {
    const lines = wrapText(v, 52);
    console.log(`  ${dim(k.padEnd(18))} ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`  ${" ".repeat(18)} ${line}`);
  }
  console.log("");
  console.log(`  ${bold("What a usage record contains")}`);
  console.log(`  ${dim("model, timestamps, token counts, cost, latency, tool names,")}`);
  console.log(`  ${dim("file paths touched by tools, and a hash of your prompt prefix.")}`);
  console.log(`  ${dim("The prefix hash is one-way and cannot reconstruct the prompt.")}`);
  console.log("");
}

/** `optimaizr providers`: what the tool can read, and from where. */
export function cmdProviders(): void {
  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| providers and adapters")}`);
  console.log("");
  for (const p of listProviders()) {
    console.log(`  ${bold(p.label)} ${dim(`(${p.id})`)}`);
    console.log(
      `    ${dim(`cache read ${p.cachePolicy.read}x | 5m write ${p.cachePolicy.write5m}x | 1h write ${p.cachePolicy.write1h}x | batch ${p.cachePolicy.batch}x`)}`,
    );
    if (p.usageExportHint) console.log(`    ${dim(`usage export: ${p.usageExportHint}`)}`);
    console.log("");
  }

  // Say what's built but switched off.
  if (!geminiEnabled()) {
    console.log(`  ${dim("Google (google)")} ${yellow("off")}`);
    console.log(
      `    ${dim("Gemini is implemented but unverified - its rate cards have not been")}`,
    );
    console.log(`    ${dim("checked against Google's published pricing. Turn it on with")}`);
    console.log(`    ${dim('OPTIMAIZR_GEMINI=1, or "experimental": { "gemini": true } in')}`);
    console.log(`    ${dim("optimaizr.config.json. Verify the rates before trusting a figure.")}`);
    console.log("");
  }
  console.log(`  ${bold("Adapters")}`);
  for (const a of listAdapters()) {
    console.log(`    ${blue(a.label.padEnd(26))} ${dim(a.provider)}`);
  }
  console.log("");
  console.log(`  ${dim("Adapters marked 'any' read whichever vendor the data came from;")}`);
  console.log(`  ${dim("the model catalogue decides which provider each call belongs to.")}`);
  console.log("");
  console.log(`  ${dim("Add a provider by adding models to ~/.optimaizr/models.json")}`);
  console.log(
    `  ${dim("and an adapter in packages/local/src/providers. The engine is untouched.")}`,
  );
  console.log("");
}

export function cmdVersion(): void {
  console.log(`optimaizr ${VERSION}`);
}

/**
 * `optimaizr feedback`: where to report, and the line a bug report needs.
 * Prints rather than posts, since the CLI sends nothing anywhere.
 */
export function cmdFeedback(): void {
  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| feedback")}`);
  console.log("");
  console.log(
    `  ${dim("Tell us where it is wrong:")} ${blue("https://www.optimaizr.com/#feedback")}`,
  );
  console.log("");
  console.log(`  ${dim("For a bug, include this line:")}`);
  console.log(
    `    optimaizr ${VERSION} · Node ${process.version} · ${process.platform} ${process.arch}`,
  );
  console.log("");
}

/** Every command, as `--help` lists it. */
export const HELP_COMMANDS: Array<[string, string]> = [
  ["optimaizr audit", "what you spend, what is recoverable"],
  ["optimaizr profile", "usage, waste and your biggest bottleneck"],
  ["optimaizr scan", "spend, savings and what to do about it"],
  ["optimaizr why", "drill into where the money actually goes"],
  ["optimaizr recommend", "ranked actions with impact and confidence"],
  ["optimaizr live", "watch calls as they happen and surface fixes"],
  ["optimaizr mod", "the Claude Code mod: install it, see it running"],
  ["optimaizr limit", "record a Claude session-limit hit (with --plan)"],
  ["optimaizr show <rule>", "the requests a recommendation touches"],
  ["optimaizr simulate <rule>", "what the change would cost"],
  ["optimaizr waste", "just the opportunities"],
  ["optimaizr tokens", "token analytics and the priciest calls"],
  ["optimaizr verify <rule>", "prove a fix against your quality bar first"],
  ["optimaizr apply <rule>", "get the exact change, once verified"],
  ["optimaizr undo <rule>", "revert a model swap accepted in live"],
  ["optimaizr import <file>", "load a CSV or JSON usage export"],
  ["optimaizr report", "write a shareable dashboard"],
  ["optimaizr card", "your last 30 days as an image to post"],
  ["optimaizr guide", "which model for which job"],
  ["optimaizr providers", "what can be read, and from where"],
  ["optimaizr privacy", "what is collected, stored and sent"],
  ["optimaizr metrics", "how much analysed, how much found"],
  ["optimaizr feedback", "report a bug or a wrong number"],
];

export function cmdHelp(): void {
  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("- spend fewer tokens on the same work")}`);
  console.log("");
  // Pad to the longest command so a new entry can't break the column.
  const width = Math.max(...HELP_COMMANDS.map(([c]) => c.length)) + 2;
  for (const [cmd, what] of HELP_COMMANDS) console.log(`  ${bold(cmd.padEnd(width))}${dim(what)}`);
  console.log("");
  console.log(`  ${dim("--why           show every calculation and assumption")}`);
  console.log(
    `  ${dim("--accept-risk   apply a fix no replay can settle, on your own judgement")}`,
  );
  console.log(`  ${dim("--backfill N    live: replay the last N recorded calls first")}`);
  console.log(`  ${dim("--window N      live: calls held in the rolling window")}`);
  console.log(`  ${dim("--min-usd N     live: don't announce below this observed amount")}`);
  console.log(`  ${dim("--no-prompt     live: print recommendations, never ask")}`);
  console.log(`  ${dim("--budget N      monthly cap in USD: when it runs out, what buys days")}`);
  console.log(`  ${dim("--plan pro|max5|max20|team|team-premium")}`);
  console.log(`  ${dim("                read usage as a Claude subscription: sessions, limit")}`);
  console.log(`  ${dim("--days N        only the last N days")}`);
  console.log(`  ${dim("--project STR   filter by project path")}`);
  console.log(`  ${dim("--source all|agents|sdk")}`);
  console.log(`  ${dim("--tz utc|local|<IANA>   which midnight day buckets use (default utc)")}`);
  console.log(`  ${dim("--json          machine-readable output")}`);
  console.log("");
}
