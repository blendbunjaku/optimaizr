import path from "node:path";
import {
  blue,
  bold,
  dim,
  findWaste,
  green,
  magenta,
  providerOf,
  type QualityBar,
  readVerification,
  recordVerification,
  red,
  resolveVerification,
  stateForVerdict,
  usd,
  verificationModeOf,
  type VerificationRecord,
  wrap as wrapText,
  yellow,
  DEFAULT_BAR,
} from "@optimaizr/core";
import { logVerification, verifyCandidate } from "@optimaizr/local";
import type { Args } from "../args.js";
import { activeConfig } from "../config.js";
import { load } from "../data.js";

/**
 * The SDK and key for each provider. Both SDKs are optional peer dependencies:
 * only `verify` makes network calls, so analysing spend never needs them.
 */
export const SDKS: Record<string, { specifier: string; envVar: string; ctor: string }> = {
  anthropic: { specifier: "@anthropic-ai/sdk", envVar: "ANTHROPIC_API_KEY", ctor: "Anthropic" },
  openai: { specifier: "openai", envVar: "OPENAI_API_KEY", ctor: "OpenAI" },
};

/** Construct a provider's client, or null if its SDK or key is absent. */
export async function loadClient(provider: string): Promise<any | null> {
  const sdk = SDKS[provider];
  if (!sdk || !process.env[sdk.envVar]) return null;
  try {
    // Kept unresolved at compile time: an optional peer dependency.
    const specifier = sdk.specifier;
    const mod: any = await import(specifier);
    const Ctor = mod.default ?? mod[sdk.ctor];
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

export async function cmdVerify(args: Args): Promise<void> {
  const ruleName = args.positional[0];
  if (!ruleName) {
    console.log(`  ${red("usage:")} optimaizr verify <rule>   ${dim("(see optimaizr waste)")}`);
    process.exitCode = 1;
    return;
  }

  const config = activeConfig();
  const data = await load(args);
  const finding = findWaste(data).find((f) => f.rule === ruleName);
  if (!finding) {
    console.log(`  ${red("No such finding:")} ${ruleName}`);
    process.exitCode = 1;
    return;
  }
  // Decide what verification means for this finding before checking whether a
  // replay is possible. `apply` resolves the same way, so they can't disagree.
  const mode = verificationModeOf(finding);

  if (mode === "not-required") {
    // Record it, so `apply` reads a state rather than re-deriving one.
    const entry: VerificationRecord = {
      rule: ruleName,
      at: new Date().toISOString(),
      state: "not_required",
      mode,
      note: "Waste removal only; this change cannot alter model output.",
    };
    recordVerification(entry);
    logVerification(entry);

    console.log("");
    console.log(`  ${bold(finding.title)}`);
    console.log(
      `  ${green("not_required")} ${dim("- this removes waste without changing output.")}`,
    );
    console.log(`  ${dim("There is nothing to verify, so it is safe to apply directly.")}`);
    console.log("");
    for (const line of wrapText(finding.fix, 68)) console.log(`  ${dim(line)}`);
    console.log("");
    console.log(`    ${blue(`optimaizr apply ${ruleName}`)}`);
    console.log("");
    return;
  }

  if (mode === "manual" || !finding.candidate) {
    // Required, but not by replay: the fix can change output and isn't a
    // request rewrite, so the user has to sign it off (`--accept-risk`).
    const resolved = resolveVerification(finding, readVerification(ruleName));
    console.log("");
    console.log(`  ${bold(finding.title)}`);
    console.log(
      `  ${resolved.canApply ? green(resolved.state) : yellow("manual verification required")}  ${dim(resolved.headline)}`,
    );
    console.log("");
    for (const line of wrapText(finding.fix, 68)) console.log(`  ${dim(line)}`);
    console.log("");
    if (resolved.guidance) {
      for (const line of wrapText(resolved.guidance, 68)) console.log(`  ${dim(line)}`);
      console.log("");
      console.log(`    ${blue(`optimaizr apply ${ruleName} --accept-risk`)}`);
      console.log("");
    } else {
      console.log(`    ${blue(`optimaizr apply ${ruleName}`)}`);
      console.log("");
    }
    return;
  }

  const bar: QualityBar = { ...DEFAULT_BAR, ...(config.qualityBar ?? {}) };

  // Which vendors this verification has to talk to: the providers the affected
  // traffic runs on, plus whichever one owns the judge model.
  const needed = new Set<string>();
  for (const e of data.events) {
    if (finding.candidate.matches(e)) needed.add(providerOf(e.model));
  }
  if (bar.judge) needed.add(providerOf(bar.judge.model));
  needed.delete("unknown");

  const clients: Record<string, any> = {};
  const missing: string[] = [];
  for (const provider of needed) {
    const client = await loadClient(provider);
    if (client) clients[provider] = client;
    else missing.push(provider);
  }

  if (Object.keys(clients).length === 0) {
    console.log("");
    console.log(`  ${red("Verification needs an SDK and an API key for your own traffic.")}`);
    for (const provider of missing) {
      const sdk = SDKS[provider];
      if (!sdk) continue;
      console.log(
        `  ${dim(`${provider}:`)} ${blue(`npm install ${sdk.specifier}`)} ${dim(`and set ${sdk.envVar}`)}`,
      );
    }
    console.log("");
    console.log(`  ${dim("Verification replays your own traffic with your own key.")}`);
    console.log("");
    process.exitCode = 1;
    return;
  }

  for (const provider of missing) {
    const sdk = SDKS[provider];
    console.log(
      `  ${yellow(`No ${provider} client, so that traffic will be skipped.`)} ${sdk ? dim(`(needs ${sdk.specifier} and ${sdk.envVar})`) : ""}`,
    );
  }
  const monthlyCalls =
    (data.events.filter((e) => finding.candidate!.matches(e)).length /
      Math.max(1, data.window.days)) *
    30;

  console.log("");
  console.log(`  ${bold("optimAIzr verify")} ${dim("|")} ${finding.candidate.description}`);
  console.log(
    `  ${dim(config.path ? `quality bar: ${path.basename(config.path)}` : "quality bar: built-in default")}`,
  );
  console.log("");
  console.log(`  ${dim("Replaying your own recorded traffic. Nothing is applied yet.")}`);
  console.log("");

  const result = await verifyCandidate({
    clients,
    candidate: finding.candidate,
    bar,
    monthlyCalls,
    onProgress: (done, total) => {
      if (process.stdout.isTTY) process.stdout.write(`\r  ${dim(`replaying ${done}/${total}`)}   `);
    },
  });
  if (process.stdout.isTTY) process.stdout.write(`\r${" ".repeat(40)}\r`);

  if (result.samples === 0) {
    console.log(`  ${yellow("No captured samples to replay.")}`);
    console.log("");
    console.log(`  ${dim("Verification re-runs your own traffic, so it needs the prompts.")}`);
    console.log(`  ${dim("Turn on sampled capture (local-only, redacted, opt-in):")}`);
    console.log("");
    console.log(
      `    ${blue('optimaizr.wrap(client, { service: "my-api", capture: { rate: 0.02 } })')}`,
    );
    console.log("");
    return;
  }

  const verdictTag =
    result.verdict === "PASS"
      ? green(bold(" PASS "))
      : result.verdict === "FAIL"
        ? red(bold(" FAIL "))
        : yellow(bold(" INCONCLUSIVE "));

  console.log(`  ${verdictTag}  ${dim(`${result.samples} samples replayed`)}`);
  console.log("");
  console.log(
    `  ${dim("cost/call")}   ${usd(result.baselineCostPerCall)} ${dim("->")} ${usd(result.candidateCostPerCall)}`,
  );
  console.log(
    `  ${dim("projected")}   ${result.savingPerCall > 0 ? green(`${usd(result.monthlySaving)}/mo, ${usd(result.monthlySaving * 12)}/yr`) : red("no saving")}`,
  );
  console.log(
    result.unpricedCalls > 0
      ? `  ${dim("this check cost you")} ${dim("at least")} ${usd(result.verificationCost)} ${dim(`(${result.unpricedCalls} call${result.unpricedCalls === 1 ? "" : "s"} unpriced)`)}`
      : `  ${dim("this check cost you")} ${usd(result.verificationCost)}`,
  );
  console.log("");

  if (result.checks.length) {
    console.log(`  ${bold("Quality checks")}`);
    for (const c of result.checks) {
      const tag = c.ok ? green("ok  ") : red("FAIL");
      console.log(
        `    ${tag} ${c.label.padEnd(24)} ${dim(`candidate ${c.candidatePassed}/${c.total}, baseline ${c.baselinePassed}/${c.total}`)}`,
      );
    }
    console.log("");
  }

  if (result.judge) {
    console.log(
      `  ${bold("Pairwise judge")} ${dim("(each pair judged twice, positions swapped)")}`,
    );
    console.log(
      `    ${magenta(`${(result.judge.winRate * 100).toFixed(0)}%`)} win rate  ${dim(`${result.judge.wins}W / ${result.judge.losses}L / ${result.judge.ties}T`)}`,
    );
    console.log("");
  }

  for (const reason of result.reasons) console.log(`    ${dim("-")} ${reason}`);
  console.log("");

  const entry: VerificationRecord = {
    rule: ruleName,
    at: new Date().toISOString(),
    state: stateForVerdict(result.verdict),
    mode,
    verdict: result.verdict,
    samples: result.samples,
    monthlySaving: result.monthlySaving,
    description: finding.candidate.description,
    note: result.reasons[0],
  };
  recordVerification(entry);
  logVerification(entry);

  console.log(
    `  ${dim("state")}       ${bold(entry.state)} ${dim("- recorded; apply reads this.")}`,
  );
  console.log("");

  if (entry.state === "passed") {
    console.log(`  ${green("Cleared your quality bar.")}`);
    console.log(
      `    ${blue(`optimaizr apply ${ruleName}`)} ${dim("to get the exact change to make.")}`,
    );
  } else if (entry.state === "failed") {
    console.log(`  ${red("Did not clear your quality bar.")} ${dim("Keep the current setup.")}`);
    console.log(`  ${dim("This is the point of verifying first: the saving was not free.")}`);
  }
  console.log("");
}
