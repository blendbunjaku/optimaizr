import { type Dataset, planView, windowRate } from "@optimaizr/core";
import { latestClaudeWindows, readMeter, type ShareRate, writeWindowRate } from "@optimaizr/local";
import type { Args } from "./args.js";
import { resolvePlan } from "./config.js";
import { readLimitHits } from "./data.js";

/**
 * What 1% of Claude's 5h window costs: learned from the meter's history when
 * there is enough of it, else the plan's estimated limit. Saved for the mod,
 * which shows a turn's share with it.
 */
export function shareRate(
  events: Dataset["events"],
  plan: { limitUsd?: number | null } = {},
): ShareRate | null {
  const learned = windowRate(readMeter(), events);
  const rate: ShareRate | null = learned
    ? { basis: "meter", ...learned }
    : plan.limitUsd && plan.limitUsd > 0
      ? { basis: "plan", usdPerPercent: plan.limitUsd / 100 }
      : null;
  if (rate) writeWindowRate(rate);
  return rate;
}

/** The plan's estimated 5h limit in dollars, when a Claude plan is set or detected. */
export function planLimitUsd(args: Args, events: Dataset["events"]): number | null {
  const choice = resolvePlan(args);
  if (!choice.plan) return null;
  return (
    planView(events, [], {
      plan: choice.plan,
      source: choice.source ?? undefined,
      limitHits: readLimitHits(),
      windows: latestClaudeWindows(),
    }).limit?.usd ?? null
  );
}
