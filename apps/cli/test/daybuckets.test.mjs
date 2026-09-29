import { test } from "node:test";
import assert from "node:assert/strict";

import { summarize, dayKeyIn, resolveTimeZone, costOf } from "@optimaizr/core";

/**
 * Day bucketing and the cache-write TTL split.
 *
 * Both exist because they are the two places a daily spend figure most often
 * disagrees with another tool's for reasons that are not arithmetic errors:
 * which midnight the day was cut at, and whether cache writes were priced at
 * the 1-hour rate (2x input) or the 5-minute one (1.25x).
 */

function event(id, ts, usage) {
  return {
    id,
    source: "claude-code",
    ts,
    model: "claude-opus-5",
    provider: "anthropic",
    sessionId: "s1",
    project: "/p",
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    thinkingTokens: 0,
    cacheReadTokens: usage.read ?? 0,
    cacheWrite5mTokens: usage.w5 ?? 0,
    cacheWrite1hTokens: usage.w1 ?? 0,
    tools: [],
    cost: costOf(
      {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.read ?? 0,
        cache_creation_input_tokens: (usage.w5 ?? 0) + (usage.w1 ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: usage.w5 ?? 0,
          ephemeral_1h_input_tokens: usage.w1 ?? 0,
        },
      },
      "claude-opus-5",
      { at: ts },
    ),
  };
}

function dataset(events) {
  return {
    events,
    window: { from: events[0].ts, to: events[events.length - 1].ts, days: 1 },
    sources: [],
    warnings: [],
  };
}

test("days bucket in UTC by default", () => {
  // 23:30 UTC on the 1st and 00:30 UTC on the 2nd are different UTC days.
  const s = summarize(
    dataset([
      event("a", "2026-09-01T23:30:00.000Z", { output: 1000 }),
      event("b", "2026-09-02T00:30:00.000Z", { output: 1000 }),
    ]),
  );
  assert.equal(s.dayTimeZone, "UTC");
  assert.deepEqual(
    s.byDay.map((b) => b.key),
    ["2026-09-01", "2026-09-02"],
  );
});

test("an explicit zone moves calls across the day boundary", () => {
  // In UTC+2 both timestamps fall on the 2nd: 01:30 and 02:30 local.
  const s = summarize(
    dataset([
      event("a", "2026-09-01T23:30:00.000Z", { output: 1000 }),
      event("b", "2026-09-02T00:30:00.000Z", { output: 1000 }),
    ]),
    { timeZone: "Europe/Berlin" },
  );
  assert.equal(s.dayTimeZone, "Europe/Berlin");
  assert.deepEqual(
    s.byDay.map((b) => b.key),
    ["2026-09-02"],
  );
  assert.equal(s.byDay[0].calls, 2);
});

test("regrouping moves spend between days but never changes the total", () => {
  const events = [
    event("a", "2026-09-01T23:30:00.000Z", { output: 1000, w1: 5000 }),
    event("b", "2026-09-02T00:30:00.000Z", { output: 2000, w1: 7000 }),
    event("c", "2026-09-02T18:00:00.000Z", { output: 3000, w5: 1000 }),
  ];
  const utc = summarize(dataset(events));
  const berlin = summarize(dataset(events), { timeZone: "Europe/Berlin" });

  assert.notDeepEqual(
    utc.byDay.map((b) => [b.key, b.calls]),
    berlin.byDay.map((b) => [b.key, b.calls]),
  );
  // The only thing a timezone may change is which bucket a call lands in.
  assert.equal(utc.totalCost, berlin.totalCost);
  assert.equal(utc.calls, berlin.calls);
  assert.equal(
    utc.byDay.reduce((t, b) => t + b.cost.total, 0).toFixed(10),
    berlin.byDay.reduce((t, b) => t + b.cost.total, 0).toFixed(10),
  );
});

test("an unusable timezone falls back to UTC instead of throwing", () => {
  assert.equal(dayKeyIn("2026-09-01T23:30:00.000Z", "Not/AZone"), "2026-09-01");
  assert.equal(resolveTimeZone("UTC"), "UTC");
  assert.equal(typeof resolveTimeZone("local"), "string");
});

test("cache writes are reported split by TTL, and the split sums to the total", () => {
  const s = summarize(
    dataset([
      event("a", "2026-09-01T10:00:00.000Z", { w5: 1000, w1: 9000 }),
      event("b", "2026-09-01T11:00:00.000Z", { w5: 500, w1: 500 }),
    ]),
  );
  assert.equal(s.cacheWrite5mTokens, 1500);
  assert.equal(s.cacheWrite1hTokens, 9500);
  assert.equal(s.cacheWriteTokens, s.cacheWrite5mTokens + s.cacheWrite1hTokens);

  const day = s.byDay[0];
  assert.equal(day.cacheWrite5mTokens, 1500);
  assert.equal(day.cacheWrite1hTokens, 9500);
  assert.equal(day.cacheWriteTokens, day.cacheWrite5mTokens + day.cacheWrite1hTokens);
});

test("the window header is reported in the same zone as the day buckets", () => {
  const events = [
    event("a", "2026-09-01T23:30:00.000Z", { output: 1000 }),
    event("b", "2026-09-03T22:30:00.000Z", { output: 1000 }),
  ];
  const utc = summarize(dataset(events));
  assert.equal(utc.windowDays.from, "2026-09-01");
  assert.equal(utc.windowDays.to, "2026-09-03");

  // In UTC+2 both calls land a day later, and the header must follow.
  const berlin = summarize(dataset(events), { timeZone: "Europe/Berlin" });
  assert.equal(berlin.windowDays.from, "2026-09-02");
  assert.equal(berlin.windowDays.to, "2026-09-04");

  // The header must never name a day that has no bucket.
  for (const s of [utc, berlin]) {
    const keys = s.byDay.map((b) => b.key);
    assert.equal(s.windowDays.from, keys[0]);
    assert.equal(s.windowDays.to, keys[keys.length - 1]);
  }

  // The raw window is untouched: it is the real timestamp, always UTC.
  assert.equal(berlin.window.from, "2026-09-01T23:30:00.000Z");
});

test("the 1h cache write stays at the published 2x rate", () => {
  // Guards against 'fixing' a discrepancy with a plan meter by discounting the
  // 1h write. 1M tokens at the 1h TTL on a $5/M input rate is $10.
  const cost = costOf(
    {
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    },
    "claude-opus-5",
  );
  assert.equal(cost.cacheWrite, 10);
});
