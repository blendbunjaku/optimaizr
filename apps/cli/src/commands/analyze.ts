import fs from "node:fs";
import path from "node:path";
import {
  analyze,
  blue,
  bold,
  buildDrillTree,
  computeMetrics,
  dim,
  drillTo,
  findWaste,
  green,
  recoverableAnnual,
  recoverableMonthly,
  red,
  renderAnalytics,
  renderDrilldown,
  renderFindings,
  renderHtml,
  renderNextSteps,
  renderRecommendations,
  renderSummary,
  rule,
  ruleErrorWarning,
  savingsOverlap,
  summarize,
  tokens as fmtTokens,
  toRecommendations,
  usd,
} from "@optimaizr/core";
import { Args, num } from "../args.js";
import { emptyNotice, load, stripFns, summaryOptions } from "../data.js";

export async function cmdScan(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();

  const summary = summarize(data, summaryOptions(args));
  const { findings, errors } = analyze(data);

  if (args.flags.json) {
    console.log(
      JSON.stringify(
        {
          summary,
          savings: {
            monthlyUsd: recoverableMonthly(findings),
            annualUsd: recoverableAnnual(findings),
            overlap: savingsOverlap(findings),
            note: "Estimates. Each finding carries its own assumptions and confidence. Findings that claim the same call are counted once, at the largest claim, so the total is at or below their sum.",
          },
          findings: stripFns(findings),
          errors,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(renderSummary(summary, { title: "spend report" }));
  console.log(renderFindings(findings, summary, { verbose: Boolean(args.flags.why) }));
  console.log(renderNextSteps(findings));

  // Always print detector failures: a missing detector changes what the report
  // leaves out, which nobody can see from the report itself.
  for (const e of errors) console.log(`  ${red(`warning: ${ruleErrorWarning(e)}`)}`);
  if (errors.length) console.log("");

  for (const w of data.warnings.slice(0, 3)) console.log(`  ${dim(`note: ${w}`)}`);
  if (data.warnings.length) console.log("");
}

export async function cmdWaste(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();
  const findings = findWaste(data);
  if (args.flags.json) {
    console.log(JSON.stringify(stripFns(findings), null, 2));
    return;
  }
  console.log(
    renderFindings(findings, summarize(data, summaryOptions(args)), {
      verbose: Boolean(args.flags.why),
    }),
  );
}

export async function cmdTokens(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();
  const summary = summarize(data, summaryOptions(args));
  if (args.flags.json) {
    console.log(
      JSON.stringify(
        {
          totalTokens: summary.totalTokens,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          cacheReadTokens: summary.cacheReadTokens,
          cacheWriteTokens: summary.cacheWriteTokens,
          avgTokensPerCall: summary.avgTokensPerCall,
          byModel: summary.byModel,
          byProvider: summary.byProvider,
          topByCost: summary.topByCost,
          topByTokens: summary.topByTokens,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(renderSummary(summary, { title: "token analytics" }));
  console.log(renderAnalytics(summary));
}

export async function cmdReport(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();
  const summary = summarize(data, summaryOptions(args));
  const findings = findWaste(data);
  const out =
    typeof args.flags.out === "string"
      ? args.flags.out
      : path.resolve(process.cwd(), "optimaizr-report.html");
  const recs = toRecommendations(findings, data.events.length);
  const org = typeof args.flags.org === "string" ? args.flags.org : undefined;
  fs.writeFileSync(out, renderHtml(summary, findings, { recommendations: recs, org }));
  console.log("");
  console.log(`  ${green("Report written")} ${dim(out)}`);
  console.log(
    `  ${dim(`${usd(summary.perMonth)}/mo projected spend, ${usd(recoverableMonthly(findings))}/mo estimated savings`)}`,
  );
  console.log("");
}

/**
 * `optimaizr why`: total -> provider -> model -> project -> workload -> request,
 * each level with its share of the one above.
 */
export async function cmdWhy(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();

  const tree = buildDrillTree(data, { maxRequests: num(args.flags.requests, 3) });
  const keyPath = args.positional;

  if (args.flags.json) {
    console.log(JSON.stringify(keyPath.length ? drillTo(tree, keyPath) : tree, null, 2));
    return;
  }

  if (keyPath.length > 0) {
    const node = drillTo(tree, keyPath);
    if (!node) {
      console.log("");
      console.log(`  ${red("No such path:")} ${keyPath.join(" -> ")}`);
      console.log(`  ${dim("Run")} ${blue("optimaizr why")} ${dim("to see what is available.")}`);
      console.log("");
      process.exitCode = 1;
      return;
    }
    console.log(
      renderDrilldown(
        { totalUsd: node.costUsd, totalCalls: node.calls, children: node.children },
        { depth: num(args.flags.depth, 3), title: keyPath.join(" -> ") },
      ),
    );
    return;
  }

  console.log(renderDrilldown(tree, { depth: num(args.flags.depth, 2) }));
}

/** `optimaizr recommend`: ranked actions, each with its decision state. */
export async function cmdRecommend(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();

  const summary = summarize(data, summaryOptions(args));
  const recs = toRecommendations(findWaste(data), data.events.length);

  if (args.flags.json) {
    console.log(JSON.stringify(recs, null, 2));
    return;
  }
  console.log(renderRecommendations(recs, summary.perMonth));
}

/** `optimaizr audit`: what you spend, what's recoverable, and the top reasons. */
export async function cmdAudit(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();

  const summary = summarize(data, summaryOptions(args));
  const findings = findWaste(data);
  const monthly = recoverableMonthly(findings);
  const annual = recoverableAnnual(findings);
  const share = summary.perMonth > 0 ? (monthly / summary.perMonth) * 100 : 0;
  const top = findings.filter((f) => !f.advisory).slice(0, 5);

  if (args.flags.json) {
    console.log(
      JSON.stringify(
        {
          monthlySpendUsd: summary.perMonth,
          monthlySavingsUsd: monthly,
          annualSavingsUsd: annual,
          reductionPercent: share,
          reasons: top.map((f) => ({
            title: f.title,
            monthlyUsd: f.savings.monthlyUsd,
            evidence: f.savings.evidence.kind,
            confidence: f.savings.confidence,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| AI savings audit")}`);
  console.log(
    `  ${dim(`${summary.calls.toLocaleString()} requests over ${summary.window.days.toFixed(0)} days`)}`,
  );
  console.log("");
  console.log(`  ${dim("Your AI spend")}`);
  console.log(`  ${bold(usd(summary.perMonth))}${dim("/month")}`);
  console.log("");
  console.log(`  ${dim("Potential savings")}`);
  console.log(
    `  ${bold(green(usd(monthly)))}${dim("/month")}   ${dim(`${share.toFixed(1)}% of current spend`)}`,
  );
  console.log("");
  console.log(`  ${dim("Annual opportunity")}`);
  console.log(`  ${bold(green(usd(annual)))}${dim("/year")}`);
  console.log("");
  console.log(rule());
  console.log("");
  console.log(`  ${bold(`Top ${top.length} reason${top.length === 1 ? "" : "s"}`)}`);
  console.log("");
  top.forEach((f, i) => {
    console.log(`  ${dim(`${i + 1}.`)} ${bold(f.title)}`);
    console.log(
      `     ${green(`${usd(f.savings.monthlyUsd)}/mo`)} ${dim("|")} ${dim(`${f.savings.confidence} confidence`)} ${dim("|")} ${dim(f.savings.evidence.kind)}`,
    );
    console.log("");
  });
  console.log(`  ${dim("Estimates based on your observed usage. Not guarantees.")}`);
  const overlap = savingsOverlap(findings);
  if (overlap.removedWindowUsd > 0) {
    // The findings add up to more than the headline, so say where the difference went.
    const contended = overlap.contended[0];
    console.log(
      `  ${dim(`Findings overlap on ${overlap.contended.reduce((n, c) => n + c.calls, 0)} calls${contended ? ` (${contended.rules.join(" + ")})` : ""}; each call is counted once, at its largest claim, so the total above is below their sum.`)}`,
    );
  }
  console.log("");
  console.log(`  ${blue("optimaizr recommend")} ${dim("to see exactly what to change")}`);
  console.log(`  ${blue("optimaizr report")}    ${dim("to produce a shareable savings report")}`);
  console.log("");
}

/** `optimaizr metrics`: how much was analysed and found, computed locally. */
export async function cmdMetrics(args: Args): Promise<void> {
  const data = await load(args);
  if (data.events.length === 0) return emptyNotice();

  const findings = findWaste(data);
  const recs = toRecommendations(findings, data.events.length);
  const m = computeMetrics(data, findings, recs);

  if (args.flags.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }

  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| product metrics")}`);
  console.log("");
  const row = (k: string, v: string) => console.log(`  ${dim(k.padEnd(30))} ${v}`);

  row("projects", String(m.projects));
  row("providers", String(m.providers));
  row("models", String(m.models));
  console.log("");
  row("analysed requests", m.analyzedRequests.toLocaleString());
  row("analysed tokens", fmtTokens(m.analyzedTokens));
  row("analysed spend", usd(m.analyzedSpendUsd));
  console.log("");
  console.log(`  ${bold("Total potential savings identified")}`);
  row("  monthly", green(usd(m.totalPotentialSavingsMonthlyUsd)));
  row("  annual", green(usd(m.totalPotentialSavingsAnnualUsd)));
  row("  as share of spend", `${(m.identifiedSavingsRate * 100).toFixed(1)}%`);
  console.log("");
  row("recommendations", String(m.recommendations));
  row("  viewed", String(m.recommendationsViewed));
  row("  simulated", String(m.recommendationsSimulated));
  row("  verified", String(m.recommendationsVerified));
  row("  applied", String(m.recommendationsAccepted));
  console.log("");
  row("simulated savings", usd(m.simulatedSavingsUsd));
  row("realised savings", usd(m.realisedSavingsUsd));
  console.log("");
  console.log(`  ${dim("Identified is not realised. The gap between the two is the number")}`);
  console.log(`  ${dim("that actually matters, so both are always shown together.")}`);
  console.log("");
  row("findings: measured", String(m.findingsByEvidence.measured));
  row("findings: inferred", String(m.findingsByEvidence.inferred));
  row("findings: estimated", String(m.findingsByEvidence.estimated));
  console.log("");
}
