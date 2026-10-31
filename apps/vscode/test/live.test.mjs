import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { ingestClaudeCode } from "@optimaizr/core";

import { lib, sandbox, snapshot, transcript, writeTranscript } from "./helpers.mjs";

const home = sandbox("live");
const { createLiveWatch, DONE_ALERT_MS, expiringMinutes } = lib;
const MIN = 60_000;

/**
 * A morning in one folder: a turn that works for over a minute, then a
 * return 27 minutes later that writes the whole cache again.
 */
async function morning(now) {
  const cwd = path.join(home, "work", "app");
  fs.mkdirSync(cwd, { recursive: true });
  const root = path.join(home, ".claude", "projects");
  const recs = transcript(
    "s1",
    cwd,
    [
      { prompt: "fix the login bug" },
      { tool: "npm test", read: 90_000, write: 2_000 },
      { after: 60, read: 92_000, write: 500 },
      { prompt: "and the tests?", after: 27 * 60 },
      { after: 5, read: 0, write: 93_000 },
    ],
    now - 30 * MIN,
  );
  writeTranscript(root, cwd, "s1", recs);
  const { events } = await ingestClaudeCode({ root });
  return { cwd, events: events.sort((a, b) => a.ts.localeCompare(b.ts)) };
}

function watch(cwd) {
  const notices = [];
  let changes = 0;
  const w = createLiveWatch({
    folders: () => [cwd],
    onNotice: (n) => notices.push(n),
    onChange: () => changes++,
  });
  return { w, notices, changes: () => changes };
}

test("a long turn says done, and a return after the cache expired says cold", async () => {
  const now = Date.now();
  const { cwd, events } = await morning(now);
  assert.equal(events.length, 3);
  const { w, notices, changes } = watch(cwd);
  for (const e of events) w.push(e);

  const kinds = notices.map((n) => n.kind);
  assert.deepEqual(kinds, ["done", "cold"]);
  const done = notices[0];
  assert.ok(done.workMs >= DONE_ALERT_MS, `worked ${done.workMs}ms`);
  assert.equal(done.title, "app");
  assert.equal(done.percent, null);
  const cold = notices[1];
  assert.equal(cold.rewriteTokens, 93_000);
  assert.ok(cold.rewriteUsd > 0);
  assert.ok(changes() >= 3);

  const s = w.state(now);
  assert.equal(s.convo?.sessionId, "s1");
  assert.ok(s.convo.context >= 93_000);
  // Written five minutes' worth a moment ago, so a few minutes are left.
  assert.ok(s.convo.expiresAt > now && s.convo.expiresAt - now < 5 * MIN);
  assert.deepEqual(s.cold, { count: 1, usd: cold.rewriteUsd });
  assert.equal(s.lastTurn?.title, "app");
  assert.equal(s.lastTurn?.sessionId, "s1");
});

test("the heads-up comes as early as the setting says", async () => {
  const now = Date.now();
  const cwd = path.join(home, "work", "late");
  fs.mkdirSync(cwd, { recursive: true });
  // A root of its own, so the morning's tests never see this conversation.
  const root = path.join(home, "late-projects");
  // A 200K write a minute and a half ago: about three minutes left on its cache.
  const recs = transcript(
    "s2",
    cwd,
    [{ prompt: "keep going" }, { after: 5, read: 0, write: 200_000 }],
    now - 105_000,
  );
  writeTranscript(root, cwd, "s2", recs);
  const { events } = await ingestClaudeCode({ root });
  const said = (minutes) => {
    const notices = [];
    const w = createLiveWatch({
      folders: () => [cwd],
      onNotice: (n) => notices.push(n),
      onChange: () => {},
      expiringMs: () => expiringMinutes(minutes) * MIN,
    });
    for (const e of events.filter((x) => x.sessionId === "s2")) w.push(e);
    w.tick();
    return notices.filter((n) => n.kind === "expiring");
  };
  assert.equal(said(5).length, 1);
  assert.deepEqual(said(1), [], "inside five minutes, not yet inside one");

  assert.equal(expiringMinutes(undefined), 5);
  assert.equal(expiringMinutes(Number.NaN), 5);
  assert.equal(expiringMinutes(0), 1);
  assert.equal(expiringMinutes(30), 10);
  assert.equal(expiringMinutes(2), 2);
});

test("a call seen in the snapshot is not news again", async () => {
  const now = Date.now();
  const { cwd, events } = await morning(now);
  const { w, notices } = watch(cwd);
  w.seed(
    snapshot({ recent: events, at: new Date(now).toISOString(), titles: { s1: "Login bug" } }, now),
  );
  for (const e of events) w.push(e);
  assert.deepEqual(notices, []);
  // The snapshot's titles name the conversation.
  assert.equal(w.state(now).convo?.title, "Login bug");
  assert.equal(w.titleOf("s1"), "Login bug");
});

test("the 5-hour estimate adds what was spent since the snapshot", async () => {
  const now = Date.now();
  const { cwd, events } = await morning(now);
  const { w } = watch(cwd);
  const end = new Date(now + 2 * 3_600_000).toISOString();
  w.seed(
    snapshot(
      {
        at: new Date(now - 40 * MIN).toISOString(),
        plan: {
          label: "Claude Pro",
          priceUsd: 20,
          valueMonthlyUsd: 676,
          multiple: 33.8,
          limitUsd: 10,
          current: { usd: 2, end, share: 0.2 },
        },
      },
      now,
    ),
  );
  assert.deepEqual(w.state(now).fiveHour, { percent: 20, resetsAt: end, basis: "estimate" });
  for (const e of events) w.push(e);
  const spent = events.reduce((t, e) => t + e.cost.total, 0);
  const five = w.state(now).fiveHour;
  assert.equal(five.basis, "estimate");
  assert.ok(Math.abs(five.percent - ((2 + spent) / 10) * 100) < 1e-9);
});

test("another folder's conversation is not right now, but shows as warm elsewhere", async () => {
  const now = Date.now();
  const { cwd, events } = await morning(now);
  const other = watch(path.join(home, "work", "other")).w;
  const mine = watch(cwd).w;
  for (const e of events) {
    other.push(e);
    mine.push(e);
  }
  const s = other.state(now);
  assert.equal(s.convo, null);
  assert.deepEqual(
    s.warm.map((c) => c.sessionId),
    ["s1"],
  );
  // The folder's own conversation is not listed twice.
  assert.deepEqual(mine.state(now).warm, []);
  // Twelve hours on, it is history.
  assert.equal(mine.state(now + 13 * 3_600_000).convo, null);
});
