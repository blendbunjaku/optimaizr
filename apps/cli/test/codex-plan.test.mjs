import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codexPlanView,
  consumeCodexLine,
  createCodexLimitTracker,
  createCodexState,
  rateLimitsOf,
  windowLabel,
} from "@optimaizr/core";

/**
 * A ChatGPT plan is read, not guessed: Codex writes OpenAI's own meter on
 * every token_count. The invariants: both of Codex's formats parse, a
 * meter-only refresh still counts, API-key sessions show nothing, and a live
 * warning is news exactly once per window.
 */

const NOW = Date.parse("2026-09-22T20:00:00.000Z");
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const epoch = (minutesFromNow) => Math.floor((NOW + minutesFromNow * 60_000) / 1000);

function tokenCount(ts, total, rateLimits) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: {
          input_tokens: 10_000,
          cached_input_tokens: 8_000,
          output_tokens: 500,
          total_tokens: 10_500,
        },
      },
      rate_limits: rateLimits,
    },
  });
}

const plus = (primaryUsed, weeklyUsed) => ({
  primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: epoch(120) },
  secondary: { used_percent: weeklyUsed, window_minutes: 10080, resets_at: epoch(3 * 1440) },
  plan_type: "plus",
});

test("both of Codex's reset formats parse, and an API-key session has no meter", () => {
  const abs = rateLimitsOf(plus(40, 10), at(0));
  assert.equal(abs.planType, "plus");
  assert.equal(abs.windows.length, 2);
  assert.equal(abs.windows[0].resetsAt, new Date(epoch(120) * 1000).toISOString());

  const rel = rateLimitsOf(
    { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 600 } },
    "2026-09-22T20:00:00.000Z",
  );
  assert.equal(rel.windows[0].resetsAt, "2026-09-22T20:10:00.000Z");

  assert.equal(rateLimitsOf(null), undefined);
  assert.equal(rateLimitsOf({ primary: null, secondary: null, plan_type: null }), undefined);
});

test("the meter rides on each call, and a refresh that bills nothing still updates it", () => {
  const s = createCodexState("rollout-x.jsonl");
  const first = consumeCodexLine(s, tokenCount(at(30), 10_500, plus(40, 10)));
  assert.equal(first.rateLimits.windows[0].usedPercent, 40);

  // Same running total: no new call, but a fresher reading.
  assert.equal(consumeCodexLine(s, tokenCount(at(20), 10_500, plus(55, 12))), null);
  const next = consumeCodexLine(s, tokenCount(at(10), 21_000, undefined));
  assert.equal(next.rateLimits.windows[0].usedPercent, 55);
});

function events() {
  const s = createCodexState("rollout-y.jsonl");
  const out = [];
  for (let i = 0; i < 10; i++) {
    out.push(consumeCodexLine(s, tokenCount(at(100 - i * 10), (i + 1) * 10_500, plus(50 + i, 20))));
  }
  return out;
}

test("the plan view reports OpenAI's figures and what a full window is worth", () => {
  const v = codexPlanView(events(), [], { now: new Date(NOW) });
  assert.equal(v.label, "ChatGPT Plus");
  assert.equal(v.priceUsd, 20);
  const [five, week] = v.windows;
  assert.equal(five.label, "5-hour");
  assert.equal(five.usedPercent, 59);
  assert.equal(week.label, "Weekly");
  // Everything spent sits inside the 5-hour window, so a full one is the
  // spend so far over the share used.
  const spent = events().reduce((t, e) => t + e.cost.total, 0);
  assert.ok(Math.abs(five.fullWindowUsd - spent / 0.59) < 1e-9);
});

test("a window that reset after the last reading shows as fresh", () => {
  const later = new Date(NOW + 3 * 60 * 60_000);
  const v = codexPlanView(events(), [], { now: later });
  assert.equal(v.windows[0].hasReset, true);
  assert.equal(v.windows[0].usedPercent, 0);
  assert.equal(v.windows[1].hasReset, false);
});

test("no view without a recent meter, and seat plans carry no price", () => {
  assert.equal(codexPlanView(events(), [], { now: new Date(NOW + 40 * 86_400_000) }), null);
  const s = createCodexState("rollout-z.jsonl");
  const team = consumeCodexLine(
    s,
    tokenCount(at(5), 10_500, { ...plus(10, 5), plan_type: "team" }),
  );
  const v = codexPlanView([team], [], { now: new Date(NOW) });
  assert.equal(v.label, "ChatGPT Business", "Team is Business under its old name");
  assert.equal(v.priceUsd, null);
  assert.equal(v.multiple, null);
});

test("each Pro tier is named and priced by the plan type Codex reports", () => {
  const priced = (planType) => {
    const s = createCodexState(`rollout-${planType}.jsonl`);
    const e = consumeCodexLine(
      s,
      tokenCount(at(5), 10_500, { ...plus(10, 5), plan_type: planType }),
    );
    const v = codexPlanView([e], [], { now: new Date(NOW) });
    return [v.label, v.priceUsd];
  };
  assert.deepEqual(priced("prolite"), ["ChatGPT Pro 5x", 100]);
  assert.deepEqual(priced("pro"), ["ChatGPT Pro 20x", 200]);
  assert.deepEqual(priced("go"), ["ChatGPT Go", 8]);
  assert.deepEqual(priced("enterprise_cbp_usage_based"), ["ChatGPT Enterprise, usage-based", null]);
  // A plan type newer than the table: named as reported, never priced.
  assert.deepEqual(priced("ultra"), ["ChatGPT Ultra", null]);
});

test("live warns once per threshold per window, and again after a reset", () => {
  const t = createCodexLimitTracker({ seed: rateLimitsOf(plus(82, 20), at(0)) });
  const s = createCodexState("rollout-live.jsonl");
  let total = 0;
  const call = (rl) => t.add(consumeCodexLine(s, tokenCount(at(0), (total += 10_500), rl)));

  assert.deepEqual(call(plus(88, 21)), [], "80% was already passed when live started");
  const [c] = call(plus(96, 22));
  assert.equal(c.label, "5-hour");
  assert.equal(c.threshold, 95);
  assert.deepEqual(call(plus(99, 23)), []);

  // A new 5-hour window: its reset time moved by hours.
  const fresh = {
    ...plus(81, 24),
    primary: { used_percent: 81, window_minutes: 300, resets_at: epoch(420) },
  };
  assert.equal(call(fresh)[0].threshold, 80);
});

test("windows are named the way people say them", () => {
  assert.equal(windowLabel(300), "5-hour");
  assert.equal(windowLabel(10080), "Weekly");
  assert.equal(windowLabel(1440), "1-day");
});
