import fs from "node:fs";
import path from "node:path";
import {
  acceptRisk,
  blue,
  bold,
  callActivity,
  type CallEvent,
  callSession,
  changeName,
  COMPACT_AT,
  type Dataset,
  dim,
  findWaste,
  green,
  isKnownRule,
  localDay,
  modelLabel,
  monthDay,
  priceFor,
  projectName,
  projectionDays,
  readVerification,
  red,
  resolveVerification,
  ruleLabel,
  setStatus,
  simulate,
  tokens as fmtTokens,
  toRecommendations,
  usd,
  verificationModeOf,
  wrap as wrapText,
  yellow,
} from "@optimaizr/core";
import {
  appliedChanges,
  applyCompaction,
  type ChangeEntry,
  type CompactAgent,
  compactionApplied,
  compactionStatus,
  logVerification,
  openChanges,
  readOverrides,
  recordChange,
  statuslineApplied,
} from "@optimaizr/local";
import type { Args } from "../args.js";
import { load } from "../data.js";
import { describeOverride } from "./live.js";
import { statuslineOn } from "./statusline.js";

/**
 * `optimaizr apply`: make the change, or say how. Settings are written for
 * you; a change to how your agent is used comes as steps; an app change is
 * written to `optimaizr-change.md`. It never edits your code.
 */
export async function cmdApply(args: Args): Promise<void> {
  // `apply --done cold-resume` reads the rule as the flag's value.
  const ruleName =
    args.positional[0] ?? (typeof args.flags.done === "string" ? args.flags.done : undefined);
  if (ruleName === "statusline") return statuslineOn();
  const data = await load(args);
  if (!ruleName) return listLevers(data);
  if (args.flags.done) return recordDone(args, ruleName, data);
  // A setting, not a request rewrite: written to the agents' own config files,
  // with the previous value kept for `optimaizr undo context-compaction`.
  if (ruleName === "context-compaction") return applyCompactionLever(args, data.events);
  const finding = findWaste(data).find((f) => f.rule === ruleName);
  if (!finding) {
    console.log(`  ${red("No such finding:")} ${ruleName}`);
    if (isKnownRule(ruleName)) {
      console.log(
        `  ${dim("Nothing for it in this window. Made the change already?")} ${blue(`optimaizr apply ${ruleName} --done`)}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  // Claude Code and Codex habits have no request to replay, so no gate: the steps.
  const hit = data.events.filter(finding.affects);
  if (hit.length > 0 && hit.every((e) => e.source === "claude-code" || e.source === "codex")) {
    return printSteps(finding);
  }

  // The gate, resolved by the same function `verify` uses so they can't disagree.
  if (args.flags["accept-risk"] && verificationModeOf(finding) === "manual") {
    // Logged as well as stored: a manual sign-off belongs in the audit trail.
    logVerification(acceptRisk(ruleName, "Accepted via 'apply --accept-risk'."));
  }

  const resolved = resolveVerification(finding, readVerification(ruleName));

  if (!resolved.canApply) {
    console.log("");
    console.log(`  ${red(resolved.state)} ${bold(finding.title)}`);
    console.log("");
    for (const line of wrapText(resolved.headline, 70)) console.log(`  ${dim(line)}`);
    if (resolved.guidance) {
      console.log("");
      for (const line of wrapText(resolved.guidance, 70)) console.log(`  ${dim(line)}`);
    }
    console.log("");
    console.log(
      `    ${blue(`optimaizr verify ${ruleName}`)}${resolved.mode === "manual" ? dim("   (explains why no replay can settle this)") : ""}`,
    );
    console.log("");
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`  ${green(resolved.state)} ${dim(resolved.headline)}`);

  // Say so when `--accept-risk` had nothing to accept.
  if (args.flags["accept-risk"] && resolved.mode !== "manual") {
    console.log(
      `  ${dim(`--accept-risk ignored: this finding is ${resolved.state}, so there is no risk to accept.`)}`,
    );
  }

  console.log("");
  console.log(`  ${bold(finding.title)}`);
  console.log(
    `  ${green(`${usd(finding.savings.monthlyUsd)}/mo`)} ${dim("estimated,")} ${green(usd(finding.savings.annualUsd))}${dim("/yr")}`,
  );
  console.log("");
  console.log(`  ${bold("The change")}`);
  for (const line of wrapText(finding.fix, 68)) console.log(`    ${line}`);
  console.log("");

  if (finding.candidate?.kind === "swap-model" && finding.candidate.to) {
    const target = priceFor(finding.candidate.to);
    console.log(`  ${bold("Concretely")}`);
    console.log(`    ${dim("For calls matching this profile, set:")}`);
    console.log(
      `      ${blue(`model: "${finding.candidate.to}"`)}   ${dim(`(${target?.label ?? ""})`)}`,
    );
    console.log(
      `    ${dim(`Cap max_tokens at ${target?.maxOutputTokens.toLocaleString()} for this model.`)}`,
    );
    console.log("");
  }

  const outPath = path.resolve(process.cwd(), "optimaizr-change.md");
  const doc = [
    `# ${finding.title}`,
    "",
    `**Estimated saving:** ${usd(finding.savings.monthlyUsd)}/month, ${usd(finding.savings.annualUsd)}/year`,
    `**Confidence in the figure:** ${finding.savings.confidence} - ${finding.savings.confidenceBasis}`,
    `**Quality impact:** ${finding.impact}`,
    `**Affected:** ${finding.affected.calls} calls across ${finding.affected.models.join(", ")}`,
    "",
    "## What is happening",
    "",
    finding.detail,
    "",
    "## The change",
    "",
    finding.fix,
    "",
    "## How the number was calculated",
    "",
    finding.savings.calculation,
    "",
    "## Assumptions",
    "",
    ...finding.savings.assumptions.map((a: string) => `- ${a}`),
    "",
    "## Evidence",
    "",
    ...finding.observations.map((e: string) => `- ${e}`),
    "",
    "---",
    "",
    "_Estimates, not guarantees. Generated by optimAIzr._",
  ].join("\n");

  fs.writeFileSync(outPath, doc);
  console.log(`  ${green("Written")} ${dim(outPath)}`);
  console.log(
    `  ${dim("optimAIzr does not edit your code - review the change and apply it yourself.")}`,
  );
  console.log(
    `  ${dim("Once it is live:")} ${blue(`optimaizr apply ${ruleName} --done`)}${dim(", so optimaizr results can measure it.")}`,
  );
  console.log("");
}

/**
 * A change only you can make in Claude Code or Codex: the steps, and how to
 * tell optimAIzr once it is made.
 */
function printSteps(finding: ReturnType<typeof findWaste>[number]): void {
  const done = openChanges(finding.rule).find((c) => c.how === "by-hand");
  console.log("");
  console.log(`  ${bold(finding.title)}`);
  console.log(
    `  ${green(`${usd(finding.savings.monthlyUsd)}/mo`)} ${dim("estimated,")} ${green(usd(finding.savings.annualUsd))}${dim("/yr")}`,
  );
  console.log("");
  console.log(`  ${bold("What to do")}`);
  for (const line of wrapText(finding.fix, 68)) console.log(`    ${line}`);
  console.log("");
  if (done) {
    console.log(
      `  ${dim(`You recorded this as done on ${localDay(done.at)}. How it is going:`)} ${blue("optimaizr results")}`,
    );
  } else {
    console.log(
      `  ${dim("optimAIzr can't make this one for you: it is in how the agent is used.")}`,
    );
    console.log(
      `  ${dim("When it is done:")} ${blue(`optimaizr apply ${finding.rule} --done`)}${dim(", and optimaizr results measures it from then.")}`,
    );
  }
  console.log("");
}

/** Who a finding's calls came from, when that is one agent or one project. */
function scopeOf(data: Dataset, rule: string): Pick<ChangeEntry, "source" | "project"> {
  const finding = findWaste(data).find((f) => f.rule === rule);
  if (!finding) return {};
  const hit = data.events.filter(finding.affects);
  const sources = new Set(hit.map((e) => e.source));
  const projects = new Set(hit.map((e) => e.project));
  return {
    ...(sources.size === 1 ? { source: [...sources][0]! } : {}),
    ...(projects.size === 1 ? { project: [...projects][0]! } : {}),
  };
}

/**
 * `apply <rule> --done`: you made the change yourself, so it goes into the
 * change history from now. It changes nothing, so there is no gate.
 */
function recordDone(args: Args, rule: string, data: Dataset): void {
  console.log("");
  if (!isKnownRule(rule)) {
    console.log(`  ${red("No such rule:")} ${rule}`);
    console.log(`  ${dim("See the ones there are:")} ${blue("optimaizr apply")}`);
    console.log("");
    process.exitCode = 1;
    return;
  }
  let scope: Pick<ChangeEntry, "source" | "project" | "value"> = scopeOf(data, rule);
  if (rule === "context-compaction") {
    const tokens = args.flags.at === undefined ? COMPACT_AT : tokenCount(String(args.flags.at));
    if (!(tokens >= COMPACT_MIN && tokens <= COMPACT_MAX)) {
      console.log(`  ${red("--at takes a size from 100K to 1M,")} ${dim("like --at 400K")}`);
      console.log("");
      process.exitCode = 1;
      return;
    }
    const agent = typeof args.flags.agent === "string" ? args.flags.agent.toLowerCase() : null;
    const source = agent === "codex" ? "codex" : agent?.startsWith("claude") ? "claude-code" : null;
    scope = { ...(source ? { source } : {}), value: String(tokens) };
  }
  const at = new Date().toISOString();
  const entry: ChangeEntry = { kind: "record", rule, ...scope, at };
  const change = { id: "", how: "by-hand" as const, ...entry };
  const already = openChanges(rule).find(
    (c) =>
      (c.source ?? null) === (entry.source ?? null) &&
      (c.project ?? null) === (entry.project ?? null) &&
      (c.value ?? null) === (entry.value ?? null),
  );
  if (already) {
    console.log(
      `  ${dim("Already recorded:")} ${changeName(already)} ${dim(`since ${localDay(already.at)}.`)}`,
    );
    console.log(`  ${dim("How it is going:")} ${blue("optimaizr results")}`);
    console.log("");
    return;
  }
  recordChange(entry);
  console.log(`  ${green("Recorded")} ${changeName(change)} ${dim("as made today.")}`);
  printResultsHint(rule);
}

/**
 * Bare `optimaizr apply`: what optimAIzr changes for you and whether it is on,
 * then what you change yourself.
 */
function listLevers(data: Dataset): void {
  const inPlace = appliedChanges().filter((c) => !c.until);
  const doneOf = (rule: string) => inPlace.find((c) => c.rule === rule && c.how === "by-hand");
  const row = (name: string, state: string) => console.log(`    ${name.padEnd(24)}${state}`);
  const on = (what: string) => `${green("on ")}  ${what}`;
  const off = (cmd: string) => `${dim("off")}  ${blue(cmd)}`;

  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("|")} apply`);
  console.log("");
  console.log(`  ${bold("Changes optimAIzr makes for you")}`);
  const set = compactionStatus();
  const ours = compactionApplied();
  // Agents on the same point since the same day share one line.
  const points = new Map<string, string[]>();
  for (const a of ["claude-code", "codex"] as const) {
    if (!set[a]) continue;
    const since = inPlace.find((c) => c.rule === "context-compaction" && c.source === a);
    const k = `${Math.round((Number(set[a]) || COMPACT_AT) / 1000)}K`;
    const when = since ? `, since ${localDay(since.at)}` : ours.includes(a) ? "" : ", set by hand";
    const key = `at ${k}${when}`;
    points.set(key, [...(points.get(key) ?? []), a === "claude-code" ? "Claude Code" : "Codex"]);
  }
  row(
    "context-compaction",
    points.size > 0
      ? on([...points].map(([key, names]) => `${names.join(" and ")} ${key}`).join("; "))
      : off("optimaizr apply context-compaction"),
  );
  row("statusline", statuslineApplied() ? on("in Claude Code") : off("optimaizr apply statusline"));
  for (const o of readOverrides()) {
    row(o.rule, on(`${describeOverride(o)}, since ${localDay(o.at)}`));
  }
  console.log(`    ${dim("Undo any of them:")} ${blue("optimaizr undo <rule>")}`);
  console.log("");

  const findings = findWaste(data)
    .filter((f) => !f.advisory && f.rule !== "context-compaction" && isKnownRule(f.rule))
    .sort((a, b) => b.savings.monthlyUsd - a.savings.monthlyUsd);
  // Cents a month are noise here too; `recommend` lists everything.
  const shown = findings.filter((f) => doneOf(f.rule) || f.savings.monthlyUsd >= 0.25);
  // Recorded as done, though this window no longer finds anything for it.
  const recorded = inPlace.filter(
    (c) =>
      c.how === "by-hand" &&
      c.rule !== "context-compaction" &&
      !findings.some((f) => f.rule === c.rule),
  );
  console.log(`  ${bold("Changes you make yourself")}`);
  if (shown.length === 0 && recorded.length === 0) {
    console.log(`    ${dim("Nothing worth changing in this window.")}`);
  }
  for (const f of shown) {
    const done = doneOf(f.rule);
    const saves = `${usd(f.savings.monthlyUsd)}/mo`.padStart(11);
    row(
      f.rule,
      done
        ? `${green("done")} ${dim(`since ${localDay(done.at)}`)}`
        : `${ruleLabel(f.rule).padEnd(24)}${saves}`,
    );
  }
  for (const c of recorded) row(c.rule, `${green("done")} ${dim(`since ${localDay(c.at)}`)}`);
  if (findings.length > shown.length) {
    const n = findings.length - shown.length;
    console.log(`    ${dim(`+${n} smaller, under $0.25/mo each: optimaizr recommend`)}`);
  }
  console.log(
    `    ${dim("The steps for one:")} ${blue("optimaizr apply <rule>")}${dim(". Made it?")} ${blue("optimaizr apply <rule> --done")}`,
  );
  console.log("");
  console.log(`  ${dim("How each change is going:")} ${blue("optimaizr results")}`);
  console.log("");
}

/** `optimaizr show <rule>`: the requests a recommendation would touch. */
export async function cmdShow(args: Args): Promise<void> {
  const ruleName = args.positional[0];
  if (!ruleName) {
    console.log(`  ${red("usage:")} optimaizr show <rule>`);
    process.exitCode = 1;
    return;
  }

  const data = await load(args);
  const finding = findWaste(data).find((f) => f.rule === ruleName);
  if (!finding) {
    console.log(`  ${red("No such finding:")} ${ruleName}`);
    process.exitCode = 1;
    return;
  }

  // Every finding names its own traffic (`sampleEventIds` is capped at 20).
  const matched = data.events.filter(finding.affects);
  const shown = [...matched].sort((a, b) => b.cost.total - a.cost.total).slice(0, 20);

  if (args.flags.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("|")} requests affected by ${bold(ruleName)}`);
  console.log("");
  console.log(
    `  ${matched.length.toLocaleString()} matching requests${matched.length > shown.length ? dim(` (showing the ${shown.length} priciest)`) : ""}`,
  );
  console.log("");
  for (const e of shown) {
    const where = (e.route ?? projectName(e.project)).slice(0, 22);
    console.log(
      `    ${usd(e.cost.total).padStart(9)} ${dim("|")} ${modelLabel(e.model).padEnd(12)} ${dim(`${fmtTokens(e.inputTokens + e.cacheReadTokens)} in / ${e.outputTokens} out`.padEnd(22))} ${dim(where.padEnd(22))} ${dim(e.ts.slice(0, 16).replace("T", " "))}`,
    );
    // Which agent made the call and what it did, so parallel agents can be told apart.
    console.log(
      `              ${dim(`session ${callSession(e).padEnd(12)}`)} ${callActivity(e, 52)}`,
    );
  }
  console.log("");
  setStatus(ruleName, "viewed");
}

/**
 * `optimaizr simulate <rule>`: what the change would cost, from recorded
 * tokens. Says nothing about output quality; that's `verify`.
 */
export async function cmdSimulate(args: Args): Promise<void> {
  const ruleName = args.positional[0];
  if (!ruleName) {
    console.log(`  ${red("usage:")} optimaizr simulate <rule>`);
    process.exitCode = 1;
    return;
  }

  const data = await load(args);
  const findings = findWaste(data);
  const finding = findings.find((f) => f.rule === ruleName);
  if (!finding) {
    console.log(`  ${red("No such finding:")} ${ruleName}`);
    process.exitCode = 1;
    return;
  }

  const rec = toRecommendations(findings, data.events.length).find((r) => r.id === ruleName);
  if (!rec) {
    console.log("");
    console.log(`  ${yellow("That finding is an advisory - there is nothing to simulate.")}`);
    console.log("");
    return;
  }

  const sim = simulate(rec, finding, data.events, projectionDays(data));
  if (args.flags.json) {
    console.log(JSON.stringify(sim, null, 2));
    return;
  }

  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| simulation")}`);
  console.log("");
  console.log(`  ${bold(sim.action)}`);
  console.log("");
  console.log(
    `  ${dim("matched")}      ${sim.matchedCalls.toLocaleString()} requests in the window`,
  );
  if (sim.stale) {
    // Figures with no traffic under them aren't a result, so say so first.
    console.log(
      `  ${red("no matching traffic")} ${dim("- the figures below come from the finding, not from this window")}`,
    );
  }
  console.log(
    `  ${dim("window")}       ${usd(sim.currentUsd)} ${dim("->")} ${usd(sim.simulatedUsd)}`,
  );
  console.log(
    `  ${dim("projected")}    ${green(`${usd(sim.monthlySaving)}/month`)} ${dim("|")} ${green(`${usd(sim.annualSaving)}/year`)}`,
  );
  console.log("");
  if (sim.shifts.length) {
    console.log(`  ${bold("Per model")}`);
    for (const sh of sim.shifts) {
      console.log(
        `    ${modelLabel(sh.model).padEnd(14)} ${dim(`${sh.calls} calls`.padEnd(12))} ${usd(sh.from)} ${dim("->")} ${usd(sh.to)}`,
      );
    }
    console.log("");
  }
  for (const line of wrapText(sim.caveat, 68)) console.log(`  ${yellow(line)}`);
  console.log("");
  setStatus(ruleName, "simulated");
  if (sim.stale) process.exitCode = 1;
}

/** "400K", "0.4M" or "400000" -> 400000; NaN when it is not a size. */
function tokenCount(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(v.trim());
  if (!m) return NaN;
  const unit = m[2]!.toLowerCase() === "m" ? 1_000_000 : m[2] ? 1_000 : 1;
  return Math.round(Number(m[1]) * unit);
}

/** Where `--at` may put it: the range Claude Code's setting accepts. */
const COMPACT_MIN = 100_000;
const COMPACT_MAX = 1_000_000;

/** 200000 -> "200K", 1050000 -> "1050K", as the setting is written. */
const kLabel = (n: number): string => `${Math.round(n / 1000)}K`;

/**
 * The models an agent's main conversations used, most calls first, with each
 * one's context window when the catalogue knows it.
 */
function modelsOf(events: CallEvent[], agent: CompactAgent): { label: string; window?: number }[] {
  const calls = new Map<string, { label: string; window?: number; n: number }>();
  for (const e of events) {
    if (e.source !== agent || e.isSubagent || e.model.startsWith("<")) continue;
    const label = modelLabel(e.model);
    const seen = calls.get(label) ?? { label, window: priceFor(e.model)?.contextTokens, n: 0 };
    seen.n++;
    calls.set(label, seen);
  }
  return [...calls.values()]
    .sort((a, b) => b.n - a.n)
    .map(({ label, window }) => ({ label, window }));
}

/**
 * `optimaizr apply context-compaction`: have Claude Code and/or Codex compact
 * at COMPACT_AT, or at `--at 400K`. `--agent claude` or `--agent codex` narrows
 * it; by default it covers whichever agents appear in the usage.
 */
function applyCompactionLever(args: Args, events: CallEvent[]): void {
  const atFlag = args.flags.at;
  const tokens = atFlag === undefined ? COMPACT_AT : tokenCount(String(atFlag));
  if (!(tokens >= COMPACT_MIN && tokens <= COMPACT_MAX)) {
    console.log("");
    console.log(`  ${red("--at takes a size from 100K to 1M,")} ${dim("like --at 400K")}`);
    console.log("");
    process.exitCode = 1;
    return;
  }
  const want = typeof args.flags.agent === "string" ? args.flags.agent.toLowerCase() : null;
  const seen = (a: CompactAgent) => events.some((e) => e.source === a);
  const agents: CompactAgent[] =
    want === "claude" || want === "claude-code"
      ? ["claude-code"]
      : want === "codex"
        ? ["codex"]
        : (["claude-code", "codex"] as const).filter(seen);
  console.log("");
  if (agents.length === 0) {
    console.log(`  ${dim("No Claude Code or Codex usage found, so there is nothing to set.")}`);
    console.log(`  ${dim("Pick one with --agent claude or --agent codex.")}`);
    console.log("");
    return;
  }
  // The agent compacts as the model's own window fills, so a point at or past
  // that window changes nothing for it. Only the models in use are judged.
  const notes: string[] = [];
  const settable: CompactAgent[] = [];
  for (const agent of agents) {
    const models = modelsOf(events, agent);
    const full = models.filter((m) => m.window !== undefined && m.window <= tokens);
    if (full.length === 0) {
      settable.push(agent);
      continue;
    }
    const window = full[0]!.window!;
    const fills =
      full.length === 1
        ? `${full[0]!.label} compacts as its ${kLabel(window)} window fills either way`
        : `${full.map((m) => m.label).join(" and ")} compact as their windows fill either way`;
    if (full.length < models.length) {
      const rest = models.filter((m) => !full.includes(m)).map((m) => m.label);
      notes.push(`${fills}, so this changes ${rest.join(" and ")} only.`);
      settable.push(agent);
      continue;
    }
    const name = agent === "claude-code" ? "Claude Code" : "Codex";
    const said = `${fills}, so compacting at ${kLabel(tokens)} changes nothing there. ${name} was left as it is.`;
    for (const line of wrapText(said, 68)) console.log(`  ${line}`);
    const below = Math.max(COMPACT_MIN, Math.round((window * 0.75) / 10_000) * 10_000);
    if (below < window) {
      const only =
        agents.length > 1 ? ` --agent ${agent === "claude-code" ? "claude" : "codex"}` : "";
      console.log(`  ${dim("To compact earlier, pick a point below the window:")}`);
      console.log(`    ${blue(`optimaizr apply context-compaction${only} --at ${kLabel(below)}`)}`);
    }
    if (agent === "claude-code") {
      const room =
        "A compacted conversation starts again from what loads before your first message, so check /context first: a heavy start leaves little room.";
      for (const line of wrapText(room, 68)) console.log(`  ${dim(line)}`);
    }
    console.log("");
  }
  if (settable.length === 0) return;
  if (args.flags["dry-run"]) {
    const early = settable.includes("claude-code")
      ? " Claude Code compacts a little before that point."
      : "";
    console.log(
      `  ${dim(`Dry run: would set ${settable.join(" and ")} to compact at ${tokens}.${early}`)}`,
    );
    for (const note of notes) console.log(`  ${dim(note)}`);
    console.log("");
    return;
  }
  for (const r of applyCompaction(settable, { tokens })) {
    console.log(`  ${r.ok ? green("Applied") : red("Could not apply")} ${r.detail}`);
  }
  for (const note of notes) console.log(`  ${dim(note)}`);
  console.log("");
  console.log(`  ${dim("A summary can drop details from early in a long conversation.")}`);
  printResultsHint("context-compaction");
}

/** After any change: when there will be enough to judge it, and the command that does. */
export function printResultsHint(rule: string, undo = true): void {
  const first = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  console.log(
    `  ${dim(`Check how it's going from ${monthDay(first)}:`)} ${blue("optimaizr results")}${undo ? `${dim(". Undo:")} ${blue(`optimaizr undo ${rule}`)}` : ""}`,
  );
  console.log("");
}
