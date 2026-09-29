import { costOf, providerOf, usd } from "@optimaizr/core";
import type { Sample } from "../samples.js";
import { readSamples } from "../samples.js";
import type { VerifyCandidate } from "@optimaizr/core";
import {
  DEFAULT_BAR,
  addJudgeCost,
  dialectOf,
  emptyJudgeCost,
  judgePair,
  labelOf,
  outputLimitOf,
  providerOfDialect,
  runCheck,
  sendChat,
  setOutputLimit,
  textOf,
  type CheckResult,
  type Dialect,
  type QualityBar,
} from "@optimaizr/core";

/**
 * Shadow replay: re-run recorded traffic under a proposed change and compare.
 * Only the candidate is re-run; the baseline response and usage are already
 * recorded, which is the truer reference and half the cost.
 */

export interface VerifyResult {
  description: string;
  samples: number;
  baselineCostPerCall: number;
  candidateCostPerCall: number;
  /** Measured saving per call, from real replay usage. */
  savingPerCall: number;
  /** Projected monthly saving at the observed call volume. */
  monthlySaving: number;
  checks: CheckResult[];
  judge: { wins: number; losses: number; ties: number; winRate: number } | null;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  reasons: string[];
  /**
   * Cost of running the verification itself, measured from the usage the
   * replay and judge calls reported. A floor rather than a total whenever
   * `unpricedCalls` is above zero.
   */
  verificationCost: number;
  /**
   * Verification calls the catalogue couldn't price (unknown model, or no usage
   * reported). They're missing from `verificationCost`, not counted as free.
   */
  unpricedCalls: number;
}

/**
 * Rewrite a recorded request to express the candidate change, in the dialect it
 * arrived in, so replay measures the change and nothing else.
 */
export function applyCandidate(
  request: Record<string, any>,
  candidate: VerifyCandidate,
): Record<string, any> {
  const next: Record<string, any> = JSON.parse(JSON.stringify(request));
  const before = dialectOf(next);

  switch (candidate.kind) {
    case "swap-model": {
      const target = candidate.targetFor?.(next.model) ?? candidate.to;
      if (target) next.model = target;
      // Respect the target's output ceiling, in this dialect's field.
      const limit = outputLimitOf(next);
      if (typeof limit === "number") setOutputLimit(next, before, limit);
      break;
    }
    case "lower-effort": {
      const effort = candidate.to ?? "low";
      if (before === "anthropic-messages") {
        next.output_config = { ...(next.output_config ?? {}), effort };
      } else if (before === "openai-chat") {
        next.reasoning_effort = effort;
      } else {
        next.reasoning = { ...(next.reasoning ?? {}), effort };
      }
      break;
    }
    case "enable-cache": {
      // OpenAI caches automatically, so there's no request switch to flip; the
      // fix there is a stable prefix in the app.
      if (before !== "anthropic-messages") break;
      // Mark the end of the stable prefix so it can be reused.
      if (Array.isArray(next.tools) && next.tools.length > 0) {
        next.tools[next.tools.length - 1] = {
          ...next.tools[next.tools.length - 1],
          cache_control: { type: "ephemeral" },
        };
      } else if (typeof next.system === "string" && next.system.length > 0) {
        next.system = [{ type: "text", text: next.system, cache_control: { type: "ephemeral" } }];
      } else if (Array.isArray(next.system) && next.system.length > 0) {
        next.system[next.system.length - 1] = {
          ...next.system[next.system.length - 1],
          cache_control: { type: "ephemeral" },
        };
      }
      break;
    }
    case "trim-prompt":
      // Trimming is content-specific; the CLI supplies the trimmed system prompt.
      break;
  }
  return next;
}

/** The user's side of a recorded call, for showing to the judge. */
function promptOf(sample: Sample): string {
  const input = sample.request.input;
  if (typeof input === "string") return input;

  const msgs = ((sample.request.messages ?? input) as any[]) ?? [];
  const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
  const body = typeof last?.content === "string" ? last.content : textOf(last?.content);
  return body || JSON.stringify(last?.content ?? "").slice(0, 4000);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface VerifyOptions {
  /**
   * The SDK to replay with. A single client covers traffic from one vendor;
   * pass `clients` instead when the captured traffic spans two.
   */
  client?: any;
  /**
   * One client per provider id, e.g. `{ anthropic, openai }`. Samples (and the
   * judge) go back to their own vendor; a sample with no client is skipped.
   */
  clients?: Record<string, any>;
  candidate: VerifyCandidate;
  bar?: QualityBar;
  route?: string;
  /** Monthly call volume for this route, used to project the saving. */
  monthlyCalls?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Default output ceiling when a recorded request did not set one. */
const DEFAULT_MAX_OUTPUT = 2048;

function clientFor(opts: VerifyOptions, provider: string): any {
  return opts.clients?.[provider] ?? opts.client;
}

export async function verifyCandidate(opts: VerifyOptions): Promise<VerifyResult> {
  const bar = opts.bar ?? DEFAULT_BAR;
  const all = await readSamples({ route: opts.route });
  const samples = all.slice(-(bar.sampleSize ?? 40));

  if (samples.length === 0) {
    return {
      description: opts.candidate.description,
      samples: 0,
      baselineCostPerCall: 0,
      candidateCostPerCall: 0,
      savingPerCall: 0,
      monthlySaving: 0,
      checks: [],
      judge: null,
      verdict: "INCONCLUSIVE",
      reasons: [
        "No captured samples to replay. Enable capture in wrap() to verify on your own traffic.",
      ],
      verificationCost: 0,
      unpricedCalls: 0,
    };
  }

  let verificationCost = 0;
  let unpricedCalls = 0;
  let done = 0;

  const skipped = new Set<string>();

  const replayed = await mapLimit(samples, opts.concurrency ?? 4, async (sample) => {
    const request = applyCandidate(sample.request as Record<string, any>, opts.candidate);
    const dialect: Dialect = dialectOf(request);
    const provider = providerOfDialect(dialect);
    const fail = (error: string) => {
      opts.onProgress?.(++done, samples.length);
      return { sample, response: null as any, cost: 0, error };
    };

    const client = clientFor(opts, provider);
    if (!client) {
      skipped.add(provider);
      return fail(`no ${provider} client supplied`);
    }

    // Every dialect needs an output ceiling, under its own name.
    if (outputLimitOf(request) === undefined) {
      setOutputLimit(request, dialect, DEFAULT_MAX_OUTPUT);
    }

    try {
      const response = await sendChat(client, request, dialect);
      const cost = costOf(response?.usage, response?.model ?? request.model);
      verificationCost += cost.total;
      // A replay the catalogue cannot price still happened and still cost
      // money; count it as unknown rather than let it read as free.
      if (cost.unpriced) unpricedCalls++;
      opts.onProgress?.(++done, samples.length);
      return { sample, response, cost: cost.total, error: null as string | null };
    } catch (err: any) {
      return fail(err?.message ? String(err.message) : "request failed");
    }
  });

  const ok = replayed.filter((r) => r.response);
  const failed = replayed.length - ok.length;

  // Deterministic checks.
  const checks: CheckResult[] = bar.checks.map((check) => {
    let basePass = 0;
    let candPass = 0;
    for (const r of ok) {
      if (runCheck(check, r.sample.response.content, r.sample.response.content)) basePass++;
      if (runCheck(check, r.response, r.sample.response.content)) candPass++;
    }
    return {
      label: labelOf(check),
      baselinePassed: basePass,
      candidatePassed: candPass,
      total: ok.length,
      ok: candPass >= basePass,
    };
  });

  // Pairwise judging needs the client for the judge model's provider, which
  // may differ from the replayed traffic's.
  let judge: VerifyResult["judge"] = null;
  const judgeProvider = bar.judge ? providerOf(bar.judge.model) : "";
  const judgeClient = bar.judge ? clientFor(opts, judgeProvider) : null;

  if (bar.judge && ok.length > 0 && judgeClient) {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let judgeCost = emptyJudgeCost();
    await mapLimit(ok, Math.min(3, opts.concurrency ?? 3), async (r) => {
      try {
        const { verdict, cost } = await judgePair(
          judgeClient,
          bar.judge!,
          promptOf(r.sample),
          textOf(r.sample.response.content),
          textOf(r.response),
        );
        judgeCost = addJudgeCost(judgeCost, cost);
        if (verdict === "candidate") wins++;
        else if (verdict === "baseline") losses++;
        else ties++;
      } catch {
        ties++;
      }
    });
    const n = wins + losses + ties;
    judge = { wins, losses, ties, winRate: n > 0 ? (wins + ties * 0.5) / n : 0 };
    // Judging is priced from its own reported usage too.
    verificationCost += judgeCost.usd;
    unpricedCalls += judgeCost.unpriced;
  }

  // Measured economics, from real replay usage against real recorded usage.
  const baselineTotal = ok.reduce(
    (s, r) => s + costOf(r.sample.response.usage as any, r.sample.model).total,
    0,
  );
  const candidateTotal = ok.reduce((s, r) => s + r.cost, 0);
  const baselineCostPerCall = ok.length ? baselineTotal / ok.length : 0;
  const candidateCostPerCall = ok.length ? candidateTotal / ok.length : 0;
  const savingPerCall = baselineCostPerCall - candidateCostPerCall;

  // Verdict.
  const reasons: string[] = [];
  let verdict: VerifyResult["verdict"] = "PASS";

  if (skipped.size > 0) {
    // A missing key, not a quality failure: say so.
    reasons.push(
      `Skipped traffic from ${[...skipped].join(" and ")}: no client for it. Set the API key and re-run to include it.`,
    );
    verdict = "INCONCLUSIVE";
  }
  if (bar.judge && !judgeClient) {
    reasons.push(
      `Judge model ${bar.judge.model} is a ${judgeProvider} model and no ${judgeProvider} client was supplied, so judging was skipped.`,
    );
    if (verdict === "PASS") verdict = "INCONCLUSIVE";
  }
  if (failed > 0) {
    reasons.push(`${failed}/${replayed.length} replays failed outright`);
    if (failed / replayed.length > 0.05) verdict = "FAIL";
  }
  for (const c of checks) {
    if (!c.ok) {
      reasons.push(
        `Check "${c.label}" regressed: ${c.candidatePassed}/${c.total} vs baseline ${c.baselinePassed}/${c.total}`,
      );
      verdict = "FAIL";
    }
  }
  if (judge) {
    const min = bar.judge?.minWinRate ?? 0.45;
    if (judge.winRate < min) {
      reasons.push(
        `Judge win rate ${(judge.winRate * 100).toFixed(0)}% is below the ${(min * 100).toFixed(0)}% bar (${judge.wins}W/${judge.losses}L/${judge.ties}T)`,
      );
      verdict = "FAIL";
    } else {
      reasons.push(
        `Judge win rate ${(judge.winRate * 100).toFixed(0)}% clears the ${(min * 100).toFixed(0)}% bar (${judge.wins}W/${judge.losses}L/${judge.ties}T)`,
      );
    }
  }
  if (unpricedCalls > 0) {
    // Not a quality problem, but the verification cost is understated: say so.
    reasons.push(
      `${unpricedCalls} verification call${unpricedCalls === 1 ? "" : "s"} could not be priced (unknown model or no usage reported), so ${usd(verificationCost)} is a floor, not the full cost of this check.`,
    );
  }
  if (savingPerCall <= 0) {
    reasons.push(
      `No measured saving: ${usd(candidateCostPerCall)} vs ${usd(baselineCostPerCall)} per call`,
    );
    if (verdict === "PASS") verdict = "FAIL";
  }
  if (ok.length < 10 && verdict === "PASS") {
    verdict = "INCONCLUSIVE";
    reasons.push(`Only ${ok.length} usable samples. Capture more traffic before trusting this`);
  }

  return {
    description: opts.candidate.description,
    samples: ok.length,
    baselineCostPerCall,
    candidateCostPerCall,
    savingPerCall,
    monthlySaving: savingPerCall * (opts.monthlyCalls ?? 0),
    checks,
    judge,
    verdict,
    reasons,
    verificationCost,
    unpricedCalls,
  };
}
