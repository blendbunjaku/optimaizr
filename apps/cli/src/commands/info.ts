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
  console.log(`  ${dim("Cache reads bill at a fraction of the input rate: a tenth on most")}`);
  console.log(`  ${dim("current models, a twentieth on Opus 5.5, half on some older ones.")}`);
  console.log(`  ${dim("So a stable prefix is the largest single lever on cost.")}`);
  console.log("");

  const tiers: Array<[string, string]> = [
    ["frontier", "Reach for these when the work is genuinely hard"],
    ["balanced", "The default for almost everything"],
    ["fast", "Mechanical, well-specified work"],
  ];

  for (const [tier, blurb] of tiers) {
    const models = MODELS.filter((m) => m.tier === tier && m.listed !== false);
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
  const unlisted = MODELS.filter((m) => m.listed === false);
  if (unlisted.length > 0) {
    const names = [...new Set(unlisted.map((m) => m.label.split(/[\s-]/)[0]))];
    console.log(
      `  ${dim(`Also priced, so their calls count, but not compared here: ${names.join(", ")}`)}`,
    );
    console.log(
      `  ${dim(`(${unlisted.length} models, list prices from each vendor's own page).`)}`,
    );
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
      "During 'verify', to your own model providers. To api.typesafe.ai only when you pass --jev. Once a day, a background request to registry.npmjs.org for the latest optimaizr version number.",
    ],
    [
      "Version check",
      'Sends nothing about you or your usage; never in CI, with --json or when output is piped. Off with OPTIMAIZR_NO_UPDATE_CHECK=1 or "updateCheck": false in the config.',
    ],
    [
      "Jev (live --jev)",
      "Off by default. Sends route names, model ids, token medians and tool names - never prompts, completions or tool payloads. Run 'live --jev --dry-run' to print the exact bytes first.",
    ],
    ["Telemetry", "None. No analytics, no usage reporting, no crash reporting."],
    [
      "Agent logs",
      "Claude Code and Codex logs, and opencode's database (read-only), are read for usage. What each tool call was given (a path, a command, the first 200 characters of anything else) is read in memory. Only a report you export, and guard's log of what it held, name a file or command. By default prompts and answers aren't read; guard, once on, reads them for its handoff note.",
    ],
    ["Usage records", `${optimaizrDir()}/events.jsonl - tokens, cost, latency, model.`],
    [
      "Live overrides",
      `${optimaizrDir()}/overrides.json - model swaps you accepted in 'live'; wrap() and the Claude Code mod apply them. 'optimaizr undo' lists them.`,
    ],
    [
      "Claude Code mod",
      `Reads usage figures and the commands Claude runs (in memory, for the retry guard), never prompts or file contents, and makes no network calls. Each session it runs in keeps ${optimaizrDir()}/mod/sessions/<id>.json: id, folder, version, times and Claude Code's own plan meters.`,
    ],
    [
      "5-hour meter",
      `${optimaizrDir()}/meter.jsonl - the time and the percent each time Claude Code's 5-hour meter moves, logged by the status line. Claude Desktop's plan-usage-history.json is read too. From both, ${optimaizrDir()}/window-rate.json keeps what 1% of the window costs, for 'live' and the mod.`,
    ],
    [
      "Guard (guard on)",
      `Reads the end of the conversation's transcript at each message and tool call, in memory. When it holds a message to an expired cache it saves a short note (the last ask, files changed, what was tried and dropped, open todos, a clip of the last reply) in ${optimaizrDir()}/guard/handoffs/, read once when you /clear that conversation, then deleted; notes nobody reads go after 30 minutes. What it held, and what went through after all, goes to guard/receipts.jsonl: when, what kind, the cost, and the file or command. Once a week its end-of-turn hook starts 'optimaizr guard week' in the background, which saves one line on the last 7 days against the 7 before in guard/week.json, and where Claude Code really compacts in guard/compact-point.json. On a Claude plan with a learned limit it starts 'optimaizr guard pace' at most every 10 minutes, which saves whether the 5-hour window runs out before it resets in guard/pace.json. guard/offered.json keeps when optimaizr offered to turn guard on, so it asks once.`,
    ],
    [
      "Prompt contents",
      "Not stored unless you explicitly enable capture, apart from guard's short-lived handoff note.",
    ],
    ["Capture", "Off by default. Sampled, redacted and local-only when on."],
    ["Redaction", "Emails, API keys, bearer tokens and long digit runs are masked before write."],
    ["API keys", "Never read, stored or logged. verify uses your environment variable directly."],
    ["Model training", "Your data is never used to train anything."],
    [
      "Settings changes",
      `${optimaizrDir()}/settings-changes.json - what 'apply context-compaction' changed in Claude Code or Codex, so 'undo' can put it back.`,
    ],
    [
      "Change history",
      `${optimaizrDir()}/changes.jsonl - which change, to what and when, for 'optimaizr results'. No usage, prompts or code.`,
    ],
    ["Retention", `Until you delete it. 'rm -rf ${optimaizrDir()}' removes everything.`],
  ];
  for (const [k, v] of rows) {
    const lines = wrapText(v, 52);
    console.log(`  ${dim(k.padEnd(18))} ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`  ${" ".repeat(18)} ${line}`);
  }
  console.log("");
  console.log(`  ${bold("What a usage record contains")}`);
  console.log(`  ${dim("model, timestamps, token counts, cost, latency, tool names, the")}`);
  console.log(`  ${dim("first 200 characters of each tool call's input, and a hash of")}`);
  console.log(`  ${dim("your prompt prefix.")}`);
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

/** A command as `--help` lists it; `flags` show under `optimaizr <command> --help`. */
export interface HelpEntry {
  cmd: string;
  what: string;
  aliases?: string[];
  flags?: Array<[string, string]>;
  /** False for commands that read no usage, so --days and the rest mean nothing. */
  common?: false;
}

/**
 * Every command, grouped as `--help` lists them: the everyday ones first.
 * Groups marked `more` show only under `optimaizr help all`; they all still run.
 */
export const HELP_GROUPS: Array<{ title: string; more?: boolean; commands: HelpEntry[] }> = [
  {
    title: "Start here",
    commands: [
      { cmd: "optimaizr", what: "your usage, waste and the biggest win" },
      {
        cmd: "optimaizr live",
        what: "watch calls as they happen: cache countdown, fixes",
        aliases: ["watch"],
        flags: [
          ["--backfill N", "replay the last N recorded calls first"],
          ["--window N", "calls held in the rolling window"],
          ["--min-usd N", "don't announce below this observed amount"],
          ["--no-prompt", "print recommendations, never ask"],
          ["--no-turns", "no line after each Claude Code turn"],
          ["--notify", "system notifications: cache expiring, cold returns, long turns done"],
          ["--auto", "apply confident switches through the Claude Code mod"],
        ],
      },
      {
        cmd: "optimaizr statusline on",
        what: "cache countdown and re-read cost under Claude Code's prompt",
        flags: [["off", "take it out again"]],
        common: false,
      },
      {
        cmd: "optimaizr sessions",
        what: "your costliest conversations and where the cost climbs",
        flags: [["--top N", "how many conversations to list (default 10)"]],
      },
    ],
  },
  {
    title: "Change things",
    commands: [
      {
        cmd: "optimaizr apply <rule>",
        what: "make the change (alone, lists what you can change)",
        flags: [
          ["--done", "record a change you made by hand, so results can measure it"],
          ["--at 400K", "context-compaction: where to compact, 100K to 1M"],
          ["--agent claude|codex", "context-compaction: set it for one agent only"],
          ["--dry-run", "context-compaction: say what would change, write nothing"],
          ["--accept-risk", "apply a fix no replay can settle, on your own judgement"],
        ],
      },
      {
        cmd: "optimaizr guard on",
        what: "hold a costly step once in Claude Code: expired cache, big reads, retries",
        flags: [
          ["off", "take its hooks out again"],
          ["(alone)", "whether it is on, and what it held this week"],
          ["week", "the last 7 days against the 7 before, shown once a week"],
        ],
      },
      { cmd: "optimaizr results", what: "did it work: the days after each change against before" },
      {
        cmd: "optimaizr undo <rule>",
        what: "revert a change optimAIzr made (alone, lists them)",
        common: false,
      },
      { cmd: "optimaizr mod", what: "optional Claude Code mod: mid-session switches, handoff" },
    ],
  },
  {
    title: "Look closer",
    commands: [
      {
        cmd: "optimaizr recommend",
        what: "ranked actions with impact and confidence",
        aliases: ["recommendations"],
      },
      {
        cmd: "optimaizr why",
        what: "where the money goes: model, project, kind of work",
        flags: [
          ["<key> <key>", "open one branch, like: optimaizr why anthropic claude-opus-5-5"],
          ["--depth N", "how many levels to print"],
          ["--requests N", "example requests under each leaf (default 3)"],
        ],
      },
      { cmd: "optimaizr show <rule>", what: "the requests a recommendation touches" },
      {
        cmd: "optimaizr card",
        what: "your last 30 days as an image to post",
        flags: [["--out FILE", "where to write it"]],
      },
    ],
  },
  {
    title: "About",
    commands: [
      {
        cmd: "optimaizr privacy",
        what: "what is collected, stored and sent",
        aliases: ["security"],
        common: false,
      },
      { cmd: "optimaizr feedback", what: "report a bug or a wrong number", common: false },
      {
        cmd: "optimaizr changelog",
        what: "what changed in this version",
        aliases: ["whatsnew"],
        flags: [["--all", "every version"]],
        common: false,
      },
    ],
  },
  {
    title: "Other views of the same numbers",
    more: true,
    commands: [
      { cmd: "optimaizr profile", what: "same as optimaizr on its own" },
      { cmd: "optimaizr audit", what: "spend and what is recoverable, as a short summary" },
      { cmd: "optimaizr scan", what: "spend by model and project, then the savings" },
      { cmd: "optimaizr tokens", what: "the same as scan", aliases: ["analytics"] },
      { cmd: "optimaizr waste", what: "only the savings, each with its fix" },
      {
        cmd: "optimaizr report",
        what: "write the profile as an HTML page",
        flags: [
          ["--out FILE", "where to write it"],
          ["--org NAME", "a name for the header"],
        ],
      },
      { cmd: "optimaizr metrics", what: "how much was analysed and how much was found" },
      {
        cmd: "optimaizr limit",
        what: "record a session-limit hit Claude Code's transcripts missed",
        flags: [
          ["--at 15:10", "record one after the fact"],
          ["undo", "remove the last one"],
        ],
      },
    ],
  },
  {
    title: "For SDK and API users",
    more: true,
    commands: [
      {
        cmd: "optimaizr verify <rule>",
        what: "replay your own requests on the cheaper option (API key)",
      },
      { cmd: "optimaizr simulate <rule>", what: "what the change would cost" },
      {
        cmd: "optimaizr import <file>",
        what: "load a CSV or JSON usage export",
        flags: [["--service NAME", "label for the imported rows"]],
      },
      {
        cmd: "optimaizr guide",
        what: "which model for which job, with prices",
        aliases: ["models"],
        common: false,
      },
      { cmd: "optimaizr providers", what: "what can be read, and from where", common: false },
    ],
  },
];

/** Flags most commands take. The `more` ones show only under `help all`. */
const COMMON_FLAGS: Array<[string, string, boolean?]> = [
  ["--days N", "only the last N days"],
  ["--project STR", "filter by project path"],
  ["--plan NAME", "read usage as a plan: pro, max5, max20, team, team-premium"],
  ["--budget N", "monthly cap in USD: when it runs out, what buys days"],
  ["--why", "show every calculation and assumption"],
  ["--json", "machine-readable output"],
  ["--source all|agents|sdk", "which traffic to read", true],
  ["--tz utc|local|<IANA>", "which midnight day buckets use (default utc)", true],
];

/** Every command in one list, for the unknown-command guess. */
export const HELP_COMMANDS: Array<[string, string]> = HELP_GROUPS.flatMap((g) =>
  g.commands.map((c): [string, string] => [c.cmd, c.what]),
);

/** The entry a command name or alias belongs to, like "watch" -> live. */
export function helpEntry(name: string): HelpEntry | undefined {
  for (const group of HELP_GROUPS) {
    for (const entry of group.commands) {
      const word = entry.cmd.split(" ")[1];
      if (word === name || entry.aliases?.includes(name)) return entry;
    }
  }
  return undefined;
}

function printFlags(flags: Array<[string, string]>): void {
  const width = Math.max(...flags.map(([f]) => f.length)) + 3;
  for (const [flag, what] of flags) console.log(`    ${flag.padEnd(width)}${dim(what)}`);
}

/**
 * `optimaizr --help`, `help all` for every command, and `help <command>` (or
 * `<command> --help`) for one command's own flags.
 */
export function cmdHelp(topic?: string): void {
  const all = topic === "all";
  const entry = topic && !all ? helpEntry(topic) : undefined;
  console.log("");
  if (entry) {
    console.log(`  ${blue(entry.cmd)} ${dim(`- ${entry.what}`)}`);
    if (entry.aliases?.length) {
      console.log(`  ${dim(`also: ${entry.aliases.map((a) => `optimaizr ${a}`).join(", ")}`)}`);
    }
    console.log("");
    if (entry.flags?.length) {
      printFlags(entry.flags);
      console.log("");
    }
    if (entry.common !== false) {
      console.log(`  ${dim("It also takes")}`);
      printFlags(COMMON_FLAGS.map(([f, w]) => [f, w]));
      console.log("");
    }
    return;
  }

  console.log(`  ${bold("optimAIzr")} ${dim("- spend fewer tokens on the same work")}`);
  console.log("");
  const groups = HELP_GROUPS.filter((g) => all || !g.more);
  // Pad to the longest command so a new entry can't break the column.
  const width = Math.max(...groups.flatMap((g) => g.commands.map((c) => c.cmd.length))) + 2;
  for (const group of groups) {
    console.log(`  ${bold(group.title)}`);
    for (const { cmd, what } of group.commands) {
      console.log(`    ${blue(cmd.padEnd(width))}${dim(what)}`);
    }
    console.log("");
  }
  console.log(`  ${bold("Most commands take")}`);
  printFlags(COMMON_FLAGS.filter(([, , more]) => all || !more).map(([f, w]) => [f, w]));
  console.log("");
  console.log(`  ${dim("optimaizr <command> --help   that command's own flags")}`);
  if (!all)
    console.log(
      `  ${dim("optimaizr help all           every command, the older views and the SDK tools")}`,
    );
  console.log("");
}
