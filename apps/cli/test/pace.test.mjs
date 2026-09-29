import { test } from "node:test";
import assert from "node:assert/strict";

import { PACE_DAYS, projectionDays } from "@optimaizr/core";

/**
 * "At this rate" means the recent rate. A long history must not average a
 * busy month with a quiet spring, and a short one must behave exactly as it
 * always has.
 */

const DAY = 86_400_000;
const END = Date.parse("2026-09-30T00:00:00.000Z");
const ev = (daysAgo, usd) => ({
  ts: new Date(END - daysAgo * DAY).toISOString(),
  cost: { total: usd },
});

function dataset(events, days) {
  return {
    events,
    window: {
      from: new Date(END - days * DAY).toISOString(),
      to: new Date(END).toISOString(),
      days,
    },
    sources: [],
    warnings: [],
  };
}

test("a window up to 30 days is its own pace", () => {
  const d = dataset([ev(20, 10), ev(1, 10)], 20);
  assert.equal(projectionDays(d), 20);
});

test("a long window projects at its last 30 days, not its average", () => {
  // $40 spread over April to August, then $400 in the last 30 days.
  const d = dataset([ev(150, 20), ev(100, 20), ev(20, 200), ev(5, 200)], 150);
  const days = projectionDays(d);
  const perMonth = (440 / days) * 30;
  assert.ok(Math.abs(perMonth - 400) < 1e-9, `expected $400/month, got ${perMonth}`);
  // Any share of the window keeps its share of the rate: a finding worth 10%
  // of spend projects to 10% of the monthly figure.
  assert.ok(Math.abs((44 / days) * 30 - 40) < 1e-9);
});

test("a long window whose last 30 days were quiet falls back to the full span", () => {
  const d = dataset([ev(150, 20), ev(100, 20)], 150);
  assert.equal(projectionDays(d), 150);
});

test("the pace window is 30 days", () => {
  assert.equal(PACE_DAYS, 30);
});
