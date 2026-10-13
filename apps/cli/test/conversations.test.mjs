import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  conversations,
  costOf,
  endsTurn,
  priceFor,
  ratesFor,
  renderSessions,
  renderTurnDone,
  sessionStats,
  summarize,
  turnCalls,
  windowRate,
  windowShareLabel,
  workLabel,
  workMs,
} from "@optimaizr/core";
import { readDesktopMeter, readMeterLog, recordMeter } from "@optimaizr/local";
import { load, read, START, transcript } from "./fixtures/transcripts.mjs";

/**
 * Which conversations cost the most, how long the agent worked on each, and
 * what a turn's dollars are as a share of Claude's five-hour window.
 */

const MIN = 60_000;
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("Haiku 5.5 is a tenth of Haiku 4.5 up to 100K of prompt, and 5x that past it", () => {
  const haiku = priceFor("claude-haiku-5-5");
  assert.equal(haiku.label, "Haiku 5.5");
  assert.equal(haiku.contextTokens, 1_000_000);

  const low = ratesFor(haiku, { promptTokens: 100_000 });
  assert.equal(low.inputPerM, 0.1);
  assert.equal(low.outputPerM, 0.5);
  assert.ok(near(low.cachedInputPerM, 0.01));
  assert.ok(near(low.cacheWrite5mPerM, 0.125));
  assert.ok(near(low.cacheWrite1hPerM, 0.2));

  const high = ratesFor(haiku, { promptTokens: 100_001 });
  assert.equal(high.inputPerM, 0.5);
  assert.equal(high.outputPerM, 2.5);
  assert.ok(near(high.cachedInputPerM, 0.05));
  assert.ok(near(high.cacheWrite5mPerM, 0.625));
  assert.ok(near(high.cacheWrite1hPerM, 1));

  // The prompt counts cache reads too: 50K fresh plus 50,001 read is over the line.
  const usage = { input_tokens: 50_000, output_tokens: 1_000, cache_read_input_tokens: 50_000 };
  assert.ok(near(costOf(usage, "claude-haiku-5-5").total, 0.006));
  const over = { ...usage, cache_read_input_tokens: 50_001 };
  assert.ok(near(costOf(over, "claude-haiku-5-5").total, 0.025 + 50_001 * 0.05e-6 + 0.0025));
});

/** Two turns, the second with a 20-minute pause inside it, and a subagent. */
function workday(session) {
  return [
    ...transcript(session, [
      { prompt: "fix the login" },
      { tools: [read("/w/login.ts")] },
      { out: 300 },
      { prompt: "and the tests", gap: 30 },
      { out: 300, gap: 20 },
      { out: 200 },
      { prompt: "look around", side: "a1" },
      { out: 100, side: "a1" },
    ]),
    { type: "ai-title", sessionId: session, aiTitle: "Fix the login" },
    { type: "ai-title", sessionId: session, aiTitle: "Fix the login bug" },
  ];
}

test("a conversation adds up its subagents, under its last title", async () => {
  const data = await load({
    s1: workday("s1"),
    s2: transcript("s2", [{ prompt: "hi" }, { out: 50 }]),
  });
  assert.deepEqual(data.titles, { s1: "Fix the login bug" });

  const rows = conversations(data);
  assert.deepEqual(
    rows.map((r) => r.sessionId),
    ["s1", "s2"],
    "costliest first",
  );
  const [s1, s2] = rows;
  assert.equal(s1.title, "Fix the login bug");
  assert.equal(s2.title, undefined);
  assert.equal(s1.turns, 2);
  assert.equal(s1.calls, 5);

  const of = (id, sub) =>
    data.events
      .filter((e) => e.sessionId === id && (sub === undefined || e.isSubagent === sub))
      .reduce((s, e) => s + e.cost.total, 0);
  assert.ok(near(s1.costUsd, of("s1")));
  assert.ok(near(s1.subagentUsd, of("s1", true)));
  assert.ok(s1.subagentUsd > 0);

  // Turn one: prompt to answer, 60s. Turn two: the 20-minute pause is left out, 20s remain.
  assert.equal(s1.workMs, 80_000);
});

test("work time leaves out long pauses and counts overlapping turns once", () => {
  const at = (m) => new Date(START + m * MIN).toISOString();
  const call = (turnId, m, extra = {}) => ({
    ts: at(m),
    turnId,
    turnStartedAt: at(extra.from ?? m),
    ...extra,
  });
  // A prompt queued while the first turn ran: 0-10 and 5-12 overlap, 12 minutes in all.
  assert.equal(workMs([call("a", 10, { from: 0 }), call("b", 12, { from: 5 })]), 12 * MIN);
  // An answer written over a minute counts to its last record.
  assert.equal(workMs([call("a", 2, { from: 0, endTs: at(3) })]), 3 * MIN);
  // A permission prompt left open for an hour is not work.
  assert.equal(workMs([call("a", 2, { from: 0 }), call("a", 62)]), 2 * MIN);
  // Subagents run inside the turn, so they add no time of their own.
  assert.equal(workMs([call("a", 4, { from: 0 }), call("s", 30, { isSubagent: true })]), 4 * MIN);
});

test("a turn is its own calls plus the subagent calls made while it ran", async () => {
  const data = await load({ s1: workday("s1") });
  const list = data.events.filter((e) => e.sessionId === "s1");
  const ends = list.filter(endsTurn);
  assert.equal(ends.length, 3, "two answers in turn two, one in turn one");

  const first = turnCalls(list, ends[0]);
  assert.equal(first.length, 2);
  assert.ok(first.every((e) => e.turnId === ends[0].turnId));

  // A subagent call inside the turn's span joins it.
  const sub = list.find((e) => e.isSubagent);
  const last = { ...ends[2], endTs: sub.ts };
  assert.ok(turnCalls(list, last).includes(sub));
  assert.ok(!turnCalls(list, ends[0]).includes(sub));
});

/** Calls of `usd` each, every 10 minutes from `from`. */
function spend(from, count, usd) {
  return Array.from({ length: count }, (_, i) => ({
    source: "claude-code",
    ts: new Date(from + (i + 1) * 10 * MIN).toISOString(),
    cost: { total: usd },
  }));
}

test("the rate per 1% is learned from windows that moved, and the median wins", () => {
  const H = 60 * MIN;
  // Claude Code was already in use when the meter was first read.
  const events = spend(START - 10 * MIN, 1, 0);
  const readings = [];
  // Three windows: 10 points for $5, 10 for $4, 8 for $6. A fourth moved 2: too little.
  const windows = [
    [0, 10, 5],
    [6 * H, 10, 4],
    [12 * H, 8, 6],
    [18 * H, 2, 9],
  ];
  for (const [from, rise, usd] of windows) {
    events.push(...spend(START + from, 4, usd / 4));
    readings.push({ t: START + from, percent: 3 });
    readings.push({ t: START + from + 41 * MIN, percent: 3 + rise });
  }
  const rate = windowRate(readings, events);
  assert.equal(rate.windows, 3);
  assert.ok(near(rate.usdPerPercent, 0.5));
  assert.ok(near(rate.low, 0.4));
  assert.ok(near(rate.high, 0.75));

  // Codex spends on another meter, so it never counts.
  const codex = events.map((e) => ({ ...e, source: "codex" }));
  assert.equal(windowRate(readings, codex), null);
  // Two windows are not enough to go on.
  assert.equal(windowRate(readings.slice(0, 4), events), null);
});

test("a share is said with one decimal and a tilde, and never as 0.0%", () => {
  assert.equal(windowShareLabel(0.62, 0.48), "~1.3%");
  assert.equal(windowShareLabel(0.01, 0.48), "<0.1%");
  assert.equal(windowShareLabel(48, 0.48), "~100%");
  assert.equal(workLabel(42_000), "42s");
  assert.equal(workLabel(130_000), "2m 10s");
  assert.equal(workLabel(65 * MIN), "1h 05m");
});

test("sessions opens with the costliest conversations, and live says each turn", async () => {
  const data = await load({
    s1: workday("s1"),
    s2: transcript("s2", [{ prompt: "hi" }, { out: 50 }]),
  });
  const rows = conversations(data);
  const rate = { basis: "meter", usdPerPercent: 0.01, windows: 27 };
  const text = renderSessions(sessionStats(data), summarize(data), { rows, rate });
  assert.match(text, /Costliest conversations/);
  assert.match(text, /Fix the login bug/);
  assert.match(text, /s2 \(no title\)/);
  assert.match(text, /learned from 27 windows/);
  assert.match(text, /All 2 conversations, 100% of spend/);
  assert.doesNotMatch(text, / \n/, "no trailing spaces");

  const off = renderSessions(sessionStats(data), summarize(data), { rows, rate: null });
  assert.doesNotMatch(off, /of 5h/);

  const event = data.events.filter((e) => e.sessionId === "s1").filter(endsTurn)[0];
  const line = renderTurnDone({
    event,
    title: "Fix the login bug",
    workMs: 130_000,
    costUsd: 0.62,
    conversation: { costUsd: 7.8, workMs: 41 * MIN },
    usdPerPercent: 0.48,
  });
  assert.match(line, /2m 10s · \$0\.620 · ~1\.3% of 5h {2}Fix the login bug/);
  assert.match(line, /this conversation \$7\.80 · ~16% of 5h · 41m 00s/);
});

test("the status line logs the meter only when it moves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-meter-"));
  const file = path.join(dir, "meter.jsonl");
  assert.equal(recordMeter(12, 1_000, file), true);
  assert.equal(recordMeter(12, 2_000, file), false);
  assert.equal(recordMeter(13, 3_000, file), true);
  assert.deepEqual(readMeterLog(file), [
    { t: 1_000, percent: 12 },
    { t: 3_000, percent: 13 },
  ]);
});

test("Claude Desktop's history is read for the account it used last", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-desktop-"));
  const file = path.join(dir, "plan-usage-history.json");
  const samples = [
    { t: 1, org: "old", u: { fh: 40, sd: 10 } },
    { t: 2, org: "new", u: { fh: 5, sd: 1 } },
    { t: 3, org: "new", u: { sd: 2 } },
    { t: 4, org: "new", u: { fh: 7, sd: 2 } },
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 2, samples }));
  assert.deepEqual(readDesktopMeter(file), [
    { t: 2, percent: 5 },
    { t: 4, percent: 7 },
  ]);
  assert.deepEqual(readDesktopMeter(path.join(dir, "missing.json")), []);
});
