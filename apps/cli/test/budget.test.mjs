import { test } from "node:test";
import assert from "node:assert/strict";

import { budgetStatus, createBudgetTracker, renderBudget } from "@optimaizr/core";

/**
 * A monthly cap is answered in dates, so the invariants under test are the
 * calendar ones: which month a call belongs to, which day the cap runs out,
 * and that a threshold is announced once, as news, and never replayed.
 */

const ev = (id, ts, usd) => ({ id, ts, cost: { total: usd } });

/** $10 on each of the first `n` days of September, at noon UTC. */
function september(n, usd = 10) {
  return Array.from({ length: n }, (_, i) =>
    ev(`s${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`, usd),
  );
}

// Midnight starting the 21st: exactly 20 days of September have elapsed.
const NOW = new Date("2026-09-21T00:00:00.000Z");

test("counts only the current month, and projects month-end at the month-to-date pace", () => {
  const events = [ev("aug", "2026-08-31T23:00:00.000Z", 500), ...september(20)];
  const b = budgetStatus(events, { limitUsd: 400, now: NOW });

  assert.equal(b.periodStart, "2026-09-01");
  assert.equal(b.resetsOn, "2026-10-01");
  assert.equal(b.daysInPeriod, 30);
  assert.equal(b.usedUsd, 200);
  assert.equal(b.rateBasis, "month-to-date");
  assert.equal(b.dailyRateUsd, 10);
  assert.equal(b.projectedUsd, 300);
  assert.equal(b.reached, false);
  assert.equal(b.exhaustsOn, null, "a $400 cap at $10/day lasts September");
});

test("names the day the cap runs out, and how many days short it falls", () => {
  const b = budgetStatus(september(20), { limitUsd: 250, now: NOW });
  // $200 used, $50 left at $10/day: gone five days later, on the 26th.
  assert.equal(b.exhaustsOn, "2026-09-26");
  assert.equal(b.daysShort, 5);
});

test("a cap already used up reports the day it was crossed", () => {
  const b = budgetStatus(september(20), { limitUsd: 55, now: NOW });
  assert.equal(b.reached, true);
  assert.equal(b.exhaustsOn, "2026-09-06");
  assert.equal(b.withFixes, null, "fixes cannot un-spend a reached cap");
});

test("fixes buy back days in proportion to the share of spend they remove", () => {
  const b = budgetStatus(september(20), { limitUsd: 250, now: NOW, savingsShare: 0.5 });
  // At $5/day the remaining $50 lasts ten days: the 31st does not exist.
  assert.equal(b.withFixes.exhaustsOn, null);
  assert.equal(b.withFixes.daysGained, 5);
});

test("early in the month the pace comes from the trailing fortnight, not two noisy days", () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  const events = [
    // A quiet late August at $5/day, starting before the fortnight does...
    ...Array.from({ length: 13 }, (_, i) =>
      ev(`a${i}`, `2026-08-${String(19 + i).padStart(2, "0")}T12:00:00.000Z`, 5),
    ),
    // ...then a busy first two days that would project to $1,500.
    ev("b1", "2026-09-01T12:00:00.000Z", 50),
    ev("b2", "2026-09-02T12:00:00.000Z", 50),
  ];
  const b = budgetStatus(events, { limitUsd: 300, now });
  assert.equal(b.rateBasis, "trailing-14d");
  assert.equal(b.usedUsd, 100);
  // Aug 20-31 ($60) + $100 over the fortnight; Aug 19 falls outside it.
  assert.ok(Math.abs(b.dailyRateUsd - 160 / 14) < 1e-9);
});

test("the month is cut in the zone asked for", () => {
  // 23:30 UTC on Aug 31 is already September in Berlin.
  const late = [ev("x", "2026-08-31T23:30:00.000Z", 40)];
  const now = new Date("2026-09-10T12:00:00.000Z");
  assert.equal(budgetStatus(late, { limitUsd: 100, now }).usedUsd, 0);
  assert.equal(budgetStatus(late, { limitUsd: 100, now, timeZone: "Europe/Berlin" }).usedUsd, 40);
});

test("the tracker announces each threshold once, and never the ones already passed", () => {
  const t = createBudgetTracker({ limitUsd: 100, usedUsd: 60, month: "2026-09" });
  const at = (id, usd) => t.add(ev(id, "2026-09-22T10:00:00.000Z", usd));

  assert.equal(at("a", 10), null, "70%: 50% was already true when live started");
  assert.equal(at("b", 12).threshold, 0.8);
  assert.equal(at("c", 1), null, "83%: nothing new");
  // One large call jumps two thresholds and reports the higher.
  assert.equal(at("d", 20).threshold, 1);
  assert.equal(at("e", 5), null);
});

test("the tracker starts again when a call lands in the next month", () => {
  const t = createBudgetTracker({ limitUsd: 100, usedUsd: 99, month: "2026-09" });
  assert.equal(t.add(ev("old", "2026-08-30T10:00:00.000Z", 50)), null, "a late August call");
  assert.equal(t.add(ev("oct", "2026-10-01T09:00:00.000Z", 55)).threshold, 0.5);
  assert.equal(t.usedUsd, 55);
});

test("the rendered block agrees with the dates beside it", () => {
  const b = budgetStatus(september(20), { limitUsd: 250, now: NOW, savingsShare: 0.5 });
  const text = renderBudget(b).join("\n");
  assert.match(text, /Sep 26/);
  assert.match(text, /cap reached 5 days before reset/);
  assert.match(text, /\+5 days/);
  assert.match(text, /Counts this machine only/);
});
