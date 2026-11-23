import {
  SINCE_RULE,
  blue,
  bold,
  dim,
  guardSaved,
  localDay,
  measureResults,
  red,
  renderResults,
  resultsDays,
  savedText,
  type AppliedChange,
} from "@optimaizr/core";
import { appliedChanges, readReceipts } from "@optimaizr/local";
import type { Args } from "../args.js";
import { load } from "../data.js";

/**
 * `optimaizr results [rule]`: for each change you applied, the days after it
 * against the days before. Loads as far back as the oldest change needs.
 *
 * `--since <date>` does the same for a change made outside optimAIzr, like
 * installing rtk or rewriting CLAUDE.md. Nothing is stored.
 */
export async function cmdResults(args: Args): Promise<void> {
  const now = Date.now();
  const applied = appliedChanges();
  const byDate = args.flags.since !== undefined || args.flags.label !== undefined;
  let changes: AppliedChange[];
  if (byDate) {
    const since = sinceChange(args, now);
    if (!since) return;
    changes = [since];
  } else {
    const rule = args.positional[0];
    changes = applied.filter((c) => !rule || c.rule === rule);
  }
  const data =
    changes.length > 0
      ? await load({ ...args, flags: { ...args.flags, days: String(resultsDays(changes, now)) } })
      : { events: [], compactions: [] };
  // Applied changes still count as other changes landing in the same period.
  const report = measureResults(data, changes, { now, others: applied });
  if (args.flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (byDate && report.results.length === 0) {
    console.log("");
    console.log(`  ${bold("optimAIzr")} ${dim("|")} results`);
    console.log("");
    console.log(`  No usage before or since ${localDay(changes[0]!.at)} to compare.`);
    console.log("");
    return;
  }
  const single = byDate || Boolean(args.positional[0]);
  const kept = single ? null : savedText(guardSaved(readReceipts(now - 7 * 86_400_000)));
  console.log(renderResults(report, { now, kept }));
}

/** A date at local midnight, or an exact time. */
export function parseSince(value: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) {
    const [y, m, d] = day.slice(1).map(Number) as [number, number, number];
    const t = new Date(y, m - 1, d);
    return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d
      ? t.getTime()
      : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function sinceChange(args: Args, now: number): AppliedChange | null {
  const fail = (what: string) => {
    console.log("");
    console.log(`  ${red(what)} ${dim("like")} ${blue("optimaizr results --since 2026-10-20")}`);
    console.log("");
    process.exitCode = 1;
    return null;
  };
  const value = args.flags.since;
  if (typeof value !== "string") {
    return fail(value === undefined ? "--label goes with --since," : "--since takes a date,");
  }
  const at = parseSince(value);
  if (at === null) return fail(`${value} is not a date,`);
  if (at >= now) return fail("--since has to be in the past,");
  const label = typeof args.flags.label === "string" ? args.flags.label.trim() : "";
  const iso = new Date(at).toISOString();
  return {
    id: `${SINCE_RULE}:${iso}`,
    rule: SINCE_RULE,
    how: "by-hand",
    at: iso,
    ...(label ? { label } : {}),
  };
}
