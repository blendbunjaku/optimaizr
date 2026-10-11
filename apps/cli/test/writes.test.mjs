import { test } from "node:test";
import assert from "node:assert/strict";

import { coldResumes, renderSessions, sessionStats, summarize, writeCauses } from "@optimaizr/core";
import { load, read, transcript } from "./fixtures/transcripts.mjs";

/**
 * Cache writes cost 1.25x to 2x the input rate, so `optimaizr sessions` says
 * what each one was for: new content, a fresh start, or context written again.
 */

const SONNET = "claude-sonnet-5-5";

/** A conversation picked up three times, each after `gap` minutes away. */
function comeback({ gap = 90, size = 150_000 } = {}) {
  const script = [{ prompt: "build it" }, { out: 300, ctx: 0, write: size, hour: true }];
  for (let i = 0; i < 4; i++) {
    script.push({ tools: [read(`/w/a${i}.ts`)], out: 300, ctx: size, write: 2_000, hour: true });
  }
  for (let r = 0; r < 3; r++) {
    script.push({ prompt: "carry on", gap });
    script.push({ out: 300, ctx: 0, write: size + 10_000, hour: true });
    script.push({ out: 300, ctx: size + 10_000, write: 1_000, hour: true });
  }
  return script;
}

/** Written again 20 seconds apart: once on the same model, once on another. */
function rebuilds() {
  return [
    { prompt: "go" },
    { out: 300, ctx: 0, write: 100_000, hour: true },
    { out: 300, ctx: 100_000, write: 2_000, hour: true },
    { out: 300, ctx: 0, write: 102_000, hour: true },
    { out: 300, ctx: 102_000, write: 1_000, hour: true },
    { out: 300, ctx: 0, write: 103_000, hour: true, model: SONNET },
  ];
}

/** Two subagent runs and a compaction in one session. */
function agentsAndCompaction() {
  return [
    { prompt: "plan it" },
    { out: 300, ctx: 0, write: 40_000, hour: true },
    { prompt: "look", side: "a1" },
    { out: 100, ctx: 5_000, side: "a1" },
    { out: 100, ctx: 5_000, side: "a1" },
    { prompt: "look too", side: "a2" },
    { out: 100, ctx: 5_000, side: "a2" },
    { compact: true },
    { out: 300, ctx: 0, write: 30_000, hour: true },
  ];
}

const causes = (data) => {
  const out = {};
  for (const { cause } of writeCauses(data.events)) out[cause] = (out[cause] ?? 0) + 1;
  return out;
};

test("each write gets a cause", async () => {
  const back = await load({ s1: transcript("s1", comeback()) });
  assert.deepEqual(causes(back), { start: 1, growth: 7, break: 3 });

  const again = await load({ s1: transcript("s1", rebuilds()) });
  assert.deepEqual(causes(again), { start: 1, growth: 2, rebuilt: 1, model: 1 });

  const more = await load({ s1: transcript("s1", agentsAndCompaction()) });
  assert.deepEqual(causes(more), { start: 1, subagent: 3, compaction: 1 });
});

test("a short conversation picked up after a break counts as a fresh start", async () => {
  const data = await load({ s1: transcript("s1", comeback({ size: 30_000 })) });
  assert.equal(coldResumes(data.events).length, 0);
  assert.deepEqual(causes(data), { start: 4, growth: 7 });
});

test("sessions: cache writes by cause, matching the cold returns", async () => {
  const data = await load({
    s1: transcript("s1", comeback()),
    s2: transcript("s2", rebuilds()),
    s3: transcript("s3", agentsAndCompaction()),
  });
  const w = sessionStats(data).cacheWrites;
  const row = (cause) => w.byCause.find((r) => r.cause === cause);

  const total = data.events.reduce((s, e) => s + e.cost.cacheWrite, 0);
  assert.ok(Math.abs(w.costUsd - total) < 1e-9);
  const sum = w.byCause.reduce((s, r) => s + r.costUsd, 0);
  assert.ok(Math.abs(sum - total) < 1e-9, "every write has exactly one cause");
  assert.ok(Math.abs(w.byCause.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);

  // The break row is the cold returns, to the cent.
  const cold = coldResumes(data.events);
  assert.equal(row("break").times, cold.length);
  assert.ok(Math.abs(row("break").costUsd - cold.reduce((s, c) => s + c.rewriteUsd, 0)) < 1e-9);

  // 102K at Opus 5.5's 1-hour write rate, $8 a million; 103K at Sonnet 5.5's, $4.
  assert.ok(Math.abs(row("rebuilt").costUsd - 0.816) < 1e-9);
  assert.ok(Math.abs(row("model").costUsd - 0.412) < 1e-9);
  assert.equal(row("subagent").times, 2, "runs, not calls");
  assert.equal(row("compaction").times, 1);

  const rewrites = row("break").costUsd + row("rebuilt").costUsd + row("model").costUsd;
  assert.ok(Math.abs(w.rewrites.costUsd - rewrites) < 1e-9);
  assert.ok(w.spendShare > 0 && w.spendShare < 1);
  assert.ok(w.tokenShare > 0 && w.tokenShare < w.spendShare, "few tokens, much of the spend");

  const text = renderSessions(sessionStats(data), summarize(data));
  assert.match(text, /Cache writes/);
  assert.match(text, /after a break .* 3 returns/);
  assert.match(text, /rebuilt while warm .* 1 time\b/);
  assert.match(text, /model switches .* 1 switch\b/);
  assert.match(text, /subagents .* 2 runs/);
  assert.match(text, /wrote again what the cache/);
  assert.doesNotMatch(text, / \n/, "no trailing spaces");
});

test("no writes, no section", async () => {
  const data = await load({ s1: transcript("s1", [{ prompt: "hi" }, { out: 50, write: 0 }]) });
  const c = sessionStats(data);
  assert.equal(c.cacheWrites.costUsd, 0);
  assert.doesNotMatch(renderSessions(c, summarize(data)), /Cache writes/);
});
