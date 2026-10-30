import fs from "node:fs";
import path from "node:path";
import {
  type AdapterSource,
  analyze,
  buildProfile,
  changeName,
  type ChangeResult,
  claudeConfigDir,
  guardSaved,
  ingest,
  isKnownRule,
  type LimitHit,
  monthDay,
  type OptimizationFinding,
  parsePlan,
  type PlanId,
  type Recommendation,
  ruleLabel,
  summarize,
  type UsageEvent,
  measureResults,
  weekCompare,
  weekText,
  windowRate,
} from "@optimaizr/core";
import {
  appliedChanges,
  compactionApplied,
  compactionStatus,
  detectClaudePlan,
  guardApplied,
  latestClaudeWindows,
  openChanges,
  optimaizrDir,
  readMeter,
  readReceipts,
  writeWindowRate,
} from "@optimaizr/local";
import { GUARD_SAID, guardCatchText } from "./notices.js";
import type { FixItem, ResultItem, Snapshot, Tier } from "./types.js";

/** Below this a month, a fix is folded into "+N smaller", as on the CLI's profile. */
export const WORTH_LISTING_USD = 0.25;
const WEEK_MS = 7 * 86_400_000;
const RECENT_MS = 2 * 3_600_000;

/**
 * Everything the sidebar shows, worked out the way `optimaizr profile` does it.
 * Heavy (it reads every transcript in the window), so it runs in a worker.
 */
export async function buildSnapshot(opts: { days?: number; now?: number } = {}): Promise<Snapshot> {
  const days = opts.days ?? 30;
  const now = opts.now ?? Date.now();
  const sources: AdapterSource[] = [
    { kind: "local-transcripts", days },
    { kind: "ledger", days },
  ];
  const data = await ingest(sources);
  const base = emptySnapshot(days, now);
  if (data.events.length === 0) {
    return {
      ...base,
      emptyReason: `No Claude Code, Codex or opencode history in the last ${days} days.`,
    };
  }

  const summary = summarize(data, {});
  const { findings } = analyze(data);
  const changes = appliedChanges();
  const results = measureResults(data, changes).results;
  const hits = limitHits(data.limitHits);
  const plan = choosePlan();
  const profile = buildProfile(
    data,
    summary,
    findings,
    undefined,
    plan
      ? {
          plan,
          limitHits: hits,
          windows: latestClaudeWindows(),
          dir: path.join(claudeConfigDir(), "projects"),
        }
      : undefined,
    { changes, results },
  );

  // Saved for guard and the mod too, as `profile` saves it.
  const learned = windowRate(readMeter(), data.events);
  const limitUsd = profile.plan?.limit?.usd ?? null;
  const rate = learned
    ? { basis: "meter" as const, ...learned }
    : limitUsd && limitUsd > 0
      ? { basis: "plan" as const, usdPerPercent: limitUsd / 100 }
      : null;
  if (rate) writeWindowRate(rate);

  const windowed = Boolean(profile.plan || profile.codex);
  const usageShare = (usd: number) => (profile.perMonthUsd > 0 ? usd / profile.perMonthUsd : 0);
  const fixOf = (r: Recommendation): FixItem => ({
    rule: r.rule,
    label: ruleLabel(r.rule),
    tier: r.tier as Tier,
    monthlyUsd: r.savings.monthlyUsd,
    usageShare: usageShare(r.savings.monthlyUsd),
    confidence: String(r.savings.confidence ?? ""),
    happened: r.happened,
    why: r.why,
    fix: r.fix,
    kind: r.rule === "context-compaction" ? "compaction" : "habit",
    doneAt: doneAt(r.rule),
    scope: scopeOf(findings, data.events, r.rule),
  });
  const listed = profile.opportunities.filter((r) => isKnownRule(r.rule));
  const fixes = listed.filter((r) => r.savings.monthlyUsd >= WORTH_LISTING_USD || doneAt(r.rule));

  const value = profile.plan && profile.plan.calls > 0 ? profile.plan : null;
  const codex = profile.codex?.priceUsd && profile.codex.multiple !== null ? profile.codex : null;
  const week = weekCompare(data.events, now, hits);
  const win = profile.biggestWin;

  return {
    ...base,
    empty: false,
    window: { from: profile.windowDays.from, to: profile.windowDays.to, days: profile.window.days },
    spend: {
      windowUsd: profile.spendUsd,
      perMonthUsd: profile.perMonthUsd,
      calls: profile.calls,
      tokens: profile.tokens.total,
    },
    plan: value
      ? {
          label: value.label,
          priceUsd: value.priceUsd,
          valueMonthlyUsd: value.valueMonthlyUsd,
          multiple: value.multiple,
          limitUsd: value.limit?.usd ?? null,
          current: value.current
            ? { usd: value.current.usd, end: value.current.end, share: value.current.limitShare }
            : null,
        }
      : codex
        ? {
            label: codex.label,
            priceUsd: codex.priceUsd ?? 0,
            valueMonthlyUsd: codex.valueMonthlyUsd,
            multiple: codex.multiple ?? 0,
            limitUsd: null,
            current: null,
          }
        : null,
    allIn: profile.allIn
      ? {
          share: profile.allIn.share,
          monthlyUsd: profile.allIn.monthlyUsd,
          moreWork: windowed ? profile.allIn.moreWork : 0,
          parts: profile.allIn.parts.map((p) => ({
            rule: p.rule,
            label: ruleLabel(p.rule),
            tier: p.tier as Tier,
            share: p.share,
          })),
        }
      : null,
    savings: {
      clearMonthlyUsd: profile.savingsMonthlyUsd,
      likelyMonthlyUsd: profile.likelyMonthlyUsd,
    },
    biggestWin: win
      ? { ...fixOf(win.recommendation), share: win.share, moreWork: windowed ? win.moreWork : 0 }
      : null,
    breakdown: { ...profile.breakdown },
    fixes: fixes.map(fixOf),
    smaller: listed.length - fixes.length,
    compaction: compactionNow(),
    guard: guardNow(now),
    results: profile.applied.map(resultOf),
    week: week ? `Last 7 days: ${weekText(week)}.` : null,
    rate: rate ? { usdPerPercent: rate.usdPerPercent, basis: rate.basis } : null,
    titles: { ...(data.titles ?? {}) },
    recent: data.events.filter(
      (e) => e.source === "claude-code" && !e.isSubagent && Date.parse(e.ts) >= now - RECENT_MS,
    ),
    firstLook: profile.firstLook
      ? { fact: profile.firstLook.fact, why: profile.firstLook.why }
      : null,
  };
}

/** Guard's week from its own log, cheap enough to re-read after every catch. */
export function guardNow(now = Date.now()): Snapshot["guard"] {
  const receipts = readReceipts(now - WEEK_MS);
  const saved = guardSaved(receipts);
  return {
    on: guardApplied(),
    catches: saved.catches,
    savedUsd: saved.usd,
    recent: receipts
      .filter((r) => GUARD_SAID.has(r.kind))
      .slice(-5)
      .reverse()
      .map((r) => ({ at: r.at, kind: r.kind, ...guardCatchText(r) })),
  };
}

export function emptySnapshot(days: number, now = Date.now()): Snapshot {
  return {
    version: 1,
    at: new Date(now).toISOString(),
    days,
    empty: true,
    window: { from: "", to: "", days: 0 },
    spend: { windowUsd: 0, perMonthUsd: 0, calls: 0, tokens: 0 },
    plan: null,
    allIn: null,
    savings: { clearMonthlyUsd: 0, likelyMonthlyUsd: 0 },
    biggestWin: null,
    breakdown: { reread: 0, output: 0, cacheWrite: 0, input: 0, tools: 0 },
    fixes: [],
    smaller: 0,
    compaction: compactionNow(),
    guard: { on: guardApplied(), catches: 0, savedUsd: 0, recent: [] },
    results: [],
    week: null,
    rate: null,
    titles: {},
    recent: [],
    firstLook: null,
  };
}

/** Claude Code's compaction point as the settings file has it now. */
export function compactionNow(): Snapshot["compaction"] {
  const set = compactionStatus()["claude-code"];
  const at = set && Number(set) > 0 ? Number(set) : null;
  const since = openChanges("context-compaction").find((c) => c.source === "claude-code");
  return { at, ours: compactionApplied().includes("claude-code"), since: since?.at ?? null };
}

/** The open by-hand record for a rule, as `apply --done` wrote it. */
export function doneAt(rule: string): string | null {
  return openChanges(rule).find((c) => c.how === "by-hand")?.at ?? null;
}

/** A plan in optimAIzr's config wins over what Claude Code's sign-in says, as in the CLI. */
function choosePlan(): PlanId | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(optimaizrDir(), "config.json"), "utf8"))?.plan;
    if (typeof raw === "string") {
      if (/^(api|none|off)$/i.test(raw.trim())) return null;
      const plan = parsePlan(raw);
      if (plan) return plan;
    }
  } catch {
    // No config, or not JSON: fall through to the sign-in.
  }
  const detected = detectClaudePlan();
  return detected.kind === "plan" ? detected.plan : null;
}

/** Limit hits from the transcripts and any recorded by hand, as `data.ts` collects them. */
function limitHits(
  recorded: Array<{ ts: string; window?: string; resetsAt?: string }> = [],
): LimitHit[] {
  const fromTranscripts = recorded
    .filter((h) => h.window === "five_hour")
    .map((h) => ({ ts: h.ts, ...(h.resetsAt ? { resetsAt: h.resetsAt } : {}) }));
  let byHand: string[] = [];
  try {
    byHand = fs
      .readFileSync(path.join(optimaizrDir(), "limits.jsonl"), "utf8")
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
    // Nothing recorded by hand.
  }
  return [...fromTranscripts, ...byHand];
}

/** One source or project when the finding only touched one, like `apply --done`. */
function scopeOf(
  findings: readonly OptimizationFinding[],
  events: readonly UsageEvent[],
  rule: string,
): FixItem["scope"] {
  const finding = findings.find((f) => f.rule === rule);
  if (!finding) return {};
  const hit = events.filter(finding.affects);
  const sources = new Set(hit.map((e) => e.source));
  const projects = new Set(hit.map((e) => e.project));
  return {
    ...(sources.size === 1 ? { source: [...sources][0]! } : {}),
    ...(projects.size === 1 ? { project: [...projects][0]! } : {}),
  };
}

function resultOf(r: ChangeResult): ResultItem {
  const c = r.headline?.change ?? 0;
  const per = `${Math.round(Math.abs(c) * 100)}% ${c < 0 ? "less" : "more"} per ${r.measure}`;
  const verdict = (
    ["working", "worse", "unclear", "too-early", "no-baseline"].includes(r.verdict)
      ? r.verdict
      : "none"
  ) as ResultItem["verdict"];
  const text =
    verdict === "too-early"
      ? r.progress.readyAround
        ? `first reading around ${monthDay(r.progress.readyAround)}`
        : "too early to tell"
      : verdict === "no-baseline"
        ? "not enough from before it to compare"
        : verdict === "working" || verdict === "worse"
          ? `${per} so far`
          : verdict === "unclear"
            ? `not clear yet (${per})`
            : `no clear effect yet (${per})`;
  return { name: changeName(r.change), since: r.change.at, verdict, text };
}
