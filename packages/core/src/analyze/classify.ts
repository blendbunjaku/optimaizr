import type { UsageEvent, WorkloadCategory } from "../domain/types.js";

/**
 * Workload classification, inferred from a call's shape (reasoning tokens,
 * output size, tool count), not its intent. A short answer to a hard question
 * classifies as `mechanical`. Lets the drill-down group spend by what the model
 * was doing.
 */

/** Reasoning tokens above this mean the model really deliberated. */
const REASONING_FLOOR = 200;
/** Output above this is substantive generation rather than an acknowledgement. */
const GENERATION_FLOOR = 900;
/** Short output with no thinking and at most one tool is mechanical. */
const MECHANICAL_CEILING = 600;

export function classify(e: UsageEvent): WorkloadCategory {
  if (e.thinkingTokens >= REASONING_FLOOR) return "reasoning";
  if (e.tools.length >= 2) return "tool-orchestration";
  if (e.outputTokens >= GENERATION_FLOOR) return "generation";
  if (e.thinkingTokens === 0 && e.outputTokens < MECHANICAL_CEILING && e.tools.length <= 1) {
    return "mechanical";
  }
  return "unknown";
}

export const CATEGORY_LABEL: Record<WorkloadCategory, string> = {
  reasoning: "Reasoning",
  "tool-orchestration": "Tool orchestration",
  generation: "Generation",
  mechanical: "Mechanical",
  unknown: "Unclassified",
};

/** Stamp a category on every event that lacks one. Mutates in place. */
export function classifyAll(events: UsageEvent[]): void {
  for (const e of events) {
    if (!e.category) e.category = classify(e);
  }
}
