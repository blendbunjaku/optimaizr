import { modelLabel, usd, tokens as fmtTokens } from "../pricing.js";
import { verificationModeOf } from "../verify/state.js";
import { likelyMonthly, recoverableAnnual, recoverableMonthly } from "../analyze/rules.js";
import type {
  ConfidenceLevel,
  EvidenceClass,
  FindingTier,
  OptimizationFinding,
  Recommendation,
  UsageEvent,
} from "../domain/types.js";
import type { Summary, TopCall } from "../analyze/summary.js";
import type { DrillNode, DrillTree } from "../analyze/drilldown.js";
import type { Profile } from "../analyze/profile.js";
import type { FiveHourWindows, SessionStats, StartFacts } from "../analyze/sessions.js";
import { type ConversationRow, windowShareLabel, workLabel } from "../analyze/conversations.js";
import type { WriteCause } from "../analyze/writes.js";
import type { BudgetCrossing, BudgetStatus } from "../analyze/budget.js";
import type { PlanView, SessionCrossing } from "../analyze/plan.js";
import type { CodexLimitCrossing, CodexPlanView } from "../analyze/codex-plan.js";
import type { CacheState } from "../analyze/cache-watch.js";
import { type ColdResume, waitedOn } from "../analyze/cold.js";
import type { LiveChecks, LiveStep } from "../analyze/checks.js";
import type { GuardReceipt } from "../analyze/guard.js";
import { compactPointOf } from "../analyze/results.js";
import type { AppliedChange, ChangeResult, ResultRow, ResultsReport } from "../analyze/results.js";

/** Terminal rendering. No dependencies; colour is disabled when not a TTY or NO_COLOR is set. */

const ESC = String.fromCharCode(27);
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c =
  (code: string) =>
  (s: string | number): string =>
    useColor ? `${ESC}[${code}m${s}${ESC}[0m` : String(s);

export const dim = c("2");
export const bold = c("1");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const blue = c("36");
export const magenta = c("35");

// Colours that mean nothing else here, so a name's colour only says which conversation.
const NAME_COLORS = ["36", "35", "34", "96", "95", "94"].map(c);

/** One colour per conversation, the same each time it shows. */
export function convoColor(sessionId: string): (s: string | number) => string {
  let h = 0;
  for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length]!;
}

/** How wide a conversation's name is in live, so the numbers after it line up. */
export const NAME_WIDTH = 32;

/** A conversation's title, or its short id and folder until it has one. */
export function convoName(sessionId: string, project: string, title?: string): string {
  return title ?? `${sessionId.slice(0, 8)} ${projectName(project)}`;
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function rule(width = 66): string {
  return dim("-".repeat(width));
}

function visible(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - visible(s)));
}

function padLeft(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - visible(s))) + s;
}

function bar(value: number, max: number, width = 18): string {
  if (max <= 0) return dim(".".repeat(width));
  const filled = Math.max(1, Math.round((value / max) * width));
  return blue("#".repeat(Math.min(width, filled))) + dim(".".repeat(Math.max(0, width - filled)));
}

const IMPACT: Record<OptimizationFinding["impact"], string> = {
  none: green("none"),
  low: green("low"),
  medium: yellow("medium"),
  high: red("high"),
};

/** Evidence badges, so a projection is never mistaken for a bill. */
const EVIDENCE: Record<EvidenceClass, string> = {
  measured: green("measured"),
  inferred: yellow("inferred"),
  estimated: magenta("estimated"),
};

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** How sure a figure is, in words. A bar or percentage would imply calibration it doesn't have. */
export const CONFIDENCE_WORD: Record<ConfidenceLevel, string> = {
  high: "high confidence",
  medium: "likely",
  low: "possible",
};

function confidenceTag(level: ConfidenceLevel): string {
  const colour = level === "high" ? green : level === "medium" ? yellow : red;
  return colour(CONFIDENCE_WORD[level]);
}

/** What kind of move a finding asks for. */
const TIER_TAG: Record<FindingTier, string> = {
  fix: green("FIX "),
  try: yellow("TRY "),
  test: blue("TEST"),
};

/** A figure for its tier: a lever is only ever "up to". */
function monthlyOf(tier: FindingTier, monthlyUsd: number): string {
  return tier === "test" ? `up to ${usd(monthlyUsd)}/mo` : `${usd(monthlyUsd)}/mo`;
}

/** What happened, why it matters, what to do: the three lines every recommendation answers. */
function story(
  parts: { happened: string; why: string; fix: string },
  indent: string,
  width = 54,
): string[] {
  const out: string[] = [];
  const rows: Array<[string, string]> = [
    ["What happened", parts.happened],
    ["Why it matters", parts.why],
    ["What to do", parts.fix],
  ];
  for (const [label, text] of rows) {
    const lines = wrap(text, width);
    out.push(`${indent}${dim(pad(label, 16))}${lines[0] ?? ""}`);
    for (const line of lines.slice(1)) out.push(`${indent}${" ".repeat(16)}${line}`);
  }
  return out;
}

/** The three tiers, never added together: clear waste, likely savings, and each lever on its own. */
function tierLines(totals: { fix: number; try: number }, levers: OptimizationFinding[]): string[] {
  const out: string[] = [];
  out.push(
    `  ${dim(pad("Clear waste", 16))}${bold(green(padLeft(`${usd(totals.fix)}/mo`, 17)))}  ${dim("each call counted once: fix it, nothing to lose")}`,
  );
  if (totals.try > 0.005) {
    out.push(
      `  ${dim(pad("Likely savings", 16))}${yellow(padLeft(`+${usd(totals.try)}/mo`, 17))}  ${dim("if you try the changes marked TRY")}`,
    );
  }
  levers.forEach((f, i) => {
    out.push(
      `  ${dim(pad(i === 0 ? "Worth testing" : "", 16))}${blue(padLeft(monthlyOf("test", f.savings.monthlyUsd), 17))}  ${dim(RULE_LABEL[f.rule] ?? f.rule)}`,
    );
  });
  return out;
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/** What the total leaves out or took from elsewhere: models with no price here. */
export function pricingGaps(s: Pick<Summary, "unpriced" | "stated">): string[] {
  const out: string[] = [];
  if (s.unpriced.calls > 0) {
    const shown = s.unpriced.models.slice(0, 2).join(", ");
    const more = s.unpriced.models.length > 2 ? ` and ${s.unpriced.models.length - 2} more` : "";
    out.push(
      `  ${yellow(`${plural(s.unpriced.calls, "call")} counted as $0`)} ${dim(`on ${shown}${more}: no price here.`)}`,
    );
    out.push(`  ${dim("Add one in ~/.optimaizr/models.json and they count.")}`);
  }
  if (s.stated.calls > 0) {
    out.push(
      `  ${dim(`${plural(s.stated.calls, "call")} on models with no price here ${s.stated.calls === 1 ? "uses" : "use"} opencode's own cost: ${usd(s.stated.usd)}.`)}`,
    );
  }
  return out;
}

export function renderSummary(s: Summary, opts: { title?: string } = {}): string {
  const out: string[] = [];
  const days = Math.max(1, s.window.days || 1);

  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("|")} ${opts.title ?? "spend report"}`);
  out.push(
    `  ${dim(
      `${s.windowDays.from} to ${s.windowDays.to}  (${days.toFixed(1)} days, ${s.calls.toLocaleString()} calls, days in ${s.dayTimeZone})`,
    )}`,
  );
  out.push("");
  out.push(
    `  ${bold(usd(s.totalCost))} ${dim("est. API-equivalent")}   ${dim("|")}   ${bold(usd(s.perMonth))}${dim("/month")}   ${dim("|")}   ${bold(usd(s.perMonth * 12))}${dim(s.pace === "last-30-days" ? "/year at the last 30 days' rate" : "/year at this rate")}`,
  );
  out.push(`  ${dim("Published list rates applied to recorded tokens. Not a bill, and not your")}`);
  out.push(`  ${dim("Claude subscription or plan meter; those count usage differently.")}`);
  out.push(...pricingGaps(s));
  out.push("");

  const inputSide = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  out.push(
    `  ${dim("tokens in ")} ${pad(fmtTokens(inputSide), 9)} ${dim(
      `(${fmtTokens(s.cacheReadTokens)} cached, ${(s.cacheHitRate * 100).toFixed(0)}% hit rate)`,
    )}`,
  );
  out.push(
    `  ${dim("tokens out")} ${pad(fmtTokens(s.outputTokens), 9)} ${dim(
      s.thinkingTokens > 0
        ? `(${fmtTokens(s.thinkingTokens)} reasoning, ${(s.thinkingShare * 100).toFixed(0)}% of output spend)`
        : "",
    )}`,
  );
  // Cache writes by TTL (1h bills 2x input, 5m 1.25x): the line item other
  // tools most often price differently.
  const writes = s.cacheWrite5mTokens + s.cacheWrite1hTokens;
  if (writes > 0) {
    const share1h = (s.cacheWrite1hTokens / writes) * 100;
    out.push(
      `  ${dim("cache wr  ")} ${pad(fmtTokens(writes), 9)} ${dim(
        `(${fmtTokens(s.cacheWrite1hTokens)} @1h bills 2x, ${fmtTokens(s.cacheWrite5mTokens)} @5m bills 1.25x; ${share1h.toFixed(0)}% at 1h)`,
      )}`,
    );
  }
  // Per-request tool charges appear in no token count, so show them to make the total add up.
  if (s.webSearches > 0) {
    out.push(
      `  ${dim("web search")} ${pad(s.webSearches.toLocaleString(), 9)} ${dim(
        `(${usd(s.cost.serverTools)} at $10 per 1,000, billed per search, not per token)`,
      )}`,
    );
  }
  out.push(
    `  ${dim("per call  ")} ${pad(fmtTokens(s.avgTokensPerCall), 9)} ${dim(`(${usd(s.avgCostPerCall)} average)`)}`,
  );
  if (s.latency) {
    out.push(
      `  ${dim("latency   ")} ${pad(`${(s.latency.p50 / 1000).toFixed(1)}s`, 9)} ${dim(
        `p50 | ${(s.latency.p95 / 1000).toFixed(1)}s p95`,
      )}`,
    );
  }
  out.push("");

  const section = (title: string, rows: Array<[string, number, number]>) => {
    if (rows.length === 0) return;
    out.push(`  ${bold(title)}`);
    const max = Math.max(...rows.map((r) => r[1]));
    for (const [name, cost, calls] of rows.slice(0, 6)) {
      const share = s.totalCost > 0 ? (cost / s.totalCost) * 100 : 0;
      out.push(
        `  ${pad(name.slice(0, 22), 22)} ${bar(cost, max)} ${padLeft(usd(cost), 9)} ${dim(padLeft(`${share.toFixed(0)}%`, 4))} ${dim(`${calls} calls`)}`,
      );
    }
    out.push("");
  };

  if (s.byProvider.length > 1) {
    section(
      "By provider",
      s.byProvider.map((b) => [b.key, b.cost.total, b.calls] as [string, number, number]),
    );
  }
  section(
    "By model",
    s.byModel.map((b) => [modelLabel(b.key), b.cost.total, b.calls] as [string, number, number]),
  );
  if (s.byProject.length > 1) {
    section(
      "By project",
      s.byProject.map(
        (b) =>
          [b.key.split("/").slice(-1)[0] || b.key, b.cost.total, b.calls] as [
            string,
            number,
            number,
          ],
      ),
    );
  }

  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Drill-down
 * ------------------------------------------------------------------ */

function drillLines(nodes: DrillNode[], depth: number, maxDepth: number, out: string[]): void {
  if (depth > maxDepth) return;
  const indent = "  ".repeat(depth + 1);
  for (const node of nodes) {
    const arrow = depth === 0 ? "" : dim("-> ");
    const share = `${(node.shareOfParent * 100).toFixed(0)}%`;
    const name = depth >= 3 ? dim(node.label) : node.label;
    out.push(
      `  ${indent}${arrow}${pad(name, Math.max(10, 30 - depth * 2))} ${padLeft(bold(usd(node.costUsd)), 10)} ${dim(padLeft(share, 5))} ${dim(node.level === "request" ? `${fmtTokens(node.tokens)} tok` : `${node.calls} calls`)}`,
    );
    if (node.children.length && depth < maxDepth) {
      drillLines(node.children, depth + 1, maxDepth, out);
    }
  }
}

export function renderDrilldown(
  tree: DrillTree,
  opts: { depth?: number; title?: string } = {},
): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("|")} ${opts.title ?? "why am I spending so much?"}`);
  out.push("");
  out.push(
    `  ${bold(usd(tree.totalUsd))} ${dim("total")}  ${dim(`across ${tree.totalCalls.toLocaleString()} requests`)}`,
  );
  out.push("");
  drillLines(tree.children, 0, opts.depth ?? 3, out);
  out.push("");
  out.push(`  ${dim("Percentages are share of the line above.")}`);
  out.push(
    `  ${dim("Narrow with")} ${blue("optimaizr why <provider> <model> <project>")} ${dim("or --depth N")}`,
  );
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Findings
 * ------------------------------------------------------------------ */

function renderFinding(f: OptimizationFinding, opts: { verbose: boolean }): string[] {
  const out: string[] = [];
  const s = f.savings;
  // Use the verification mode, not `risk`: a fix that changes output but can't
  // be replayed has nothing for `verify` to run.
  const mode = verificationModeOf(f);
  const gate =
    f.tier === "test"
      ? blue("test it, then compare")
      : mode === "not-required"
        ? green("safe to apply")
        : mode === "replay"
          ? magenta("needs verification")
          : f.tier === "fix"
            ? green("a change in habit")
            : magenta("needs your sign-off");

  out.push(
    `  ${TIER_TAG[f.tier]}  ${bold(RULE_LABEL[f.rule] ?? f.title)} ${dim("·")} ${confidenceTag(s.confidence)}`,
  );
  out.push(
    `        ${bold(green(monthlyOf(f.tier, s.monthlyUsd)))} ${dim("|")} ${green(usd(s.annualUsd))}${dim("/yr")} ${dim("|")} ${gate} ${dim("|")} ${dim(f.category)}`,
  );
  out.push("");
  out.push(...story({ happened: f.title, why: f.why, fix: f.fix }, "        "));
  out.push("");
  out.push(
    `        ${dim("now")} ${padLeft(usd(s.currentUsd), 9)}  ${dim("->")}  ${dim("after")} ${padLeft(usd(s.optimizedUsd), 9)}  ${dim(`(${f.affected.calls} calls, ${(f.affected.share * 100).toFixed(0)}% of spend)`)}  ${dim("basis")} ${EVIDENCE[s.evidence.kind]}`,
  );
  for (const e of f.observations.slice(0, 4)) out.push(`        ${dim("-")} ${dim(e)}`);

  if (opts.verbose) {
    out.push("");
    for (const line of wrap(f.detail, 70)) out.push(`        ${dim(line)}`);
    out.push("");
    out.push(`        ${dim(`Evidence: ${s.evidence.kind} - ${s.evidence.basis}`)}`);
    out.push(`        ${dim(`Impact on output: ${f.impact}`)}`);
    out.push("");
    out.push(`        ${dim("How this was calculated")}`);
    for (const line of wrap(s.calculation, 70)) out.push(`          ${dim(line)}`);
    out.push("");
    out.push(`        ${dim("Assumptions")}`);
    for (const a of s.assumptions) {
      const lines = wrap(a, 68);
      out.push(`          ${dim("*")} ${dim(lines[0] ?? "")}`);
      for (const line of lines.slice(1)) out.push(`            ${dim(line)}`);
    }
    out.push("");
    out.push(`        ${dim(`Confidence basis: ${s.confidenceBasis}`)}`);
  }

  return out;
}

const TIER_HEADING: Record<FindingTier, string> = {
  fix: "Fix: clear waste, nothing to lose",
  try: "Try: likely savings that change what the model does",
  test: 'Test: trade-offs sized from your usage, shown as "up to"',
};

export function renderFindings(
  findings: OptimizationFinding[],
  summary: Summary,
  opts: { verbose?: boolean } = {},
): string {
  const out: string[] = [];
  const verbose = opts.verbose ?? false;

  if (findings.length === 0) {
    out.push(`  ${green("No savings opportunities found above the reporting threshold.")}`);
    out.push("");
    return out.join("\n");
  }

  const actionable = findings.filter((f) => !f.advisory);
  const advisories = findings.filter((f) => f.advisory);
  const fix = recoverableMonthly(findings, "fix");
  const share = summary.perMonth > 0 ? (fix / summary.perMonth) * 100 : 0;

  out.push(rule());
  out.push("");
  out.push(
    ...tierLines(
      { fix, try: likelyMonthly(findings) },
      actionable.filter((f) => f.tier === "test"),
    ),
  );
  out.push("");
  out.push(
    `  ${dim(`Clear waste is ${share.toFixed(0)}% of your projected spend (${usd(recoverableAnnual(findings))}/year). Estimates, each labelled`)}`,
  );
  out.push(
    `  ${EVIDENCE.measured}${dim(",")} ${EVIDENCE.inferred} ${dim("or")} ${EVIDENCE.estimated}${dim(". Run with --why for every calculation.")}`,
  );

  for (const tier of ["fix", "try", "test"] as const) {
    const group = actionable.filter((f) => f.tier === tier);
    if (group.length === 0) continue;
    out.push("");
    out.push(rule());
    out.push("");
    out.push(`  ${bold(TIER_HEADING[tier])}`);
    for (const f of group) {
      out.push("");
      out.push(...renderFinding(f, { verbose }));
    }
  }

  if (advisories.length > 0) {
    out.push("");
    out.push(rule());
    out.push("");
    out.push(`  ${bold("Worth knowing")} ${dim("- real, but not something you can cut")}`);
    out.push("");
    advisories.forEach((f, i) => {
      out.push(`  ${yellow("NOTE")}    ${bold(f.title)}`);
      out.push(
        `          ${bold(yellow(`${usd(f.savings.monthlyUsd)}/mo`))} ${dim("|")} ${dim(f.rule)} ${dim("|")} ${dim("basis")} ${EVIDENCE[f.savings.evidence.kind]}`,
      );
      out.push("");
      for (const line of wrap(f.detail, 72)) out.push(`          ${dim(line)}`);
      out.push("");
      for (const e of f.observations.slice(0, 3)) out.push(`          ${dim("-")} ${e}`);
      out.push("");
      for (const line of wrap(f.fix, 72)) out.push(`          ${green(">")} ${line}`);
      if (i < advisories.length - 1) out.push("");
    });
  }

  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Recommendations
 * ------------------------------------------------------------------ */

const STATUS_TAG: Record<Recommendation["status"], string> = {
  new: dim("new"),
  viewed: dim("viewed"),
  simulated: blue("simulated"),
  verified: green("verified"),
  rejected: red("rejected"),
  applied: green("applied"),
};

export function renderRecommendations(
  recs: Recommendation[],
  monthlySpend: number,
  /** De-overlapped totals per tier; without them each tier is summed as listed. */
  totals?: { fix: number; try: number },
): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("| recommendations")}`);
  out.push("");

  if (recs.length === 0) {
    out.push(`  ${green("Nothing to recommend - no recoverable waste found.")}`);
    out.push("");
    return out.join("\n");
  }

  const sum = (tier: FindingTier) =>
    recs.filter((r) => r.tier === tier).reduce((s, r) => s + r.savings.monthlyUsd, 0);
  const fix = totals?.fix ?? sum("fix");
  const likely = totals?.try ?? sum("try");
  const levers = recs.filter((r) => r.tier === "test");
  const share = monthlySpend > 0 ? (fix / monthlySpend) * 100 : 0;
  out.push(
    `  ${bold(green(usd(fix)))}${bold("/month")} ${dim(`of clear waste - ${share.toFixed(0)}% of spend`)}${likely > 0.005 ? ` ${dim("·")} ${yellow(`+${usd(likely)}/mo`)} ${dim("likely if you try")}` : ""}`,
  );
  for (const r of levers) {
    out.push(
      `  ${blue(monthlyOf("test", r.savings.monthlyUsd))} ${dim(`worth testing: ${RULE_LABEL[r.rule] ?? r.rule}`)}`,
    );
  }
  out.push("");

  recs.forEach((r, i) => {
    out.push(
      `  ${bold(`${i + 1}. ${r.action}`)}  ${TIER_TAG[r.tier]} ${dim("·")} ${confidenceTag(r.savings.confidence)}  ${STATUS_TAG[r.status]}`,
    );
    out.push("");
    out.push(...story(r, "     "));
    out.push("");
    out.push(
      `     ${dim("Saves")} ${bold(green(monthlyOf(r.tier, r.savings.monthlyUsd)))} ${dim(`(${usd(r.savings.annualUsd)}/year) · ${r.affected.calls.toLocaleString()} requests on ${r.affected.models.map(modelLabel).join(", ")} · impact ${r.impact}`)}`,
    );
    const cta: string[] = [];
    if (r.actions.includes("view-affected")) cta.push(blue(`optimaizr show ${r.id}`));
    if (r.actions.includes("simulate")) cta.push(blue(`optimaizr simulate ${r.id}`));
    if (r.actions.includes("verify")) cta.push(blue(`optimaizr verify ${r.id}`));
    out.push(`     ${cta.join(dim("  |  "))}`);
    if (i < recs.length - 1) {
      out.push("");
      out.push(`  ${rule(62)}`);
      out.push("");
    }
  });

  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

function renderTopCalls(list: TopCall[], label: string, metric: "cost" | "tokens"): string {
  const out: string[] = [];
  out.push(`  ${bold(label)}`);
  for (const t of list.slice(0, 5)) {
    const value = metric === "cost" ? usd(t.costUsd) : fmtTokens(t.totalTokens);
    const other = metric === "cost" ? `${fmtTokens(t.totalTokens)} tok` : usd(t.costUsd);
    const where = t.route ?? t.project.split("/").slice(-1)[0] ?? t.project;
    out.push(
      `    ${padLeft(value, 9)} ${dim("|")} ${pad(modelLabel(t.model), 12)} ${dim(pad(other, 11))} ${dim(where.slice(0, 24))} ${dim(t.ts.slice(0, 10))}`,
    );
  }
  out.push("");
  return out.join("\n");
}

export function renderAnalytics(s: Summary): string {
  const out: string[] = [];
  out.push(rule());
  out.push("");
  out.push(`  ${bold("Token analytics")}`);
  out.push("");
  out.push(
    `  ${dim("total")} ${pad(fmtTokens(s.totalTokens), 8)} ${dim("in")} ${pad(fmtTokens(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens), 8)} ${dim("out")} ${pad(fmtTokens(s.outputTokens), 8)} ${dim("cached")} ${fmtTokens(s.cacheReadTokens)}`,
  );
  out.push("");
  out.push(renderTopCalls(s.topByCost, "Most expensive calls", "cost"));
  out.push(renderTopCalls(s.topByTokens, "Largest calls by tokens", "tokens"));
  return out.join("\n");
}

export function renderNextSteps(findings: OptimizationFinding[]): string {
  // Split by how the quality question can be settled, so nobody is sent to
  // `verify` for a finding no replay can decide.
  const needsReplay = findings.filter((f) => verificationModeOf(f) === "replay");
  const needsSignOff = findings.filter((f) => verificationModeOf(f) === "manual");
  const out: string[] = [];
  out.push(rule());
  out.push("");
  if (needsReplay.length > 0) {
    out.push(`  ${bold("Next")}`);
    out.push(`  ${dim("These can change model behaviour, so optimAIzr will not recommend")}`);
    out.push(`  ${dim("applying them until they clear your quality bar on your own traffic:")}`);
    out.push("");
    for (const f of needsReplay) {
      out.push(
        `    ${blue(`optimaizr verify ${f.rule}`)}   ${dim(`- ${usd(f.savings.monthlyUsd)}/mo at stake, ${IMPACT[f.impact]} impact`)}`,
      );
    }
    out.push("");
  }
  if (needsSignOff.length > 0) {
    out.push(`  ${bold("Needs your judgement")}`);
    out.push(`  ${dim("These can change behaviour too, but the fix is architectural - there is")}`);
    out.push(`  ${dim("no request rewrite to replay, so you have to decide on the evidence:")}`);
    out.push("");
    for (const f of needsSignOff) {
      out.push(
        `    ${blue(`optimaizr simulate ${f.rule}`)}   ${dim(`- ${usd(f.savings.monthlyUsd)}/mo at stake, ${IMPACT[f.impact]} impact`)}`,
      );
    }
    out.push("");
  }
  out.push(`  ${dim("optimaizr why          drill into where the money goes")}`);
  out.push(`  ${dim("optimaizr recommend    ranked actions with confidence and impact")}`);
  out.push(`  ${dim("optimaizr report       a shareable savings report")}`);
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Profile
 * ------------------------------------------------------------------ */

/** Short names for a ranked list, where a finding's full title will not fit. */
const RULE_LABEL: Record<string, string> = {
  "oversized-input": "Oversized context",
  "model-fit": "Model mismatch",
  "repeat-tool-calls": "Repeated tool reads",
  "cache-churn": "Cache misses",
  "repeated-context": "Repeated context",
  "prompt-bloat": "Prompt bloat",
  "oversized-output": "Oversized output",
  "oversized-tool-output": "Oversized tool output",
  "error-loops": "Error loops",
  "reasoning-effort": "Excess reasoning",
  "context-compaction": "Compact earlier",
  "cold-resume": "Cold cache returns",
  "heavy-start": "Heavy start",
  "model-default": "Smaller default model",
};

export function ruleLabel(rule: string): string {
  return RULE_LABEL[rule] ?? rule;
}

/** A rule optimAIzr has a name for, whether or not this window found anything for it. */
export function isKnownRule(rule: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULE_LABEL, rule);
}

/** A share of spend as a plain bar: no warning colours, it's a breakdown. */
function shareBar(share: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return blue("█".repeat(filled)) + dim("░".repeat(width - filled));
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Below this a month, an opportunity is folded into "+N smaller" on the profile. */
const WORTH_LISTING_USD = 0.25;

export function renderProfile(
  p: Profile,
  opts: { week?: string | null; kept?: string | null } = {},
): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("|")} profile`);
  out.push(
    `  ${dim(`${p.windowDays.from} to ${p.windowDays.to}  (${Math.max(1, p.window.days).toFixed(1)} days)`)}`,
  );
  out.push("");
  out.push(rule());
  out.push("");

  // What you changed comes first, so a second run starts where the first left off.
  if (p.applied.length > 0) out.push(...renderApplied(p.applied), "");
  // The week in a line, and what guard kept: the reason to come back on a Monday.
  if (opts.week || opts.kept) {
    if (opts.week) {
      for (const line of wrap(`Last 7 days: ${opts.week}.`, 76)) out.push(`  ${dim(line)}`);
    }
    if (opts.kept) out.push(`  ${dim("Guard:")} ${green(opts.kept)} ${dim("in the last 7 days.")}`);
    out.push("");
  }
  if (p.firstLook) {
    for (const line of wrap(p.firstLook.fact, 70)) out.push(`  ${bold(line)}`);
    out.push(`  ${dim("Start here:")} ${blue(p.firstLook.command)}   ${dim(p.firstLook.why)}`);
    out.push("");
  }

  // The headline: what the plan is worth, else what the usage costs.
  const multiple = (m: number) => `${m >= 10 ? Math.round(m) : m.toFixed(1)}x`;
  const codexPriced = p.codex?.priceUsd && p.codex.multiple !== null ? p.codex : null;
  // A plan with no Claude Code calls behind it would headline $0 of work.
  const claudePlan = p.plan && p.plan.calls > 0 ? p.plan : null;
  if (claudePlan) {
    out.push(
      `  Your ${bold(claudePlan.label)} did ${bold(green(`${usd(claudePlan.valueMonthlyUsd)}/mo`))} of work at API prices: ${bold(green(multiple(claudePlan.multiple)))} what you pay`,
    );
  } else if (codexPriced) {
    out.push(
      `  Your ${bold(codexPriced.label)} did ${bold(green(`${usd(codexPriced.valueMonthlyUsd)}/mo`))} of work at API prices: ${bold(green(multiple(codexPriced.multiple!)))} what you pay`,
    );
  } else {
    out.push(
      `  You use ${bold(`${usd(p.perMonthUsd)}/mo`)} of AI at list prices ${dim(p.pace === "last-30-days" ? "(the last 30 days' rate)" : "(at this rate)")}`,
    );
  }
  out.push(
    `  ${dim(`${usd(p.spendUsd)} in this window · ${p.calls.toLocaleString()} calls · ${fmtTokens(p.tokens.total)} tokens · list rates, not a bill`)}`,
  );
  // The money first: each tier on its own line, exact, and never added up.
  const fact = (rule: string) => p.habits.find((h) => h.rule === rule)?.note;
  const tried = p.opportunities.filter((r) => r.tier === "try");
  const money = (label: string, value: string, note: string) =>
    out.push(`    ${dim(pad(label, 20))}${padLeft(value, 13)}  ${dim(note)}`);
  out.push("");
  out.push(`  ${bold("Savings found")}`);
  money(
    "Clear waste",
    bold(green(`${usd(p.savingsMonthlyUsd)}/mo`)),
    p.savingsMonthlyUsd > 0.005
      ? `${usd(p.savingsAnnualUsd)}/yr · fix it, nothing to lose`
      : "none worth fixing",
  );
  if (p.likelyMonthlyUsd > 0.005) {
    money(
      "Likely, if you try",
      yellow(`+${usd(p.likelyMonthlyUsd)}/mo`),
      tried.map((r) => ruleLabel(r.rule).toLowerCase()).join(", "),
    );
  }
  p.levers.forEach((r, i) => {
    const why = fact(r.rule);
    money(
      i === 0 ? "Up to, if you test" : "",
      blue(`${usd(r.savings.monthlyUsd)}/mo`),
      `${ruleLabel(r.rule).toLowerCase()}${why ? ` · ${why}` : ""}`,
    );
  });
  out.push("");

  // The biggest single win, whatever its tier, labelled for what it is.
  const windowed = Boolean(claudePlan || p.codex);
  const win = p.biggestWin;
  if (win) {
    const r = win.recommendation;
    out.push(
      `  ${bold("Biggest win")}  ${bold(ruleLabel(r.rule))}  ${TIER_TAG[r.tier]} ${dim("·")} ${confidenceTag(r.savings.confidence)}`,
    );
    const work = windowed ? `, about ${win.moreWork.toFixed(1)}x the work per 5-hour window` : "";
    out.push(
      r.tier === "test"
        ? `    ${blue(`Up to ${pct(win.share)} less usage`)} ${dim(`(~${usd(r.savings.monthlyUsd)}/mo)${work}`)}`
        : `    ${green(`${usd(r.savings.monthlyUsd)}/mo`)}${dim(`, ${pct(win.share)} of your usage${work}`)}`,
    );
    out.push("");
    out.push(...story(r, "    "));
  } else {
    out.push(`  ${green("No clear waste and no levers worth testing were found.")}`);
  }
  out.push("");
  out.push(rule());
  out.push("");

  // Where the money goes: most of it is usually the conversation, re-read.
  out.push(`  ${bold("Where it goes")}`);
  out.push("");
  const parts: Array<[string, number]> = [
    ["Re-reading the conversation", p.breakdown.reread],
    ["Answers, code and thinking", p.breakdown.output],
    ["Loading context into cache", p.breakdown.cacheWrite],
    ["New input", p.breakdown.input],
    ["Web search and tools", p.breakdown.tools],
  ];
  for (const [label, share] of parts.filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${pad(label, 30)}${padLeft(pct(share), 4)}  ${shareBar(share)}`);
  }
  // Re-reading is already the cheap rate; it is big because every call does it.
  if (p.breakdown.reread >= 0.005) {
    out.push(`    ${dim("Re-reading is billed at the cache-read rate, the cheapest there is.")}`);
  }
  out.push("");

  // Everything worth doing, clear waste first, levers last and never added.
  const all = p.opportunities;
  // Cents a month are noise on this screen; `recommend` lists everything.
  const ways = all.filter((r) => r.savings.monthlyUsd >= WORTH_LISTING_USD);
  const smaller = all.length - ways.length;
  if (all.length > 0) {
    out.push(`  ${bold("Clear waste and likely savings, item by item")}`);
    out.push("");
    // On a plan the limit is what bites, so each saving also shows as a share of usage.
    const usage = (usd: number) => {
      const s = p.perMonthUsd > 0 ? usd / p.perMonthUsd : 0;
      return s < 0.005 ? "<1%" : pct(s);
    };
    for (const r of ways) {
      const share = windowed ? `${padLeft(usage(r.savings.monthlyUsd), 5)} of usage  ` : "";
      out.push(
        `    ${TIER_TAG[r.tier]}  ${pad(ruleLabel(r.rule), 24)}${padLeft(monthlyOf(r.tier, r.savings.monthlyUsd), 17)}  ${share}${confidenceTag(r.savings.confidence)}`,
      );
    }
    if (smaller > 0) {
      out.push(
        `    ${dim(`+${smaller} smaller, under $${WORTH_LISTING_USD.toFixed(2)}/mo each: optimaizr recommend`)}`,
      );
    }
    out.push("");
    out.push(
      `  ${dim(`Clear waste ${usd(p.savingsMonthlyUsd)}/mo${p.likelyMonthlyUsd > 0.005 ? ` · likely +${usd(p.likelyMonthlyUsd)}/mo` : ""}. Each call is counted once; the "up to" figures above are never added in.`)}`,
    );
    if (windowed) {
      out.push(
        `  ${dim("On a plan, a share of your usage is about that share of your 5-hour windows.")}`,
      );
    }
    out.push("");
  }

  if (p.plan || p.codex || p.budget) {
    out.push(rule());
    out.push("");
    if (p.plan) out.push(...renderPlan(p.plan), "");
    if (p.codex) out.push(...renderCodexPlan(p.codex), "");
    if (p.budget) out.push(...renderBudget(p.budget), "");
  }

  out.push(rule());
  out.push("");
  out.push(`  ${bold("Next step")}`);
  const target = win?.recommendation ?? p.bottleneck;
  if (!target) {
    out.push(`    ${blue(p.nextCommand)}   ${dim("see where the money goes instead")}`);
    out.push("");
    return out.join("\n");
  }
  out.push(`    ${blue(p.nextCommand)}`);
  const also: Array<[string, string]> = [
    [`optimaizr show ${target.id}`, "the requests it touches"],
    ["optimaizr recommend", "every opportunity, with what to do"],
  ];
  const width = Math.max(...also.map(([cmd]) => cmd.length)) + 3;
  for (const [cmd, what] of also) out.push(`    ${dim(pad(cmd, width) + what)}`);
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Results: what an applied change did
 * ------------------------------------------------------------------ */

const AGENT_NAME: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  sdk: "your apps",
  import: "imported usage",
};

/** "Compact earlier: Claude Code at 200K", "Model mismatch: Opus 5.5 -> Sonnet 5.5 in api". */
export function changeName(c: AppliedChange): string {
  const label = ruleLabel(c.rule);
  if (c.rule === "context-compaction") {
    const who = c.source ? `${AGENT_NAME[c.source] ?? c.source} at ` : "at ";
    return `${label}: ${who}${Math.round(compactPointOf(c) / 1000)}K`;
  }
  if (c.to) {
    const from = c.from ? `${modelLabel(c.from)} -> ` : "";
    return `${label}: ${from}${modelLabel(c.to)}${c.project ? ` in ${projectName(c.project)}` : ""}`;
  }
  return c.project ? `${label} in ${projectName(c.project)}` : label;
}

function resultValue(unit: ResultRow["unit"], v: number | null): string {
  if (v === null) return "-";
  if (unit === "usd") return usd(v);
  if (unit === "share") return pct(v);
  if (unit === "tokens") return kTokens(v);
  if (unit === "minutes") return `${v < 10 ? v.toFixed(1) : Math.round(v)}m`;
  return v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v));
}

function resultChange(r: ResultRow): string {
  if (r.change === null) return "";
  const size = Math.round(Math.abs(r.change) * 100);
  if (size === 0) return dim("same");
  // Past double, a multiple reads better than +2252%.
  const times = 1 + r.change;
  const text =
    r.unit !== "share" && times >= 2
      ? `${times < 10 ? times.toFixed(1) : Math.round(times)}x`
      : `${r.change < 0 ? "-" : "+"}${size}${r.unit === "share" ? " pts" : "%"}`;
  const good = r.better === "lower" ? r.change < 0 : r.change > 0;
  if (size < 5) return dim(text);
  if (good) return green(text);
  return r.worse ? yellow(`${text}  trade-off`) : text;
}

/** The low and high end in whole percent, when the baselines agree on the direction but not the size. */
function spread(r: ChangeResult): [number, number] | null {
  const g = r.range;
  if (!g || g.low < 0 !== g.high < 0) return null;
  const ends = [g.low, g.high].map((x) => Math.round(Math.abs(x) * 100)).sort((x, y) => x - y);
  return ends[0] !== ends[1] ? [ends[0]!, ends[1]!] : null;
}

/** "33% less per prompt", or "10% to 28% less per prompt", for the verdict and the profile's applied line. */
function perUnit(r: ChangeResult): string {
  const c = r.headline?.change ?? 0;
  const both = spread(r);
  const size = both ? `${both[0]}% to ${both[1]}%` : `${Math.round(Math.abs(c) * 100)}%`;
  return `${size} ${c < 0 ? "less" : "more"} per ${r.measure}`;
}

/** "a, b and c" */
function listed(xs: readonly string[]): string {
  return xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

function sinceWhen(iso: string, now: number): string {
  const d = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return `${localDay(iso)}, ${d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`}`;
}

function verdictLine(r: ChangeResult): string {
  const both = spread(r);
  const base = both
    ? `the ${r.range!.shortest} to ${days(r.range!.longest)} before`
    : `the ${days(r.before.days)} before`;
  switch (r.verdict) {
    case "too-early": {
      const p = r.progress;
      const unit = r.measure === "prompt" ? "prompts" : "calls";
      const around = p.readyAround
        ? ` First reading around ${monthDay(p.readyAround)}.`
        : " At this pace that is more than three weeks out.";
      // Say what is still short, not "7 of 3 active days".
      const dayText = `${p.activeDays} of ${p.needActiveDays} active days`;
      const countText = `${p.count} of ${p.needCount} ${unit}`;
      const sofar =
        p.activeDays >= p.needActiveDays
          ? `${countText} so far, over ${p.activeDays} active days`
          : p.count >= p.needCount
            ? `${dayText} so far, with ${p.count} ${unit}`
            : `${dayText} and ${countText} so far`;
      return `${yellow("Too early to tell:")} ${sofar}.${around}`;
    }
    case "no-baseline":
      return `${yellow("Not enough from before the change to compare:")} ${r.before.activeDays} active days in ${base}.`;
    case "working": {
      const costs = r.rows.filter((x) => x.worse).map((x) => x.label);
      const extra = r.withCost ? ` It comes with a cost: ${listed(costs)} went up.` : "";
      return `${green("Working:")} ${perUnit(r)} than ${base}.${extra}`;
    }
    case "worse":
      return `${red("Not working:")} ${perUnit(r)} than ${base}.`;
    default:
      return `${bold("No clear effect yet:")} ${perUnit(r)} than ${base}, within the usual swing.`;
  }
}

export function renderResults(
  report: ResultsReport,
  opts: { now?: number; kept?: string | null } = {},
): string {
  const now = opts.now ?? Date.parse(report.generatedAt);
  const out: string[] = [""];
  out.push(`  ${bold("optimAIzr")} ${dim("|")} results`);
  out.push("");
  if (report.results.length === 0) {
    out.push("  No changes to measure yet.");
    out.push(
      `  ${dim("Apply one and optimAIzr compares the days after it with the days before.")}`,
    );
    out.push("");
    out.push(`    ${blue("optimaizr apply")}   ${dim("what you can change")}`);
    out.push(
      `    ${blue("optimaizr apply <rule> --done")}   ${dim("record a change you made yourself")}`,
    );
    out.push("");
    return out.join("\n");
  }

  let tables = false;
  for (const r of report.results) {
    out.push(rule());
    out.push("");
    const how = r.change.how === "by-hand" ? "made by hand" : "applied";
    const undone = r.change.until ? `, undone ${localDay(r.change.until)}` : "";
    out.push(`  ${bold(changeName(r.change))}`);
    out.push(`  ${dim(`${how} ${sinceWhen(r.change.at, now)}${undone}`)}`);
    out.push("");
    for (const line of wrap(verdictLine(r), 70)) out.push(`  ${line}`);
    if (r.early) {
      const inDays = days(Math.max(1, Math.floor(r.after.days)));
      out.push(`  ${dim(`Early reading, ${inDays} in: one heavy day can still swing it.`)}`);
    }
    out.push("");

    if (r.verdict !== "too-early" && r.verdict !== "no-baseline") {
      tables = true;
      const width = Math.max(...r.rows.map((x) => x.label.length)) + 2;
      out.push(`    ${pad("", width)}${dim(padLeft("before", 10))}${dim(padLeft("after", 10))}`);
      for (const x of r.rows) {
        out.push(
          `    ${pad(x.label, width)}${padLeft(resultValue(x.unit, x.before), 10)}${padLeft(resultValue(x.unit, x.after), 10)}   ${resultChange(x)}`,
        );
      }
      out.push("");
    }

    const since =
      r.after.calls === 0
        ? "No calls since the change yet."
        : `Since the change: ${r.since.map((f) => f.text).join(", ")}.`;
    for (const line of wrap(since, 70)) out.push(`  ${dim(line)}`);
    out.push("");

    if (r.caveats.length > 0) {
      out.push(`  ${bold("Worth knowing")}`);
      for (const c of r.caveats) {
        wrap(c, 66).forEach((line, i) => out.push(`  ${i === 0 ? "· " : "  "}${dim(line)}`));
      }
      out.push("");
    }

    if (r.next.length > 0) {
      const width = Math.max(...r.next.map((n) => n.command.length)) + 3;
      for (const n of r.next) out.push(`    ${blue(pad(n.command, width))}${dim(n.why)}`);
      out.push("");
    }
  }
  if (opts.kept) {
    out.push(rule());
    out.push("");
    out.push(`  ${bold("Guard")} ${dim("last 7 days")}  ${green(opts.kept)}`);
    out.push(
      `  ${dim("Only holds that stuck count: a message never sent again, a whole read never made.")}`,
    );
    out.push("");
  }
  out.push(rule());
  if (tables) {
    out.push(`  ${dim("Dollars are API-equivalent at list prices. On a plan, the percentage is")}`);
    out.push(`  ${dim("what counts: it is about that share of your usage limits.")}`);
  }
  out.push("");
  return out.join("\n");
}

/** How a change is going in a few words, for the profile. */
function appliedState(r: ChangeResult): string {
  switch (r.verdict) {
    case "too-early":
      return r.progress.readyAround
        ? `first reading around ${monthDay(r.progress.readyAround)}`
        : "too early to tell";
    case "no-baseline":
      return "not enough from before it to compare";
    case "working":
      return green(`${perUnit(r)} so far`);
    case "worse":
      return red(`${perUnit(r)} so far`);
    default:
      return `no clear effect yet (${perUnit(r)})`;
  }
}

/** The changes still in place, one line each, two when it would run long. */
function renderApplied(results: readonly ChangeResult[]): string[] {
  const out = [`  ${bold("Applied")}`];
  for (const r of results) {
    const name = `${changeName(r.change)} ${dim(`since ${localDay(r.change.at)}`)}`;
    const line = `    ${name} ${dim("·")} ${appliedState(r)}`;
    if (visible(line) <= 84) out.push(line);
    else out.push(`    ${name}`, `      ${appliedState(r)}`);
  }
  out.push(`    ${dim("Before against after, for each:")} ${blue("optimaizr results")}`);
  return out;
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

function kTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

/** Row label, then what one occurrence is called; no count for new content. */
const WRITE_CAUSE_LABEL: Record<WriteCause, [string, string, string]> = {
  growth: ["new content", "", ""],
  start: ["new conversations", "conversation", "conversations"],
  compaction: ["after a compaction", "compaction", "compactions"],
  subagent: ["subagents", "run", "runs"],
  break: ["after a break", "return", "returns"],
  rebuilt: ["rebuilt while warm", "time", "times"],
  model: ["model switches", "switch", "switches"],
};

function bandLabel(from: number, to: number | null): string {
  const start = from === 0 ? "0" : kTokens(from);
  return to === null ? `${start}+` : `${start}-${kTokens(to)}`;
}

/** What `renderSessions` lists above the session facts: the costliest conversations. */
export interface ConversationList {
  rows: readonly ConversationRow[];
  /** Turns dollars into a share of the 5h window; null leaves the share out. */
  rate: { usdPerPercent: number; basis: "meter" | "plan"; windows?: number } | null;
  top?: number;
}

function renderConversations(list: ConversationList, totalUsd: number): string[] {
  const top = list.rows.slice(0, list.top ?? 10);
  if (top.length === 0) return [];
  const rate = list.rate;
  const out: string[] = [];
  out.push(`  ${bold("Costliest conversations")} ${dim("(subagents included)")}`);
  out.push(
    `    ${dim(`${padLeft("cost", 9)}${rate ? padLeft("of 5h", 8) : ""}${padLeft("worked", 9)}   conversation`)}`,
  );
  for (const r of top) {
    const name = r.title ? clip(r.title, 40) : dim(`${r.sessionId.slice(0, 8)} (no title)`);
    const where = `${projectName(r.project)} · ${monthDay(r.lastTs.slice(0, 10))}${r.headless ? " · headless" : ""}`;
    out.push(
      `    ${padLeft(usd(r.costUsd), 9)}${rate ? padLeft(windowShareLabel(r.costUsd, rate.usdPerPercent), 8) : ""}${padLeft(workLabel(r.workMs), 9)}   ${pad(name, 42)}${dim(where)}`,
    );
  }
  const share = totalUsd > 0 ? top.reduce((s, r) => s + r.costUsd, 0) / totalUsd : 0;
  const n = list.rows.length;
  out.push(
    `    ${dim(`${top.length === n ? `All ${n}` : `The top ${top.length} of ${n}`} conversation${n === 1 ? "" : "s"}, ${pct(share)} of spend. Worked: time the agent spent on it, pauses over 15m left out.`)}`,
  );
  if (rate?.basis === "meter") {
    out.push(
      `    ${dim(`5h share at ${usd(rate.usdPerPercent)} per 1%, learned from ${rate.windows} windows of your plan meter.`)}`,
    );
  } else if (rate) {
    out.push(
      `    ${dim(`5h share at ${usd(rate.usdPerPercent)} per 1%, from your plan's estimated limit.`)}`,
    );
  }
  out.push("");
  return out;
}

/** `Oct 19 14:00`, local time. */
function hourLabel(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;
}

function renderWindows(w: FiveHourWindows, convos?: ConversationList): string[] {
  if (w.count === 0) return [];
  const rows = new Map((convos?.rows ?? []).map((r) => [r.sessionId, r]));
  const name = (id: string) => {
    const r = rows.get(id);
    return r?.title ? clip(r.title, 28) : r ? projectName(r.project) : id.slice(0, 8);
  };
  const rate = convos?.rate;
  const out = [
    `  ${bold("5-hour windows")} ${dim(`(Claude Code, the latest ${w.recent.length} of ${w.count})`)}`,
  ];
  for (const x of w.recent) {
    const n = x.conversations.length;
    const share = rate
      ? padLeft(`${windowShareLabel(x.costUsd, rate.usdPerPercent)} of 5h`, 13)
      : "";
    const ran = `${n} conversation${n === 1 ? "" : "s"}${x.atOnce >= 2 ? `, ${x.atOnce} at once` : ""}`;
    out.push(`    ${pad(hourLabel(x.start), 14)}${padLeft(usd(x.costUsd), 9)}${share}   ${ran}`);
    const top = x.conversations.slice(0, 3).map((c) => `${pct(c.share)} ${name(c.sessionId)}`);
    const more = n > 3 ? ` · ${n - 3} more` : "";
    out.push(`        ${dim(`${top.join(" · ")}${more}`)}`);
  }
  if (w.parallel > 0) {
    out.push(
      `    ${dim(`Two or more conversations ran at once in ${w.parallel} of ${w.count} windows, ${pct(w.parallelShare)} of spend.`)}`,
    );
  }
  out.push("");
  return out;
}

function renderNoteVsCompaction(f: { note: StartFacts; compaction: StartFacts }): string[] {
  const out = [`  ${bold("Starting from a note against compacting")} ${dim("(Claude Code)")}`];
  out.push(
    `    ${dim(`${pad("", 22)}${padLeft("from a note", 13)}${padLeft("after a compaction", 21)}`)}`,
  );
  const row = (label: string, a: string, b: string) =>
    out.push(`    ${pad(label, 22)}${padLeft(a, 13)}${padLeft(b, 21)}`);
  const per = (n: number | null) => (n === null ? "n/a" : n.toFixed(1));
  const wait = (ms: number) => (ms <= 0 ? "none" : workLabel(ms));
  row("times", String(f.note.count), String(f.compaction.count));
  row("first call", kTokens(f.note.firstCall), kTokens(f.compaction.firstCall));
  row("waited before it", wait(f.note.waitMs), wait(f.compaction.waitMs));
  row("files read again", per(f.note.readAgain), per(f.compaction.readAgain));
  row("calls per prompt", per(f.note.callsPerPrompt), per(f.compaction.callsPerPrompt));
  out.push(`    ${dim("A note: guard's handoff, used by the /clear after a held message.")}`);
  if (f.note.count < 5) out.push(`    ${dim("Few notes so far, so read this as a first look.")}`);
  out.push("");
  return out;
}

export function renderSessions(
  c: SessionStats,
  s: Summary,
  convos?: ConversationList,
  opts: { fresh?: { note: StartFacts; compaction: StartFacts } | null } = {},
): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("|")} sessions`);
  out.push(
    `  ${dim(`${s.windowDays.from} to ${s.windowDays.to}  (${Math.max(1, s.window.days).toFixed(1)} days)`)}`,
  );
  out.push("");
  out.push(rule());
  out.push("");
  if (convos) out.push(...renderConversations(convos, c.costUsd));

  const row = (label: string, median: string, p90: string) =>
    out.push(`    ${pad(label, 24)}${pad(`median ${median}`, 16)}${dim(`1 in 10 over ${p90}`)}`);
  out.push(`  ${bold("Sessions")}`);
  out.push(
    `    ${c.sessions.toLocaleString()} sessions · ${c.calls.toLocaleString()} calls · ${usd(c.costUsd)} ${dim("at list prices")}`,
  );
  row("calls per session", String(c.callsPerSession.median), String(c.callsPerSession.p90));
  if (c.turnsPerSession.p90 > 0) {
    row("prompts per session", String(c.turnsPerSession.median), String(c.turnsPerSession.p90));
  }
  row("largest conversation", kTokens(c.peakContext.median), kTokens(c.peakContext.p90));
  out.push(`    ${pad("cache hit rate", 24)}${(c.cacheHitRate * 100).toFixed(1)}%`);
  if (c.headless.sessions > 0) {
    out.push(
      `    ${pad("headless runs", 24)}${c.headless.sessions} session${c.headless.sessions === 1 ? "" : "s"} · ${usd(c.headless.costUsd)} ${dim(`(${pct(c.headless.share)}) claude -p, the SDK, codex exec`)}`,
    );
  }
  out.push("");
  out.push(...renderWindows(c.windows, convos));

  const bands = c.byContext.filter((b) => b.calls > 0);
  if (bands.length > 0) {
    out.push(`  ${bold("Where re-reading takes over")} ${dim("(main conversations)")}`);
    out.push(
      `    ${dim(`${pad("context", 12)}${padLeft("calls", 7)}${padLeft("spend", 8)}   re-read share of the cost`)}`,
    );
    for (const b of bands) {
      out.push(
        `    ${pad(bandLabel(b.from, b.to), 12)}${padLeft(b.calls.toLocaleString(), 7)}${padLeft(pct(b.share), 8)}   ${shareBar(b.rereadShare, 12)} ${pct(b.rereadShare)}`,
      );
    }
    out.push(
      `    ${dim(
        c.rereadHalfAt === null
          ? "Re-reading never reaches half the cost of a call here."
          : `From ${kTokens(c.rereadHalfAt)} of context on, re-reading is half the cost of a call or more.`,
      )}`,
    );
    out.push("");
  }

  out.push(`  ${bold("Where the money is")}`);
  out.push(
    `    The costliest ${c.topSessions.count} session${c.topSessions.count === 1 ? "" : "s"} (1 in 10) took ${bold(pct(c.topSessions.share))} of spend.`,
  );
  if (c.longSessions.count > 0) {
    out.push(
      `    ${c.longSessions.count} session${c.longSessions.count === 1 ? "" : "s"} passed ${kTokens(c.longSessions.over)} of context and took ${bold(pct(c.longSessions.share))} of spend.`,
    );
  }
  for (const b of c.bySessionLength.filter((b) => b.sessions > 0)) {
    const calls = b.to === null ? `${b.from}+ calls` : `${b.from}-${b.to - 1} calls`;
    out.push(
      `    ${pad(calls, 16)}${padLeft(`${b.sessions} session${b.sessions === 1 ? "" : "s"}`, 13)}${padLeft(pct(b.share), 6)}  ${shareBar(b.share, 12)}`,
    );
  }
  out.push("");

  const w = c.cacheWrites;
  if (w.costUsd > 0) {
    out.push(
      `  ${bold("Cache writes")} ${dim(`(${(w.tokenShare * 100).toFixed(1)}% of tokens, ${pct(w.spendShare)} of spend)`)}`,
    );
    row("per session", usd(w.perSession.median), usd(w.perSession.p90));
    const life = w.lifetime;
    if (life.hourTokens + life.fiveTokens > 0) {
      const h = life.hourShare;
      const text =
        h === 1
          ? "1 hour on all of it"
          : h === 0
            ? "5 minutes on all of it"
            : h >= 0.995
              ? "1 hour on over 99% of it"
              : h <= 0.005
                ? "5 minutes on over 99% of it"
                : `1 hour on ${pct(h)} of it, 5 minutes on ${pct(1 - h)}`;
      out.push(`    ${pad("cache lifetime", 24)}${text}`);
    }
    for (const r of w.byCause.filter((r) => r.costUsd > 0)) {
      const [label, one, many] = WRITE_CAUSE_LABEL[r.cause];
      const times = one
        ? ` ${dim(`${r.times.toLocaleString()} ${r.times === 1 ? one : many}`)}`
        : "";
      out.push(
        `    ${pad(label, 22)}${padLeft(usd(r.costUsd), 9)}${padLeft(pct(r.share), 6)}  ${shareBar(r.share, 12)}${times}`,
      );
    }
    if (w.rewrites.costUsd > 0) {
      out.push(`    ${dim("Breaks, warm rebuilds and model switches wrote again what the cache")}`);
      out.push(
        `    ${dim(`already held: ${usd(w.rewrites.costUsd)}, ${pct(w.rewrites.share)} of writes.`)}`,
      );
    }
    out.push("");
  }

  const cold = c.coldResumes;
  if (cold.count > 0) {
    out.push(`  ${bold("Cold cache returns")}`);
    const times = cold.count === 1 ? "Once" : `${cold.count} times`;
    const text =
      `${times} a long conversation's cache had expired by its next call, and all of it ` +
      `was written again: ${fmtTokens(cold.tokens)} tokens for ${usd(cold.costUsd)}, where a warm ` +
      `cache would have read it for ${usd(cold.warmUsd)}.`;
    for (const line of wrap(text, 70)) out.push(`    ${line}`);
    const kind = (label: string, k: { count: number; costUsd: number }) =>
      out.push(
        `      ${pad(label, 30)}${padLeft(String(k.count), 5)}${padLeft(usd(k.costUsd), 10)}`,
      );
    if (cold.tool.count > 0) {
      kind("you were away", cold.away);
      kind("Claude was waiting on a tool", cold.tool);
      out.push(
        `    ${dim("A tool: a long command, a subagent or a permission prompt left open.")}`,
      );
    }
    if (cold.outlasted.length > 0) {
      out.push(`    ${dim("On the 5-minute cache, Claude was waiting on these when it expired:")}`);
      for (const o of cold.outlasted.slice(0, 5)) {
        out.push(
          `      ${pad(clip(o.label, 30), 30)}${padLeft(`${o.times}x`, 5)}${padLeft(usd(o.costUsd), 10)}`,
        );
      }
    }
    out.push("");
  }
  if (opts.fresh) out.push(...renderNoteVsCompaction(opts.fresh));

  out.push(rule());
  out.push(`  ${dim("Measured from your logs, nothing estimated. --json for the numbers.")}`);
  out.push(`  ${dim("What to do about it:")} ${blue("optimaizr recommend")}`);
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Budget
 * ------------------------------------------------------------------ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-27` -> `Sep 27`. */
export function monthDay(key: string): string {
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : key;
}

function days(n: number): string {
  const r = Math.round(n);
  return `${r} day${r === 1 ? "" : "s"}`;
}

/** Whole calendar days from one `YYYY-MM-DD` to another. */
function calendarDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function meter(share: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  const bar = "█".repeat(filled) + dim("░".repeat(width - filled));
  return share >= 1 ? red(bar) : share >= 0.8 ? yellow(bar) : bar;
}

/** The profile's budget block: the cap, what is used, and the day it runs out. */
export function renderBudget(b: BudgetStatus): string[] {
  const out: string[] = [];
  const row = (k: string, v: string, note = "") =>
    out.push(`  ${dim(pad(k, 20))} ${padLeft(v, 12)}${note ? `  ${note}` : ""}`);
  const pct = `${Math.round(b.usedShare * 100)}%`;

  out.push(`  ${bold("Budget")}`);
  out.push("");
  row("Monthly cap", bold(usd(b.limitUsd)), dim(`resets ${monthDay(b.resetsOn)} (${b.timeZone})`));
  row(
    "Used this month",
    bold(usd(b.usedUsd)),
    `${meter(b.usedShare)} ${b.reached ? red(pct) : pct} ${dim(`· day ${Math.ceil(b.daysElapsed) || 1} of ${b.daysInPeriod}`)}`,
  );

  if (b.reached) {
    row(
      "Cap reached",
      bold(red(b.exhaustsOn ? monthDay(b.exhaustsOn) : "yes")),
      red(`${days(b.daysLeft)} until it resets`),
    );
  } else if (b.exhaustsOn) {
    // Compare dates, not fractional days, so the note agrees with the date beside it.
    row(
      "At this rate",
      bold(red(monthDay(b.exhaustsOn))),
      red(`cap reached ${days(calendarDays(b.exhaustsOn, b.resetsOn))} before reset`),
    );
  } else {
    row(
      "At this rate",
      bold(green(usd(b.projectedUsd))),
      green(`by month end, ${usd(b.limitUsd - b.projectedUsd)} to spare`),
    );
  }

  const f = b.withFixes;
  const gained = f && b.exhaustsOn ? calendarDays(b.exhaustsOn, f.exhaustsOn ?? b.resetsOn) : 0;
  if (f && gained > 0) {
    row(
      "With the fixes below",
      bold(green(f.exhaustsOn ? monthDay(f.exhaustsOn) : "lasts")),
      `${green(`+${days(gained)}`)} ${dim(f.exhaustsOn ? "· estimated" : "· the whole month, estimated")}`,
    );
  }

  const pace =
    b.rateBasis === "month-to-date" ? "this month so far" : "the last 14 days (early in the month)";
  out.push(`  ${dim(`Pace: ${usd(b.dailyRateUsd)}/day, from ${pace}. Counts this machine only.`)}`);
  return out;
}

/** One live line when month-to-date spend crosses a share of the cap. */
export function renderBudgetCrossing(c: BudgetCrossing, daysLeft?: number): string {
  const pct = Math.round(c.threshold * 100);
  const tag =
    c.threshold >= 1 ? red("BUDGET") : c.threshold >= 0.8 ? yellow("BUDGET") : blue("BUDGET");
  const head =
    c.threshold >= 1
      ? `cap reached: ${usd(c.usedUsd)} of ${usd(c.limitUsd)}`
      : `${pct}% of your ${usd(c.limitUsd)} cap used (${usd(c.usedUsd)})`;
  const tail = daysLeft === undefined ? "" : dim(` · ${days(daysLeft)} until it resets`);
  return `  ${tag}  ${head}${tail}\n        ${dim("optimaizr profile --budget " + c.limitUsd + "   what to cut to make it last")}`;
}

/* ------------------------------------------------------------------ *
 * Plan (Claude Pro / Max)
 * ------------------------------------------------------------------ */

/** Wall-clock time on this machine, e.g. `19:00`. Sessions reset on local clocks. */
export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The day on this machine's calendar, e.g. `Oct 7`. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The profile's plan block: what the subscription is worth, and where sessions go. */
export function renderPlan(v: PlanView): string[] {
  const out: string[] = [];
  const row = (k: string, val: string, note = "") =>
    out.push(`  ${dim(pad(k, 20))} ${padLeft(val, 12)}${note ? `  ${note}` : ""}`);

  const from =
    v.source === "detected"
      ? "detected from your Claude Code sign-in"
      : v.source === "flag"
        ? "from --plan"
        : v.source === "config"
          ? "from your config"
          : "";
  out.push(`  ${bold("Plan")}${from ? ` ${dim(`· ${from}`)}` : ""}`);
  out.push("");
  row(
    v.label,
    bold(`${usd(v.priceUsd)}/mo`),
    dim(v.perSeat ? "per seat, billed monthly" : "what you pay"),
  );
  if (v.calls === 0) {
    out.push(`  ${yellow("No Claude Code usage found")}${v.dir ? dim(` in ${v.dir}`) : ""}`);
    out.push(`  ${dim("so there is nothing to set the plan against.")}`);
    return out;
  }
  const days = Math.round(v.valueDays);
  row(
    "API-equivalent",
    bold(green(`${usd(v.valueMonthlyUsd)}/mo`)),
    `${green(`${v.multiple >= 10 ? Math.round(v.multiple) : v.multiple.toFixed(1)}x`)} ${dim(
      v.valueDays < 30 ? `what you pay, from ${days} day${days === 1 ? "" : "s"}` : "what you pay",
    )}`,
  );
  row("5-hour sessions", bold(v.recentSessions.toLocaleString()), dim("in the last 30 days"));
  if (v.recentSessions > 0) {
    row(
      "Typical session",
      bold(usd(v.medianSessionUsd)),
      dim(
        v.heaviest
          ? `median · heaviest ${usd(v.heaviest.usd)} on ${localDay(v.heaviest.start)}`
          : "median",
      ),
    );
    const w = v.wasteShare;
    row(
      "Waste per session",
      bold(yellow(`${Math.round(w * 100)}%`)),
      w > 0.005
        ? // Removing a share w of the spend makes the same work cost (1 - w),
          // so a session holds 1 / (1 - w) as much before the limit.
          dim(`fix it and you'd hit the limit ~${Math.round((1 / (1 - w) - 1) * 100)}% later`)
        : dim("nothing worth cutting"),
    );
  }
  const meter = (name: string, r: { percentUsed: number; resetsAt?: string } | undefined) => {
    if (!r) return;
    const pct = Math.round(r.percentUsed);
    const color = pct >= 95 ? red : pct >= 80 ? yellow : green;
    row(
      name,
      bold(color(`${pct}%`)),
      dim(`Claude Code's meter${r.resetsAt ? ` · resets ${resetTime(r.resetsAt)}` : ""}`),
    );
  };
  meter("5-hour window", v.windows?.fiveHour);
  meter("Weekly window", v.windows?.sevenDay);
  if (v.limit) {
    row(
      "Your session limit",
      bold(`~${usd(v.limit.usd)}`),
      dim(`learned from ${v.limit.hits} recorded hit${v.limit.hits === 1 ? "" : "s"}`),
    );
  } else if (!v.windows?.fiveHour) {
    // Claude Code's own meter makes a learned limit unnecessary.
    row(
      "Your session limit",
      dim("unknown"),
      dim("optimaizr statusline on reads it from Claude Code's meter"),
    );
  }
  if (v.current) {
    const share =
      v.current.limitShare === null ? "" : ` · ~${Math.round(v.current.limitShare * 100)}% of it`;
    row(
      "This session",
      bold(usd(v.current.usd)),
      dim(`since ${localTime(v.current.start)}, resets ${localTime(v.current.end)}${share}`),
    );
  }
  if (v.windows) {
    out.push(`  ${dim("Window figures are Claude Code's own, read by the optimAIzr mod.")}`);
    out.push(`  ${dim("Sessions and their spend are rebuilt from timestamps.")}`);
  } else {
    out.push(
      `  ${dim("Sessions are rebuilt from timestamps; the limit is not published, only learned.")}`,
      `  ${dim("The optimAIzr mod adds Claude Code's real 5-hour and weekly meters: optimaizr mod")}`,
    );
  }
  return out;
}

/** `Sep 26, 14:00` for a time more than 20 hours away either way, `01:00` otherwise. */
export function resetTime(iso: string): string {
  // A reset or reading from days ago needs its date as much as one days ahead.
  const far = Math.abs(Date.parse(iso) - Date.now()) > 20 * 3_600_000;
  return far ? `${localDay(iso)}, ${localTime(iso)}` : localTime(iso);
}

/** The profile's Codex block: the ChatGPT plan, OpenAI's own meter, and the waste in it. */
export function renderCodexPlan(v: CodexPlanView): string[] {
  const out: string[] = [];
  const row = (k: string, val: string, note = "") =>
    out.push(`  ${dim(pad(k, 20))} ${padLeft(val, 12)}${note ? `  ${note}` : ""}`);

  out.push(`  ${bold("Codex")} ${dim("· plan and limits read from Codex, not guessed")}`);
  out.push("");
  row(
    v.label,
    bold(v.priceUsd === null ? "seat" : v.priceUsd === 0 ? "free" : `${usd(v.priceUsd)}/mo`),
    dim(v.priceUsd === null ? "priced per seat" : "what you pay"),
  );
  row(
    "API-equivalent",
    bold(green(`${usd(v.valueMonthlyUsd)}/mo`)),
    v.multiple
      ? `${green(`${v.multiple >= 10 ? Math.round(v.multiple) : v.multiple.toFixed(1)}x`)} ${dim("what you pay")}`
      : dim("at API prices"),
  );
  for (const w of v.windows) {
    if (w.hasReset) {
      row(`${w.label} window`, bold("0%"), dim(`reset at ${resetTime(w.resetsAt)}, fresh`));
      continue;
    }
    const pct = Math.round(w.usedPercent);
    const tint = pct >= 95 ? red : pct >= 80 ? yellow : (s: string) => s;
    const worth = w.fullWindowUsd === null ? "" : ` · a full window ~${usd(w.fullWindowUsd)}`;
    row(
      `${w.label} window`,
      bold(tint(`${pct}%`)),
      dim(`used · resets ${resetTime(w.resetsAt)}${worth}`),
    );
  }
  const ws = v.wasteShare;
  row(
    "Waste",
    bold(yellow(`${Math.round(ws * 100)}%`)),
    ws > 0.005
      ? dim(`fix it and you'd hit the limits ~${Math.round((1 / (1 - ws) - 1) * 100)}% later`)
      : dim("nothing worth cutting"),
  );
  out.push(`  ${dim(`OpenAI's own figures, as Codex recorded them at ${resetTime(v.readAt)}.`)}`);
  return out;
}

/** One live line when a Codex window crosses 80% or 95% of OpenAI's meter. */
export function renderCodexCrossing(c: CodexLimitCrossing): string {
  const tag = c.threshold >= 95 ? red("CODEX") : yellow("CODEX");
  return `  ${tag}   ${c.label} limit ${Math.round(c.usedPercent)}% used ${dim(
    `· resets ${resetTime(c.resetsAt)}`,
  )}\n          ${dim("lower reasoning effort or switch to a smaller model to make the rest last")}`;
}

/** One live line when the running session nears the learned limit. */
export function renderSessionCrossing(c: SessionCrossing): string {
  const pct = Math.round(c.threshold * 100);
  const tag = c.threshold >= 0.95 ? red("SESSION") : yellow("SESSION");
  return `  ${tag} ~${pct}% of your usual session limit used (${usd(c.usedUsd)} of ~${usd(c.limitUsd)}) ${dim(
    `· resets ${localTime(c.resetsAt)}`,
  )}\n          ${dim("switch mechanical work to a smaller model to make the rest last: /model sonnet")}`;
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

/** Human-readable span, for windows measured in seconds and minutes. */
function span(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/** Last folder of a project path, on either separator (Windows paths use `\`). */
export function projectName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;
}

/** Short session id, marked when a subagent made the call. */
export function callSession(e: UsageEvent): string {
  return `${e.sessionId.slice(0, 8)}${e.isSubagent ? " sub" : ""}`;
}

// Codex records a shell call as JSON args; pull out the command itself.
function commandOf(text: string): string | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const a = JSON.parse(text) as { command?: unknown; cmd?: unknown };
    const cmd = a.command ?? a.cmd;
    if (typeof cmd === "string") return cmd;
    if (Array.isArray(cmd)) {
      const shell = /^(bash|sh|zsh|pwsh|powershell)(\.exe)?$/.test(String(cmd[0]));
      return shell && cmd.length >= 3 ? String(cmd[cmd.length - 1]) : cmd.join(" ");
    }
  } catch {
    // Signatures are cut at 200 chars, so long args may not parse.
  }
  return undefined;
}

/** What a call did, from its first tool: `Read .../src/app.ts`, `Bash npm test`. */
export function callActivity(e: UsageEvent, width = 48): string {
  const first = e.tools[0];
  if (!first) return "text only, no tools";
  const colon = first.signature.indexOf(":");
  let target = colon >= 0 ? first.signature.slice(colon + 1) : "";
  target = (commandOf(target) ?? target).replace(/\s+/g, " ").trim();
  // Agents prefix most commands with `cd <repo> &&`; the part after it is the work.
  target = target.replace(/^cd \S+ && /, "");
  const parts = target.split(/[\\/]/);
  if (parts.length > 3 && !target.includes(" ")) target = `.../${parts.slice(-2).join("/")}`;
  const more = e.tools.length > 1 ? ` +${e.tools.length - 1} more` : "";
  return clip(`${first.name} ${target}`.trim(), width - more.length) + more;
}

/**
 * One streamed recommendation. Quotes `observedUsd`, never `monthlyUsd`: a
 * window of minutes can't be projected to a month.
 */
/** A context notice from `live`: a big jump in one call, or a conversation past the compaction line. */
export function renderContextNotice(
  n: {
    kind: "jump" | "long";
    event: UsageEvent;
    contextTokens: number;
    added?: number;
    rereadUsd: number;
  },
  title?: string,
): string {
  const out: string[] = [];
  const e = n.event;
  const at = new Date(e.ts).toLocaleTimeString();
  const where = convoColor(e.sessionId)(clip(convoName(e.sessionId, e.project, title), 60));
  if (n.kind === "jump") {
    out.push(
      `  ${yellow("⚠")}  ${dim(at)}  ${bold("Context jump")} ${dim(`+${fmtTokens(n.added ?? 0)} tokens in one call, now ${fmtTokens(n.contextTokens)}`)}`,
    );
    out.push(`        ${where} ${callActivity(e, 40)}`);
    out.push(
      `        ${dim("Every later call in this conversation re-reads it, until it is compacted.")}`,
    );
  } else {
    out.push(
      `  ${yellow("⚠")}  ${dim(at)}  ${bold("Long conversation")} ${dim(`now ${fmtTokens(n.contextTokens)} of context`)}`,
    );
    out.push(`        ${where}`);
    out.push(
      `        ${dim("Every call re-reads all of it:")} ${bold(usd(n.rereadUsd))} ${dim(`on this call alone, before any work (${modelLabel(e.model)}).`)}`,
    );
  }
  return out.join("\n");
}

/** 12 -> "12m", 65 -> "1h 05m", from milliseconds. */
export function minutesLabel(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `live`: a Claude Code turn finished. */
export interface TurnDone {
  /** The turn's last call. */
  event: UsageEvent;
  title?: string;
  workMs: number;
  costUsd: number;
  conversation: { costUsd: number; workMs: number };
  usdPerPercent: number | null;
  /** In a big conversation: what the next message pays first, to re-read it. */
  next?: { context: number; floorUsd: number; callsPerMessage: number | null };
}

/**
 * One line per finished turn, its conversation first and in its own colour:
 * how long Claude worked, what it cost, its share of the 5h window, and the
 * conversation so far once there is more in it than this turn.
 */
export function renderTurnDone(t: TurnDone): string {
  const e = t.event;
  const color = convoColor(e.sessionId);
  const name = clip(convoName(e.sessionId, e.project, t.title), NAME_WIDTH);
  const parts = [workLabel(t.workMs), usd(t.costUsd)];
  if (t.usdPerPercent) parts.push(`${windowShareLabel(t.costUsd, t.usdPerPercent)} of 5h`);
  if (t.conversation.costUsd - t.costUsd >= 0.005) {
    parts.push(dim(`conversation ${usd(t.conversation.costUsd)}`));
  }
  const out = [
    `  ${color("●")}  ${dim(new Date(e.endTs ?? e.ts).toLocaleTimeString())}  ${pad(color(name), NAME_WIDTH)}  ${parts.join(dim(" · "))}`,
  ];
  if (t.next) {
    const n = t.next.callsPerMessage;
    const cost =
      n !== null && n >= 2
        ? `about ${usd(t.next.floorUsd * n)} a message here`
        : `at least ${usd(t.next.floorUsd)} a step`;
    out.push(
      `        ${dim(`now ${fmtTokens(t.next.context)} long: Claude re-reads all of it on every step,`)} ${cost}`,
    );
  }
  return out.join("\n");
}

/** `live`: a long conversation's cache is about to expire. */
export function renderCacheExpiring(s: CacheState, now: number, title?: string): string {
  const e = s.event;
  const left = minutesLabel((s.expiresAt ?? now) - now);
  return [
    `  ${yellow("⏳")}  ${dim(new Date(now).toLocaleTimeString())}  ${bold(`Cache expires in ${left}`)} ${dim(`${fmtTokens(s.context)} of conversation`)}`,
    `        ${convoColor(e.sessionId)(clip(convoName(e.sessionId, e.project, title), 60))}`,
    `        ${dim("Coming back after that writes it all again:")} ${bold(usd(s.rewriteUsd))}${dim(`. While warm, a call reads it for ${usd(s.readUsd)}.`)}`,
    `        ${dim("Leaving for longer? Ask for a handoff note (done, next, file), /clear, and start from it.")}`,
  ].join("\n");
}

/** `live`: the call that just came back to an expired cache, and what it cost. */
export function renderColdReturn(c: ColdResume, title?: string): string {
  const e = c.event;
  const what =
    c.ttlMinutes === null
      ? `sent ${fmtTokens(c.rewriteTokens)} again uncached`
      : `wrote ${fmtTokens(c.rewriteTokens)} into the cache again`;
  const gap = minutesLabel(c.gapMinutes * 60_000);
  const waited =
    c.waiting === "tool"
      ? `Claude waited ${gap} on ${clip(waitedOn(c.previous), 40)}`
      : `back after ${gap}`;
  return [
    `  ${yellow("⚠")}  ${dim(new Date(e.ts).toLocaleTimeString())}  ${bold("Cold cache")} ${dim(`${waited}, the first call ${what}`)}`,
    `        ${convoColor(e.sessionId)(clip(convoName(e.sessionId, e.project, title), 60))}`,
    `        ${dim("That call paid")} ${bold(usd(c.rewriteUsd))} ${dim(`for it; a warm cache would have read it for ${usd(c.warmUsd)}.`)}`,
  ].join("\n");
}

/**
 * `live`: something guard held or said in Claude Code, as it happens, with the
 * conversation it was in. For a note used, that is the conversation it came from.
 */
export function renderGuardCatch(
  r: GuardReceipt,
  opts: { title?: (sessionId: string) => string | undefined } = {},
): string {
  const at = dim(new Date(r.at).toLocaleTimeString());
  const tok = r.tokens ? fmtTokens(r.tokens) : "";
  const file = (f?: string) => (f ? (f.split(/[\\/]/).pop() ?? f) : "a file");
  const named = (id?: string) => {
    const t = id ? opts.title?.(id) : undefined;
    return id && t ? `  ${convoColor(id)(clip(t, NAME_WIDTH))}` : "";
  };
  const head = (icon: string, label: string, id?: string) =>
    `  ${icon}  ${at}  ${bold(label)}${named(id)}`;
  const line = (text: string) => `        ${dim(text)}`;
  switch (r.kind) {
    case "cold-hold":
      return [
        head(yellow("⏸"), "Guard held a message", r.session),
        line(
          `Its cache had expired, so sending it writes ${tok} again: ${usd(r.usd ?? 0)} at stake.`,
        ),
        line("Sent again it goes through; /clear starts from a note instead."),
      ].join("\n");
    case "cold-sent":
      return [
        head(dim("·"), "Guard: sent anyway", r.session),
        line(`${tok} was written to the cache again.`),
      ].join("\n");
    case "handoff-used":
      return [
        head(green("✓"), "Guard: started from the note", r.detail),
        line(
          `After /clear the new conversation started from guard's note: ${usd(r.usd ?? 0)} of rewrite not spent.`,
        ),
      ].join("\n");
    case "big-read":
      return [
        head(yellow("⏸"), "Guard held a read", r.session),
        line(
          `${file(r.detail)} whole is about ${tok} tokens; Claude was asked to read the part it needs.`,
        ),
      ].join("\n");
    case "retry":
      return [
        head(yellow("⏸"), "Guard held a retry", r.session),
        line(
          `${r.detail ?? "a command"} failed twice with nothing changed, so it was not run a third time.`,
        ),
      ].join("\n");
    case "compact":
      return [
        head(dim("·"), "Guard: a good moment to /compact", r.session),
        line(`It is at ${tok}, near where it compacts; guard suggested /compact between tasks.`),
      ].join("\n");
    default:
      return head(dim("·"), `Guard: ${String(r.kind)}`, r.session);
  }
}

/** The conversation that cost this live run the most, for `n` when nothing was found. */
export interface BiggestNow {
  sessionId: string;
  name: string;
  source: string;
  usd: number;
  runUsd: number;
  context: number;
  /** Re-reading it on the usual number of steps a message takes; null below 100K. */
  perMessageUsd: number | null;
}

/** A finding with its step, for `n` in live and under the checks. */
export interface LiveNextStep {
  rule: string;
  /** What the finding saw over its window. It is spent. */
  paidUsd: number;
  calls: number;
  spanMs: number;
  step: LiveStep;
}

/** The now and then lines of a step; `a` is named when it can make the setting. */
function stepLines(s: LiveStep, indent: string, keys?: boolean): string[] {
  const out: string[] = [];
  const now = wrap(s.now, 60);
  out.push(`${indent}${dim("now ")}  ${now[0] ?? ""}`);
  for (const l of now.slice(1)) out.push(`${indent}      ${l}`);
  if (s.later) {
    const later = wrap(s.later, 60);
    if (keys && s.apply) later[later.length - 1] += `  ${dim("(a applies it)")}`;
    out.push(`${indent}${dim("then")}  ${later[0] ?? ""}`);
    for (const l of later.slice(1)) out.push(`${indent}      ${l}`);
  }
  return out;
}

/**
 * `live` on `n`: the biggest finding's step, with what it already cost and
 * what it goes on costing per call until something changes.
 */
export function renderNextStep(
  s: LiveNextStep | null,
  opts: { now?: number; keys?: boolean; biggest?: BiggestNow | null } = {},
): string {
  const at = dim(new Date(opts.now ?? Date.now()).toLocaleTimeString());
  if (!s) {
    const out = [
      `  ${green("✓")}  ${at}  ${bold("No waste found")}`,
      `        ${dim("a step shows here once a finding comes up; ? shows what was checked")}`,
    ];
    // Nothing is wasted, but the money still goes somewhere: say where.
    const b = opts.biggest;
    if (b) {
      out.push(
        `        ${dim("most of this run:")} ${convoColor(b.sessionId)(clip(b.name, NAME_WIDTH))} ${dim(`${usd(b.usd)} of ${usd(b.runUsd)}`)}`,
      );
      if (b.perMessageUsd !== null) {
        const fresh = b.source === "claude-code" ? "/clear" : "/new";
        out.push(
          `        ${dim(`it is ${fmtTokens(b.context)} long, and re-reading it costs about`)} ${usd(b.perMessageUsd)} ${dim("a message here.")}`,
          `        ${dim(`Cheaper from here: /compact between tasks keeps a summary (early details can drop), ${fresh} starts empty.`)}`,
        );
      }
    }
    return out.join("\n");
  }
  const perCall = s.calls > 0 ? s.paidUsd / s.calls : 0;
  const out = [
    `  ${blue("→")}  ${at}  ${bold(`Next step: ${ruleLabel(s.rule).toLowerCase()}`)}`,
    `        ${dim("already paid   ")} ${usd(s.paidUsd)} ${dim(`over ${s.calls} calls, ${span(s.spanMs)}`)}`,
  ];
  if (perCall > 0) {
    out.push(
      `        ${dim("still avoidable")} ${dim("about")} ${usd(perCall)} ${dim("a call, until it changes")}`,
    );
  }
  out.push(...stepLines(s.step, "        ", opts.keys));
  return out.join("\n");
}

/**
 * `live`: what was checked and what each check saw, then one step for each
 * finding worth changing. Printed on `?` and when a run stops.
 */
export function renderLiveChecks(
  c: LiveChecks,
  opts: { now?: number; steps?: LiveNextStep[]; keys?: boolean } = {},
): string {
  const out: string[] = [];
  const now = opts.now ?? Date.now();
  if (c.calls === 0) {
    out.push(
      `  ${dim("·")}  ${dim(new Date(now).toLocaleTimeString())}  ${bold("Nothing to check yet")}`,
    );
    out.push(
      `        ${dim("no calls in the last hour; with the first one: cache, context, warm time, returns, rules")}`,
    );
    return out.join("\n");
  }
  const bad = c.checks.filter((x) => !x.ok).length;
  // A choice, like the model, is said but never counted as waste.
  const graded = c.checks.filter((x) => !x.note).length;
  const head = bad === 0 ? green("No waste found") : yellow(`${bad} of ${graded} need a look`);
  out.push(
    `  ${bad === 0 ? green("✓") : yellow("⚠")}  ${dim(new Date(now).toLocaleTimeString())}  ${bold(head)} ${dim(`· the last ${c.calls} calls, ${span(c.spanMs)}`)}`,
  );
  const width = Math.max(...c.checks.map((x) => x.name.length));
  for (const x of c.checks) {
    const mark = x.note ? dim("·") : x.ok ? green("✓") : yellow("!");
    out.push(`        ${mark} ${pad(x.name, width)}  ${dim(x.detail)}`);
  }
  for (const s of opts.steps ?? []) {
    out.push("");
    out.push(
      `        ${bold(`Next: ${ruleLabel(s.rule).toLowerCase()}`)} ${dim(`· ${usd(s.paidUsd)} already paid`)}`,
    );
    out.push(...stepLines(s.step, "          ", opts.keys));
  }
  return out.join("\n");
}

export function renderLiveRecommendation(
  rec: {
    recommendation: Recommendation;
    finding: OptimizationFinding;
    observedUsd: number;
    windowMs: number;
    windowEvents: number;
    trigger: { id: string; model: string; route?: string | undefined; ts: string };
    sessions?: number;
    examples?: readonly UsageEvent[];
    repeatOf?: number;
    judged?: { needsFrontierShare: number; sampled: number };
    withheld?: { by: string; needsFrontierShare: number; sampled: number };
  },
  opts: { replayed?: boolean } = {},
): string {
  const out: string[] = [];
  const f = rec.finding;
  const at = rec.trigger.ts ? new Date(rec.trigger.ts).toLocaleTimeString() : "";
  const tag = rec.withheld
    ? dim("HELD")
    : rec.repeatOf !== undefined
      ? yellow("GREW")
      : TIER_TAG[f.tier];

  out.push(
    `  ${tag}  ${dim(at)}  ${bold(rec.recommendation.action)} ${dim("·")} ${confidenceTag(f.savings.confidence)}`,
  );

  const where = rec.trigger.route ? ` ${dim("via")} ${blue(rec.trigger.route)}` : "";
  // Say which kind of window this is: `--backfill` replays history, so its span
  // is real but it isn't live traffic.
  out.push(
    opts.replayed
      ? `        ${bold(green(usd(rec.observedUsd)))} ${dim("could have been saved over")} ` +
          `${rec.windowEvents} ${dim("calls")} ${dim(`- replayed from history, not live traffic`)}${where}`
      : `        ${bold(green(usd(rec.observedUsd)))} ${dim("could have been saved over")} ` +
          `${rec.windowEvents} ${dim("calls /")} ${span(rec.windowMs)} ${dim("of traffic")}${where}`,
  );

  for (const line of wrap(f.title, 66)) out.push(`        ${line}`);
  for (const line of wrap(rec.recommendation.rationale, 66)) out.push(`        ${dim(line)}`);

  // Name the calls behind the number, so it can be traced to an agent.
  if (rec.examples && rec.examples.length > 0) {
    const n = rec.sessions ?? 1;
    out.push(`        ${dim(`from ${n} session${n === 1 ? "" : "s"}, latest:`)}`);
    for (const e of rec.examples) {
      const time = new Date(e.ts).toLocaleTimeString();
      out.push(
        `          ${dim(pad(time, 12))} ${pad(callSession(e), 12)} ${dim(pad(clip(projectName(e.project), 16), 16))} ${callActivity(e, 40)}`,
      );
    }
  }

  if (rec.withheld) {
    const pct = (rec.withheld.needsFrontierShare * 100).toFixed(0);
    out.push(
      `        ${yellow("withheld by " + rec.withheld.by)} ${dim(`- ${pct}% likely this traffic needs its model (${rec.withheld.sampled} judged)`)}`,
    );
    out.push(`        ${dim("not proposed. Re-run without --jev to see it anyway.")}`);
    return out.join("\n");
  }

  if (rec.judged) {
    const pct = (rec.judged.needsFrontierShare * 100).toFixed(0);
    out.push(
      `        ${dim(`jev: ${pct}% likely this traffic needs its model (${rec.judged.sampled} judged)`)}`,
    );
  }

  const verify = verificationModeOf(f);
  if (verify === "replay") {
    out.push(`        ${green(">")} ${dim(`optimaizr verify ${f.rule}`)}`);
  } else if (verify === "manual") {
    out.push(
      `        ${green(">")} ${dim(`optimaizr show ${f.rule}`)} ${dim("- needs your judgement")}`,
    );
  } else {
    out.push(
      `        ${green(">")} ${dim(`optimaizr apply ${f.rule}`)} ${dim("- safe, no quality question")}`,
    );
  }

  return out.join("\n");
}
