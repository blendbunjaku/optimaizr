import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProfile,
  coldResumes,
  findWaste,
  renderSessions,
  sessionStats,
  summarize,
} from "@optimaizr/core";
import { load, read, transcript } from "./fixtures/transcripts.mjs";

/**
 * Coming back to a long conversation after its cache expired writes all of it
 * again. `optimaizr sessions` counts those returns, and the cold-resume rule
 * prices a fresh start from a handoff note against them.
 */

/** A conversation picked up `returns` times, each after `gap` minutes away. */
function comeback({ returns = 3, gap = 90, size = 150_000, hour = true } = {}) {
  const script = [{ prompt: "build it" }, { out: 300, ctx: 0, write: size, hour }];
  for (let i = 0; i < 4; i++) {
    script.push({ tools: [read(`/w/a${i}.ts`)], out: 300, ctx: size, write: 2_000, hour });
  }
  for (let r = 0; r < returns; r++) {
    script.push({ prompt: "carry on", gap });
    script.push({ out: 300, ctx: 0, write: size + 10_000, hour });
    script.push({ out: 300, ctx: size + 10_000, write: 1_000, hour });
  }
  return script;
}

/** One conversation that grows by 2K a call, from 50K to 350K. */
function growing() {
  const script = [{ prompt: "build the whole thing" }];
  for (let i = 0; i < 150; i++) {
    script.push({ tools: [read(`/w/f${i}.ts`)], out: 1_000, ctx: 50_000 + i * 2_000 });
  }
  return script;
}

const rule = (findings, name) => findings.find((f) => f.rule === name);

test("a return after the cache expired is counted from the rewrite it recorded", async () => {
  const data = await load({ s1: transcript("s1", comeback()) });
  const cold = coldResumes(data.events);
  assert.equal(cold.length, 3);
  for (const c of cold) {
    assert.equal(c.ttlMinutes, 60, "Claude Code's main conversation caches for an hour");
    assert.equal(c.rewriteTokens, 160_000);
    // 160K at Opus 5.5's 1-hour write rate, $8 a million, against $0.20 to read it.
    assert.ok(Math.abs(c.rewriteUsd - 1.28) < 1e-9);
    assert.ok(Math.abs(c.warmUsd - 0.032) < 1e-9);
  }

  const finding = rule(findWaste(data), "cold-resume");
  assert.ok(finding, "three costly returns are a habit worth a finding");
  assert.equal(finding.tier, "try");
  assert.match(finding.title, /^3 returns to an expired cache rewrote 480(\.0)?K/);
  // The multipliers come from the model's own rates, not a rule of thumb.
  assert.match(finding.why, /at 2x the input rate, where reading it would have cost 0\.05x/);
  assert.match(finding.fix, /\/optimaizr handoff/);
  assert.ok(finding.savings.monthlyUsd > 0);
});

test("nothing is flagged inside the cache's lifetime, or for a short conversation", async () => {
  const within = await load({ s1: transcript("s1", comeback({ gap: 30 })) });
  assert.equal(coldResumes(within.events).length, 0, "30 minutes is inside the 1-hour cache");

  const small = await load({ s1: transcript("s1", comeback({ size: 30_000 })) });
  assert.equal(coldResumes(small.events).length, 0, "under 50K a fresh start costs about the same");

  const two = await load({ s1: transcript("s1", comeback({ returns: 2 })) });
  assert.equal(coldResumes(two.events).length, 2);
  assert.equal(rule(findWaste(two), "cold-resume"), undefined, "two returns are not a habit yet");
});

test("a conversation on the 5-minute cache expires after 5 minutes", async () => {
  const data = await load({ s1: transcript("s1", comeback({ gap: 10, hour: false })) });
  const cold = coldResumes(data.events);
  assert.equal(cold.length, 3);
  assert.ok(cold.every((c) => c.ttlMinutes === 5));
  // 160K at the 5-minute write rate, $5 a million.
  assert.ok(Math.abs(cold[0].rewriteUsd - 0.8) < 1e-9);
});

test("compacting earlier prices the reload at the 1-hour rate the conversation uses", async () => {
  const lever = async (hour) => {
    const script = [{ prompt: "build the whole thing" }];
    for (let i = 0; i < 100; i++) {
      script.push({ tools: [read(`/w/f${i}.ts`)], out: 300, ctx: 50_000 + i * 6_000, hour });
    }
    return rule(findWaste(await load({ s1: transcript("s1", script) })), "context-compaction");
  };
  const hour = await lever(true);
  const five = await lever(false);
  assert.ok(hour && five);
  assert.ok(hour.savings.assumptions.some((a) => a.includes("at the 1-hour write rate")));
  assert.ok(!five.savings.assumptions.some((a) => a.includes("1-hour")));
});

test("sessions: where re-reading takes over, where the money is, and the cold returns", async () => {
  const data = await load({
    s1: transcript("s1", growing()),
    s2: transcript("s2", comeback()),
  });
  const c = sessionStats(data);
  assert.equal(c.sessions, 2);
  assert.equal(c.calls, data.events.length);
  const shares = c.byContext.reduce((s, b) => s + b.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9, "the bands cover all main-conversation spend");
  // 1,000 output tokens cost $0.02 a call; re-reading costs more from about 113K,
  // so the 100K band is the first where it is half the spend.
  assert.equal(c.rereadHalfAt, 100_000);
  const band = (from) => c.byContext.find((b) => b.from === from);
  assert.ok(band(50_000).rereadShare < 0.5);
  assert.ok(band(300_000).rereadShare > band(100_000).rereadShare);
  assert.equal(c.longSessions.count, 1, "only the growing conversation passes 200K");
  assert.equal(c.topSessions.count, 1);
  assert.equal(c.coldResumes.count, 3);
  assert.ok(Math.abs(c.coldResumes.costUsd - 3 * 1.28) < 1e-9);

  const summary = summarize(data);
  const profile = buildProfile(data, summary, findWaste(data));
  assert.deepEqual(profile.sessions, c);

  const text = renderSessions(c, summary);
  assert.match(text, /optimAIzr.*\|.*sessions/, "the command is called sessions now");
  assert.match(text, /Where re-reading takes over/);
  assert.match(text, /Cold cache returns/);
  assert.match(text, /optimaizr recommend/);
});
