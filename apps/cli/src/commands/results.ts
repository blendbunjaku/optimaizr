import { measureResults, renderResults, resultsDays } from "@optimaizr/core";
import { appliedChanges } from "@optimaizr/local";
import type { Args } from "../args.js";
import { load } from "../data.js";

/**
 * `optimaizr results [rule]`: for each change you applied, the days after it
 * against the days before. Loads as far back as the oldest change needs.
 */
export async function cmdResults(args: Args): Promise<void> {
  const now = Date.now();
  const rule = args.positional[0];
  const changes = appliedChanges().filter((c) => !rule || c.rule === rule);
  const data =
    changes.length > 0
      ? await load({ ...args, flags: { ...args.flags, days: String(resultsDays(changes, now)) } })
      : { events: [], compactions: [] };
  const report = measureResults(data, changes, { now });
  if (args.flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderResults(report, { now }));
}
