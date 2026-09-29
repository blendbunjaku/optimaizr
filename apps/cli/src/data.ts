import fs from "node:fs";
import path from "node:path";
import {
  type AdapterSource,
  blue,
  bold,
  type Dataset,
  dim,
  ingest,
  type OptimizationFinding,
  red,
  resolveTimeZone,
  type SummaryOptions,
} from "@optimaizr/core";
import { optimaizrDir } from "@optimaizr/local";
import { Args, num } from "./args.js";

/** Recorded session-limit hits, oldest first. One `{"ts": ISO}` per line. */
export function limitsPath(): string {
  return path.join(optimaizrDir(), "limits.jsonl");
}

export function readLimitHits(): string[] {
  try {
    return fs
      .readFileSync(limitsPath(), "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const ts = JSON.parse(line)?.ts;
          return typeof ts === "string" && Number.isFinite(Date.parse(ts)) ? [ts] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Everything a budget needs: the whole month plus the fortnight before it,
 * whatever `--days` asked the rest of the report to cover.
 */
export async function loadForBudget(args: Args): Promise<Dataset["events"] | undefined> {
  if (!args.flags.days) return undefined;
  return (await load({ ...args, flags: { ...args.flags, days: "46" } })).events;
}

/** Collect usage from every adapter that serves the requested sources. */
export async function load(args: Args): Promise<Dataset> {
  const days = args.flags.days ? num(args.flags.days, 30) : undefined;
  const project = typeof args.flags.project === "string" ? args.flags.project : undefined;
  const source = String(args.flags.source ?? "all");

  const sources: AdapterSource[] = [];
  if (source === "all" || source === "agents") {
    sources.push({ kind: "local-transcripts", days, project });
  }
  if (source === "all" || source === "sdk") {
    sources.push({ kind: "ledger", days, project });
  }
  const data = await ingest(sources);

  // A failed source means every figure below is missing its spend, so say so
  // here, once, for every command. stderr, so `--json` stays parseable.
  for (const f of data.failures ?? []) {
    console.error("");
    console.error(`  ${red(`warning: could not read ${f}`)}`);
    console.error(`  ${dim("That source is missing from everything below.")}`);
    console.error(`  ${dim("This is a bug. optimaizr feedback says where to report it.")}`);
  }
  if (data.failures?.length) console.error("");
  return data;
}

/**
 * The zone day buckets are cut in: UTC by default so machines agree, `--tz
 * local`, or any IANA name. The report always prints which.
 */
export function summaryOptions(args: Args): SummaryOptions {
  const tz = args.flags.tz;
  if (typeof tz !== "string" || tz.trim() === "") return {};
  const wanted = tz.trim();
  const timeZone = /^utc$/i.test(wanted) ? "UTC" : /^local$/i.test(wanted) ? "local" : wanted;
  const resolved = resolveTimeZone(timeZone);
  // Reject an unusable zone loudly rather than labelling UTC days with it.
  if (resolved !== "UTC") {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: resolved }).format(new Date());
    } catch {
      console.log(`  ${red(`warning: unknown timezone "${wanted}", using UTC`)}`);
      return {};
    }
  }
  return { timeZone };
}

export function emptyNotice(): void {
  console.log("");
  console.log(`  ${bold("optimAIzr")} ${dim("| nothing to analyse yet")}`);
  console.log("");
  console.log(`  ${dim("Three ways to get data in:")}`);
  console.log("");
  console.log(`  ${bold("Your coding agents")} ${dim("- no changes required")}`);
  console.log(
    `    ${dim("optimAIzr reads Claude Code (~/.claude/projects) and Codex (~/.codex/sessions).")}`,
  );
  console.log("");
  console.log(`  ${bold("Your app")} ${dim("- one line, Anthropic or OpenAI")}`);
  console.log(
    `    ${blue('const client = optimaizr.wrap(new Anthropic(), { service: "my-api" });')}`,
  );
  console.log(`    ${blue('const client = optimaizr.wrap(new OpenAI(), { service: "my-api" });')}`);
  console.log("");
  console.log(`  ${bold("An export you already have")} ${dim("- CSV or JSON")}`);
  console.log(`    ${blue("optimaizr import usage-export.csv")}`);
  console.log("");
}

/** Findings carry predicate functions; strip them for JSON output. */
export function stripFns(findings: OptimizationFinding[]): unknown[] {
  // `claimByEvent` is internal accounting (and a Map serialises to `{}`).
  return findings.map(({ affects: _affects, claimByEvent: _claims, ...f }) => ({
    ...f,
    candidate: f.candidate
      ? {
          kind: f.candidate.kind,
          from: f.candidate.from,
          to: f.candidate.to,
          description: f.candidate.description,
        }
      : undefined,
  }));
}
