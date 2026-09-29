import { modelLabel } from "../pricing.js";
import { CATEGORY_LABEL, classifyAll } from "./classify.js";
import type { Dataset, UsageEvent } from "../domain/types.js";

/**
 * The "why am I spending so much?" tree: total -> provider -> model -> project
 * -> workload -> request. Data, not rendering, so the terminal and HTML views
 * share it. Each node has its cost and its share of the parent.
 */

export interface DrillNode {
  /** `provider` | `model` | `project` | `category` | `request` */
  level: string;
  key: string;
  label: string;
  costUsd: number;
  calls: number;
  tokens: number;
  /** Share of the parent node's cost, 0..1. */
  shareOfParent: number;
  /** Share of total spend, 0..1. */
  shareOfTotal: number;
  children: DrillNode[];
  /** Set on leaf request nodes so the UI can link to the call. */
  eventId?: string;
}

export interface DrillTree {
  totalUsd: number;
  totalCalls: number;
  children: DrillNode[];
}

const tokensOf = (e: UsageEvent) =>
  e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;

interface LevelSpec {
  level: string;
  key: (e: UsageEvent) => string;
  label?: (key: string, events: UsageEvent[]) => string;
}

/** The fixed drill order. */
const LEVELS: LevelSpec[] = [
  { level: "provider", key: (e) => e.provider || "unknown" },
  { level: "model", key: (e) => e.model, label: (k) => modelLabel(k) },
  {
    level: "project",
    key: (e) => e.project,
    label: (k) => k.split("/").slice(-1)[0] || k,
  },
  {
    level: "category",
    key: (e) => e.category ?? "unknown",
    label: (k) => CATEGORY_LABEL[k as keyof typeof CATEGORY_LABEL] ?? k,
  },
];

function group(events: UsageEvent[], spec: LevelSpec): Map<string, UsageEvent[]> {
  const out = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const k = spec.key(e);
    const arr = out.get(k);
    if (arr) arr.push(e);
    else out.set(k, [e]);
  }
  return out;
}

function buildLevel(
  events: UsageEvent[],
  depth: number,
  parentCost: number,
  totalCost: number,
  opts: { maxRequests: number },
): DrillNode[] {
  if (depth >= LEVELS.length) {
    // Leaf level: the individual requests, priciest first.
    return [...events]
      .sort((a, b) => b.cost.total - a.cost.total)
      .slice(0, opts.maxRequests)
      .map((e) => ({
        level: "request",
        key: e.id,
        label: `${e.route ?? e.sessionId.slice(0, 8)} · ${e.ts.slice(0, 16).replace("T", " ")}`,
        costUsd: e.cost.total,
        calls: 1,
        tokens: tokensOf(e),
        shareOfParent: parentCost > 0 ? e.cost.total / parentCost : 0,
        shareOfTotal: totalCost > 0 ? e.cost.total / totalCost : 0,
        children: [],
        eventId: e.id,
      }));
  }

  const spec = LEVELS[depth]!;
  const nodes: DrillNode[] = [];

  for (const [key, group_] of group(events, spec)) {
    const cost = group_.reduce((s, e) => s + e.cost.total, 0);
    nodes.push({
      level: spec.level,
      key,
      label: spec.label ? spec.label(key, group_) : key,
      costUsd: cost,
      calls: group_.length,
      tokens: group_.reduce((s, e) => s + tokensOf(e), 0),
      shareOfParent: parentCost > 0 ? cost / parentCost : 0,
      shareOfTotal: totalCost > 0 ? cost / totalCost : 0,
      children: buildLevel(group_, depth + 1, cost, totalCost, opts),
    });
  }

  return nodes.sort((a, b) => b.costUsd - a.costUsd);
}

export function buildDrillTree(data: Dataset, opts: { maxRequests?: number } = {}): DrillTree {
  classifyAll(data.events);
  const totalUsd = data.events.reduce((s, e) => s + e.cost.total, 0);
  return {
    totalUsd,
    totalCalls: data.events.length,
    children: buildLevel(data.events, 0, totalUsd, totalUsd, {
      maxRequests: opts.maxRequests ?? 3,
    }),
  };
}

/** Walk to a node by its key path, e.g. ["anthropic", "claude-sonnet-5"]. */
export function drillTo(tree: DrillTree, keyPath: string[]): DrillNode | null {
  let nodes = tree.children;
  let found: DrillNode | null = null;
  for (const key of keyPath) {
    const lower = key.toLowerCase();
    found =
      nodes.find((n) => n.key.toLowerCase() === lower) ??
      nodes.find((n) => n.label.toLowerCase() === lower) ??
      nodes.find((n) => n.key.toLowerCase().includes(lower)) ??
      null;
    if (!found) return null;
    nodes = found.children;
  }
  return found;
}
