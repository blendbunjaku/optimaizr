import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSessionTracker,
  parsePlan,
  planRedirect,
  planView,
  sessionBlocks,
} from "@optimaizr/core";

/**
 * A Claude plan is rationed in five-hour sessions. The invariants: sessions
 * open on the hour at the first call after the last one closed, only Claude
 * Code traffic counts, the limit is learned from recorded hits, and a live
 * warning is news exactly once per session.
 */

const ev = (id, ts, usd, source = "claude-code") => ({ id, ts, source, cost: { total: usd } });

const DAY1 = [
  ev("a", "2026-09-20T09:17:00.000Z", 2),
  ev("b", "2026-09-20T11:40:00.000Z", 3),
  ev("c", "2026-09-20T13:59:00.000Z", 5), // still inside 09:00-14:00
  ev("d", "2026-09-20T14:05:00.000Z", 4), // opens 14:00-19:00
  ev("x", "2026-09-20T10:00:00.000Z", 50, "codex"), // a different plan's traffic
];

test("sessions open on the hour and last five hours", () => {
  const s = sessionBlocks(DAY1);
  assert.equal(s.length, 2);
  assert.equal(s[0].start, "2026-09-20T09:00:00.000Z");
  assert.equal(s[0].end, "2026-09-20T14:00:00.000Z");
  assert.equal(s[0].usd, 10);
  assert.equal(s[0].calls, 3);
  assert.equal(s[1].start, "2026-09-20T14:00:00.000Z");
  assert.equal(s[1].usd, 4);
});

test("waste per session is the de-overlapped claim on its calls", () => {
  const finding = (claims) => ({ advisory: false, claimByEvent: new Map(claims), savings: {} });
  // Two findings claim call b; the larger claim counts, not the sum.
  const s = sessionBlocks(DAY1, [
    finding([
      ["a", 1],
      ["b", 1],
    ]),
    finding([["b", 2]]),
  ]);
  assert.equal(s[0].wasteUsd, 3);
  assert.equal(s[1].wasteUsd, 0);
});

test("the limit is what the session had used when a hit was recorded, median over hits", () => {
  const hits = ["2026-09-20T12:00:00.000Z", "2026-09-20T18:00:00.000Z"];
  const s = sessionBlocks(DAY1, [], hits);
  assert.equal(s[0].usdAtLimit, 5, "a + b, before the hit at 12:00; c came after");
  assert.equal(s[1].usdAtLimit, 4);

  const v = planView(DAY1, [], {
    plan: "pro",
    limitHits: hits,
    now: new Date("2026-09-20T15:00:00.000Z"),
  });
  assert.deepEqual(v.limit, { usd: 4.5, hits: 2 });
  assert.equal(v.current.start, "2026-09-20T14:00:00.000Z");
  assert.equal(v.current.limitShare, 4 / 4.5);
});

test("a hit with no calls in its session teaches nothing", () => {
  const v = planView(DAY1, [], {
    plan: "pro",
    limitHits: ["2026-09-01T12:00:00.000Z"],
    now: new Date("2026-09-20T20:00:00.000Z"),
  });
  assert.equal(v.limit, null);
  assert.equal(v.current, null, "the last session reset at 19:00");
});

test("value is Claude Code's API-equivalent spend against the plan's price", () => {
  const v = planView(DAY1, [], { plan: "max5", now: new Date("2026-09-20T20:00:00.000Z") });
  assert.equal(v.priceUsd, 100);
  assert.equal(v.recentSessions, 2);
  // $14 over one day of history, scaled to a month as every monthly figure is.
  assert.equal(v.valueMonthlyUsd, 14 * 30);
  assert.equal(v.multiple, 4.2);
});

test("plan names are forgiving", () => {
  assert.equal(parsePlan("Pro"), "pro");
  assert.equal(parsePlan("max"), "max5");
  assert.equal(parsePlan("Max 20x"), "max20");
  assert.equal(parsePlan("team"), "team");
  assert.equal(parsePlan("Team Standard"), "team");
  assert.equal(parsePlan("team-premium"), "team-premium");
  assert.equal(parsePlan("premium"), "team-premium");
  assert.equal(parsePlan("ultra"), null);
});

test("Team seats are priced per seat at the monthly list price", () => {
  const now = new Date("2026-09-20T20:00:00.000Z");
  const standard = planView(DAY1, [], { plan: "team", now });
  assert.equal(standard.priceUsd, 25);
  assert.equal(standard.perSeat, true);
  const premium = planView(DAY1, [], { plan: "team-premium", now });
  assert.equal(premium.priceUsd, 125);
  assert.equal(premium.label, "Claude Team Premium");
  assert.equal(planView(DAY1, [], { plan: "pro", now }).perSeat, false);
});

test("Enterprise and Free are named, and sent where their question is answered", () => {
  assert.equal(parsePlan("enterprise"), null);
  assert.match(planRedirect("Enterprise"), /--budget/);
  assert.match(planRedirect("free"), /does not include Claude Code/);
  assert.equal(planRedirect("ultra"), null);
});

test("the session tracker warns once per threshold and starts again at the reset", () => {
  const t = createSessionTracker({
    limitUsd: 10,
    current: { start: "2026-09-20T14:00:00.000Z", usd: 4 },
  });
  const at = (id, ts, usd, source) => t.add(ev(id, ts, usd, source));

  assert.equal(at("1", "2026-09-20T15:00:00.000Z", 3), null, "70%");
  assert.equal(at("2", "2026-09-20T15:10:00.000Z", 50, "codex"), null, "not this plan");
  const c = at("3", "2026-09-20T15:20:00.000Z", 1.5);
  assert.equal(c.threshold, 0.8);
  assert.equal(c.resetsAt, "2026-09-20T19:00:00.000Z");
  assert.equal(at("4", "2026-09-20T15:30:00.000Z", 0.1), null, "86%: nothing new");
  assert.equal(at("5", "2026-09-20T15:40:00.000Z", 1).threshold, 0.95);
  // Past 19:00 a fresh session opens, and its thresholds are news again.
  assert.equal(at("6", "2026-09-20T19:30:00.000Z", 2), null);
  assert.equal(at("7", "2026-09-20T19:40:00.000Z", 6.5).threshold, 0.8);
});
