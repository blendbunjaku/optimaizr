import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coldResumes,
  conversations,
  fiveHourWindows,
  noteVsCompaction,
  renderColdReturn,
  renderSessions,
  sessionStats,
  summarize,
} from "@optimaizr/core";
import { bash, load, read, transcript } from "./fixtures/transcripts.mjs";

/**
 * 0.12: `optimaizr sessions` and the cache. The cache lifetime, cold returns
 * split by who was waiting, five-hour windows by conversation, headless runs,
 * and a fresh start from guard's note against a compaction.
 */

const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

test("a cold return mid-turn is Claude waiting on a tool, and the 5-minute cache names it", async () => {
  const data = await load({
    s1: transcript("s1", [
      { prompt: "run the e2e" },
      { out: 300, ctx: 0, write: 150_000 },
      { tools: [bash("npm run e2e")], out: 300, ctx: 150_000, write: 1_000 },
      // Back from the command 20 minutes later, in the same turn.
      { out: 300, ctx: 0, write: 152_000, gap: 20 },
      { prompt: "and now the docs", gap: 30 },
      { out: 300, ctx: 0, write: 153_000 },
    ]),
  });
  const cold = coldResumes(data.events);
  assert.deepEqual(
    cold.map((c) => c.waiting),
    ["tool", "away"],
  );

  const c = sessionStats(data);
  assert.equal(c.coldResumes.tool.count, 1);
  assert.equal(c.coldResumes.away.count, 1);
  assert.deepEqual(
    c.coldResumes.outlasted.map((o) => [o.label, o.times]),
    [["npm run e2e", 1]],
  );
  assert.equal(c.cacheWrites.lifetime.hourShare, 0);

  const text = strip(renderSessions(c, summarize(data)));
  assert.match(text, /cache lifetime\s+5 minutes on all of it/);
  assert.match(text, /you were away\s+1/);
  assert.match(text, /Claude was waiting on a tool\s+1/);
  assert.match(text, /On the 5-minute cache, Claude was waiting on these when it expired/);
  assert.match(text, /npm run e2e\s+1x/);
  assert.match(strip(renderColdReturn(cold[0])), /Claude waited 2\dm on npm run e2e/);
  assert.match(strip(renderColdReturn(cold[1])), /back after 3\dm/);
});

test("each five-hour window says which conversations spent it and how many ran at once", async () => {
  const data = await load({
    a: transcript("a", [{ prompt: "one" }, { out: 300 }, { out: 300 }]),
    b: transcript("b", [{ prompt: "two" }, { out: 300 }]),
    c: transcript("c", [{ prompt: "later", gap: 6 * 60 }, { out: 300 }]),
  });
  const w = fiveHourWindows(data.events);
  assert.equal(w.count, 2);
  assert.equal(w.parallel, 1);
  const [late, early] = w.recent;
  assert.deepEqual(
    late.conversations.map((x) => x.sessionId),
    ["c"],
  );
  assert.equal(early.atOnce, 2);
  assert.deepEqual(early.conversations.map((x) => x.sessionId).sort(), ["a", "b"]);

  const rows = conversations(data);
  const text = strip(renderSessions(sessionStats(data), summarize(data), { rows, rate: null }));
  assert.match(text, /5-hour windows \(Claude Code, the latest 2 of 2\)/);
  assert.match(text, /2 conversations, 2 at once/);
  assert.match(text, /Two or more conversations ran at once in 1 of 2 windows/);
});

test("a run started by claude -p or the SDK is tagged headless", async () => {
  const sdk = transcript("h", [{ prompt: "nightly check" }, { out: 300 }]).map((r) => ({
    ...r,
    entrypoint: "sdk-cli",
  }));
  const data = await load({ h: sdk, i: transcript("i", [{ prompt: "by hand" }, { out: 300 }]) });
  assert.ok(data.events.filter((e) => e.sessionId === "h").every((e) => e.headless));
  assert.ok(!data.events.some((e) => e.sessionId === "i" && e.headless));

  const c = sessionStats(data);
  assert.equal(c.headless.sessions, 1);
  const rows = conversations(data);
  assert.equal(rows.find((r) => r.sessionId === "h").headless, true);
  const text = strip(renderSessions(c, summarize(data), { rows, rate: null }));
  assert.match(text, /headless runs\s+1 session/);
  assert.match(text, /· headless/);
});

test("a fresh start from guard's note against a compaction, measured the same way", async () => {
  const data = await load({
    old: transcript("old", [
      { prompt: "build it" },
      { tools: [read("/w/a.ts"), read("/w/b.ts")], ctx: 120_000 },
    ]),
    fresh: transcript("fresh", [
      { prompt: "carry on from the note", gap: 90 },
      { tools: [read("/w/a.ts")], ctx: 30_000 },
      { out: 300, ctx: 31_000 },
    ]),
    long: transcript("long", [
      { prompt: "refactor" },
      { tools: [read("/w/c.ts")], ctx: 180_000 },
      { compact: true, meta: { trigger: "auto", preTokens: 190_000, durationMs: 60_000 } },
      { prompt: "go on" },
      { tools: [read("/w/c.ts")], ctx: 40_000 },
      { tools: [read("/w/d.ts")], ctx: 42_000 },
      { out: 300, ctx: 43_000 },
    ]),
  });
  assert.equal(noteVsCompaction(data, []), null, "nothing to compare yet");
  const f = noteVsCompaction(data, [{ session: "fresh", from: "old" }]);
  assert.equal(f.note.count, 1);
  assert.equal(f.note.readAgain, 1);
  assert.equal(f.note.waitMs, 0);
  assert.equal(f.note.callsPerPrompt, 2);
  assert.equal(f.compaction.count, 1);
  assert.equal(f.compaction.readAgain, 1);
  assert.equal(f.compaction.waitMs, 60_000);
  assert.equal(f.compaction.callsPerPrompt, 3);
  assert.ok(f.note.firstCall < f.compaction.firstCall);

  const text = strip(renderSessions(sessionStats(data), summarize(data), undefined, { fresh: f }));
  assert.match(text, /Starting from a note against compacting/);
  assert.match(text, /waited before it\s+none\s+1m 00s/);
  assert.match(text, /calls per prompt\s+2\.0\s+3\.0/);
  assert.match(text, /Few notes so far/);
});
