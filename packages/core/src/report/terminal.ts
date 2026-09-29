import { modelLabel, usd, tokens as fmtTokens } from "../pricing.js";
import { verificationModeOf } from "../verify/state.js";
import type {
  ConfidenceLevel,
  EvidenceClass,
  OptimizationFinding,
  Recommendation,
} from "../domain/types.js";
import type { Summary, TopCall } from "../analyze/summary.js";
import type { DrillNode, DrillTree } from "../analyze/drilldown.js";
import type { Profile } from "../analyze/profile.js";
import type { BudgetCrossing, BudgetStatus } from "../analyze/budget.js";
import type { PlanView, SessionCrossing } from "../analyze/plan.js";
import type { CodexLimitCrossing, CodexPlanView } from "../analyze/codex-plan.js";

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

const SEVERITY: Record<OptimizationFinding["severity"], string> = {
  high: red("HIGH  "),
  medium: yellow("MEDIUM"),
  low: dim("LOW   "),
};

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

/** Confidence as a word. A bar or percentage would imply calibration it doesn't have. */
function confidenceTag(level: ConfidenceLevel): string {
  const colour = level === "high" ? green : level === "medium" ? yellow : red;
  return colour(level);
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
    mode === "not-required"
      ? green("safe to apply")
      : mode === "replay"
        ? magenta("needs verification")
        : magenta("needs your sign-off");

  out.push(`  ${SEVERITY[f.severity]}  ${bold(f.title)}`);
  out.push(
    `          ${bold(green(`${usd(s.monthlyUsd)}/mo`))} ${dim("|")} ${green(usd(s.annualUsd))}${dim("/yr")} ${dim("|")} ${gate} ${dim("|")} ${dim(f.category)}`,
  );
  out.push("");
  out.push(
    `          ${dim("now")} ${padLeft(usd(s.currentUsd), 9)}  ${dim("->")}  ${dim("after")} ${padLeft(usd(s.optimizedUsd), 9)}  ${dim(`(${f.affected.calls} calls, ${(f.affected.share * 100).toFixed(0)}% of spend)`)}`,
  );
  out.push(
    `          ${dim("confidence")} ${confidenceTag(s.confidence)}   ${dim("impact")} ${IMPACT[f.impact]}   ${dim("basis")} ${EVIDENCE[s.evidence.kind]}`,
  );
  out.push("");

  for (const line of wrap(f.detail, 72)) out.push(`          ${dim(line)}`);
  out.push("");
  for (const e of f.observations.slice(0, 4)) out.push(`          ${dim("-")} ${e}`);
  out.push("");
  for (const line of wrap(f.fix, 72)) out.push(`          ${green(">")} ${line}`);

  if (opts.verbose) {
    out.push("");
    out.push(`          ${dim(`Evidence: ${s.evidence.kind} - ${s.evidence.basis}`)}`);
    out.push("");
    out.push(`          ${dim("How this was calculated")}`);
    for (const line of wrap(s.calculation, 70)) out.push(`            ${dim(line)}`);
    out.push("");
    out.push(`          ${dim("Assumptions")}`);
    for (const a of s.assumptions) {
      const lines = wrap(a, 68);
      out.push(`            ${dim("*")} ${dim(lines[0] ?? "")}`);
      for (const line of lines.slice(1)) out.push(`              ${dim(line)}`);
    }
    out.push("");
    out.push(`          ${dim(`Confidence basis: ${s.confidenceBasis}`)}`);
  }

  return out;
}

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

  const recoverable = findings.filter((f) => !f.advisory);
  const advisories = findings.filter((f) => f.advisory);
  const totalMonthly = recoverable.reduce((s, f) => s + f.savings.monthlyUsd, 0);
  const totalAnnual = recoverable.reduce((s, f) => s + f.savings.annualUsd, 0);
  const share = summary.perMonth > 0 ? (totalMonthly / summary.perMonth) * 100 : 0;

  out.push(rule());
  out.push("");
  out.push(
    `  ${bold(red(usd(totalMonthly)))}${bold("/month")} ${dim("in estimated savings")} ${dim(`- ${share.toFixed(0)}% of your projected spend`)}`,
  );
  out.push(`  ${dim(`${usd(totalAnnual)}/year if the pattern holds`)}`);
  out.push("");
  out.push(
    `  ${dim("Estimates, not guarantees. Each figure is labelled")} ${EVIDENCE.measured}${dim(",")}`,
  );
  out.push(
    `  ${EVIDENCE.inferred} ${dim("or")} ${EVIDENCE.estimated}${dim(". Run with --why for every calculation.")}`,
  );
  out.push("");

  recoverable.forEach((f, i) => {
    out.push(...renderFinding(f, { verbose }));
    if (i < recoverable.length - 1) out.push("");
  });

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

export function renderRecommendations(recs: Recommendation[], monthlySpend: number): string {
  const out: string[] = [];
  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("| recommendations")}`);
  out.push("");

  if (recs.length === 0) {
    out.push(`  ${green("Nothing to recommend - no recoverable waste found.")}`);
    out.push("");
    return out.join("\n");
  }

  const total = recs.reduce((s, r) => s + r.savings.monthlyUsd, 0);
  const share = monthlySpend > 0 ? (total / monthlySpend) * 100 : 0;
  out.push(
    `  ${bold(green(usd(total)))}${bold("/month")} ${dim(`across ${recs.length} recommendations - ${share.toFixed(0)}% of spend`)}`,
  );
  out.push("");

  recs.forEach((r, i) => {
    out.push(`  ${bold(`${i + 1}. ${r.action}`)}  ${STATUS_TAG[r.status]}`);
    out.push("");
    out.push(
      `     ${dim("Potential savings")}  ${bold(green(`${usd(r.savings.monthlyUsd)}/month`))} ${dim(`(${usd(r.savings.annualUsd)}/year)`)}`,
    );
    out.push(`     ${dim("Why")}                ${r.rationale}`);
    out.push(`     ${dim("Expected impact")}    ${IMPACT[r.impact]}`);
    out.push(
      `     ${dim("Confidence")}         ${confidenceTag(r.savings.confidence)} ${dim(`(${r.savings.evidence.kind})`)}`,
    );
    out.push(
      `     ${dim("Affects")}            ${r.affected.calls.toLocaleString()} requests on ${r.affected.models.map(modelLabel).join(", ")}`,
    );
    out.push("");
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
};

export function ruleLabel(rule: string): string {
  return RULE_LABEL[rule] ?? rule;
}

export function renderProfile(p: Profile): string {
  const out: string[] = [];
  const row = (k: string, v: string, note = "") =>
    out.push(`  ${dim(pad(k, 20))} ${padLeft(v, 12)}${note ? `  ${dim(note)}` : ""}`);

  out.push("");
  out.push(`  ${bold("optimAIzr")} ${dim("|")} profile`);
  out.push(
    `  ${dim(`${p.windowDays.from} to ${p.windowDays.to}  (${Math.max(1, p.window.days).toFixed(1)} days)`)}`,
  );
  out.push("");
  out.push(rule());
  out.push("");

  out.push(`  ${bold("AI usage")}`);
  out.push("");
  row(
    "Spend",
    bold(usd(p.spendUsd)),
    `${usd(p.perMonthUsd)}/month ${p.pace === "last-30-days" ? "at the last 30 days' rate" : "at this rate"}`,
  );
  row("Calls", bold(p.calls.toLocaleString()));
  row(
    "Tokens",
    bold(fmtTokens(p.tokens.total)),
    `${fmtTokens(p.tokens.input)} in / ${fmtTokens(p.tokens.output)} out`,
  );
  out.push(`  ${dim("List rates applied to recorded tokens. Not a bill.")}`);
  out.push("");

  if (p.plan) out.push(...renderPlan(p.plan), "");
  if (p.codex) out.push(...renderCodexPlan(p.codex), "");
  if (p.budget) out.push(...renderBudget(p.budget), "");

  out.push(`  ${bold("Optimization")}`);
  out.push("");
  row(
    "Flagged calls",
    bold(p.flaggedCalls.toLocaleString()),
    `${(p.flaggedShare * 100).toFixed(1)}% of calls`,
  );
  row("Potential waste", bold(red(usd(p.wasteWindowUsd))), "in this window");
  row(
    "Potential savings",
    bold(green(`${usd(p.savingsMonthlyUsd)}/mo`)),
    `${usd(p.savingsAnnualUsd)}/year`,
  );
  out.push("");

  const top = p.bottleneck;
  if (!top) {
    out.push(rule());
    out.push("");
    out.push(`  ${green("No recoverable waste found above the reporting threshold.")}`);
    out.push("");
    out.push(`  ${bold("Next step")}`);
    out.push(`    ${blue(p.nextCommand)}   ${dim("see where the money goes instead")}`);
    out.push("");
    return out.join("\n");
  }

  out.push(rule());
  out.push("");
  out.push(`  ${bold("Biggest opportunity")}`);
  out.push("");
  out.push(`  ${yellow("!")} ${bold(ruleLabel(top.rule))}`);
  out.push("");
  for (const line of wrap(top.rationale, 62)) out.push(`    ${line}`);
  for (const line of wrap(`${top.affected.calls.toLocaleString()} calls affected.`, 62))
    out.push(`    ${dim(line)}`);
  out.push("");
  out.push(
    `    ${dim("Estimated savings")} ${bold(green(`${usd(top.savings.monthlyUsd)}/month`))} ${dim("|")} ${confidenceTag(top.savings.confidence)} ${dim("confidence,")} ${EVIDENCE[top.savings.evidence.kind]}`,
  );
  out.push("");

  out.push(`  ${bold("Top opportunities")}`);
  out.push("");
  p.opportunities.forEach((r, i) => {
    out.push(
      `  ${dim(`${i + 1}.`)} ${pad(ruleLabel(r.rule), 24)} ${padLeft(green(`${usd(r.savings.monthlyUsd)}/mo`), 12)}  ${dim(r.rule)}`,
    );
  });
  if (p.overlapping) {
    out.push("");
    out.push(`  ${dim("These overlap on some calls; the savings total counts each call once.")}`);
  }
  out.push("");

  out.push(rule());
  out.push("");
  out.push(`  ${bold("Next step")}`);
  out.push(`    ${blue(p.nextCommand)}`);
  const also: Array<[string, string]> = [
    [`optimaizr show ${top.id}`, "the requests it touches"],
    ["optimaizr recommend", "every opportunity, ranked"],
  ];
  const width = Math.max(...also.map(([cmd]) => cmd.length)) + 3;
  for (const [cmd, what] of also) out.push(`    ${dim(pad(cmd, width) + what)}`);
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

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** The profile's plan block: what the subscription is worth, and where sessions go. */
export function renderPlan(v: PlanView): string[] {
  const out: string[] = [];
  const row = (k: string, val: string, note = "") =>
    out.push(`  ${dim(pad(k, 20))} ${padLeft(val, 12)}${note ? `  ${note}` : ""}`);

  out.push(`  ${bold("Plan")}`);
  out.push("");
  row(
    v.label,
    bold(`${usd(v.priceUsd)}/mo`),
    dim(v.perSeat ? "per seat, billed monthly" : "what you pay"),
  );
  row(
    "API-equivalent",
    bold(green(`${usd(v.valueMonthlyUsd)}/mo`)),
    `${green(`${v.multiple >= 10 ? Math.round(v.multiple) : v.multiple.toFixed(1)}x`)} ${dim(
      v.valueDays < 30 ? `what you pay, from ${Math.round(v.valueDays)} days` : "what you pay",
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
  if (v.limit) {
    row(
      "Your session limit",
      bold(`~${usd(v.limit.usd)}`),
      dim(`learned from ${v.limit.hits} recorded hit${v.limit.hits === 1 ? "" : "s"}`),
    );
  } else {
    row("Your session limit", dim("unknown"), dim("run `optimaizr limit` when you hit it"));
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
  out.push(
    `  ${dim("Sessions are rebuilt from timestamps; the limit is not published, only learned.")}`,
    `  ${dim("The weekly limit on top of it is not tracked.")}`,
  );
  return out;
}

/** `Sep 26, 14:00` for a reset more than a day away, `01:00` otherwise. */
export function resetTime(iso: string): string {
  const far = Date.parse(iso) - Date.now() > 20 * 3_600_000;
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
  out.push(`  ${dim(`OpenAI's own figures, as Codex recorded them at ${localTime(v.readAt)}.`)}`);
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
  return `${Math.round(m / 60)}h`;
}

const SEVERITY_TAG: Record<OptimizationFinding["severity"], string> = {
  high: red("HIGH"),
  medium: yellow("MED "),
  low: dim("LOW "),
};

/**
 * One streamed recommendation. Quotes `observedUsd`, never `monthlyUsd`: a
 * window of minutes can't be projected to a month.
 */
export function renderLiveRecommendation(
  rec: {
    recommendation: Recommendation;
    finding: OptimizationFinding;
    observedUsd: number;
    windowMs: number;
    windowEvents: number;
    trigger: { id: string; model: string; route?: string | undefined; ts: string };
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
      : SEVERITY_TAG[f.severity];

  out.push(`  ${tag}  ${dim(at)}  ${bold(rec.recommendation.action)}`);

  const where = rec.trigger.route ? ` ${dim("via")} ${blue(rec.trigger.route)}` : "";
  // Say which kind of window this is: `--backfill` replays history, so its span
  // is real but it isn't live traffic.
  out.push(
    opts.replayed
      ? `        ${bold(red(usd(rec.observedUsd)))} ${dim("observed over")} ` +
          `${rec.windowEvents} ${dim("calls")} ${dim(`- replayed from history, not live traffic`)}${where}`
      : `        ${bold(red(usd(rec.observedUsd)))} ${dim("observed over")} ` +
          `${rec.windowEvents} ${dim("calls /")} ${span(rec.windowMs)} ${dim("of traffic")}${where}`,
  );

  for (const line of wrap(rec.recommendation.rationale, 66)) out.push(`        ${dim(line)}`);

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
