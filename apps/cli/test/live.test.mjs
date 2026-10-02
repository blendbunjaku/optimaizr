import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ingestClaudeCode, findWaste, createLiveAnalyzer } from "@optimaizr/core";
import { tailLedger } from "@optimaizr/local";

const USAGE = {
  input_tokens: 4,
  output_tokens: 300,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 1_000,
};

/**
 * Mechanical traffic arriving over an hour, rather than over weeks.
 *
 * The span matters: live analysis is the one place where a window is minutes
 * long, which is exactly the condition that makes a monthly projection lie.
 */
function burstFixture(n = 60) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-live-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  const records = [];
  for (let i = 0; i < n; i++) {
    const mm = String(i % 60).padStart(2, "0");
    records.push({
      type: "assistant",
      timestamp: `2026-09-19T10:${mm}:00.000Z`,
      sessionId: "session-a",
      cwd: "/Users/someone/project",
      message: {
        id: `msg_${i}`,
        model: "claude-sonnet-5",
        usage: USAGE,
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }],
        stop_reason: "end_turn",
      },
    });
  }
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

/**
 * Mechanical traffic *plus* duplicate tool reads, so the window carries both a
 * model-choice finding and one that has nothing to do with model choice.
 */
function mixedFixture(n = 60) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-live-mixed-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  const records = [];
  for (let i = 0; i < n; i++) {
    const mm = String(i % 60).padStart(2, "0");
    records.push({
      type: "assistant",
      timestamp: `2026-09-19T10:${mm}:00.000Z`,
      sessionId: "session-a",
      cwd: "/Users/someone/project",
      message: {
        id: `msg_${i}`,
        model: "claude-sonnet-5",
        usage: USAGE,
        content: [
          { type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: "/same.ts" } },
        ],
        stop_reason: "end_turn",
      },
    });
    records.push({
      type: "user",
      timestamp: `2026-09-19T10:${mm}:01.000Z`,
      sessionId: "session-a",
      cwd: "/Users/someone/project",
      message: {
        content: [{ type: "tool_result", tool_use_id: `r${i}`, content: "x".repeat(20_000) }],
      },
    });
  }
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

async function events() {
  const data = await ingestClaudeCode({ root: burstFixture() });
  return data.events;
}

/** Stream every event through an analyzer and collect what it announced. */
function streamAll(evts, opts = {}) {
  const analyzer = createLiveAnalyzer({ minIntervalMs: 0, ...opts });
  const out = [];
  for (const e of evts) out.push(...analyzer.push(e));
  out.push(...analyzer.flush());
  return out;
}

test("a single call recommends nothing - the rules are population statistics", async () => {
  const evts = await events();
  const analyzer = createLiveAnalyzer({ minIntervalMs: 0 });
  assert.equal(analyzer.push(evts[0]).length, 0);
});

test("live surfaces the same rules the batch path finds", async () => {
  const evts = await events();
  const live = new Set(streamAll(evts).map((r) => r.finding.rule));
  const batch = new Set(
    findWaste({
      events: evts,
      window: { from: evts[0].ts, to: evts.at(-1).ts, days: 1 },
      sources: [],
      warnings: [],
    })
      .filter((f) => !f.advisory)
      .map((f) => f.rule),
  );

  assert.ok(live.size > 0, "expected live recommendations");
  for (const rule of live) {
    assert.ok(batch.has(rule), `live invented a rule the batch engine does not have: ${rule}`);
  }
});

test("a standing finding is announced once, not once per call", async () => {
  const evts = await events();
  const counts = new Map();
  for (const rec of streamAll(evts)) {
    counts.set(rec.finding.rule, (counts.get(rec.finding.rule) ?? 0) + 1);
  }
  assert.ok(counts.size > 0, "expected at least one rule to fire");
  for (const [rule, n] of counts) {
    // Repeats are allowed only when the cost doubled, so over one short burst
    // a handful is the ceiling - never one per call.
    assert.ok(n < 10, `${rule} was announced ${n} times over ${evts.length} calls`);
  }
});

test("live reports money observed, never money projected", async () => {
  const evts = await events();
  for (const rec of streamAll(evts)) {
    assert.equal(
      rec.observedUsd,
      rec.finding.savings.windowUsd,
      "observedUsd must be the window figure",
    );
    // The projection exists on the finding but must never be what live quotes:
    // over an hour of traffic it is inflated by more than an order of magnitude.
    assert.ok(
      rec.observedUsd <= rec.finding.savings.monthlyUsd,
      "a projection leaked into the live figure",
    );
    assert.ok(rec.windowMs > 0 && rec.windowEvents > 0, "the window is reported alongside it");
  }
});

test("the judge can veto a downgrade but can never invent one", async () => {
  const evts = await events();

  const unopposed = streamAll(evts).map((r) => r.finding.rule);
  assert.ok(unopposed.includes("model-fit"), "fixture should trigger model-fit");

  // Judge says this traffic genuinely needs its model: the downgrade is
  // withheld — reported, so the user can see the decision, but never proposed.
  const vetoed = streamAll(evts, { judge: () => 0.95 });
  const held = vetoed.find((r) => r.finding.rule === "model-fit");
  assert.ok(held, "a veto must still be reported, not silently dropped");
  assert.equal(held.withheld.by, "jev");
  assert.ok(held.withheld.needsFrontierShare >= 0.6);
  assert.ok(
    !vetoed.some((r) => r.finding.rule === "model-fit" && !r.withheld),
    "a vetoed finding must never be proposed",
  );

  // Judge disagrees: the rule speaks as it would have anyway.
  const allowed = streamAll(evts, { judge: () => 0.05 });
  assert.ok(
    allowed.some((r) => r.finding.rule === "model-fit"),
    "a low score must not withhold",
  );
  const judged = allowed.find((r) => r.finding.rule === "model-fit");
  assert.ok(judged.judged.sampled > 0, "the judged sample size is reported");
  assert.equal(judged.withheld, undefined, "a low score leaves it proposable");

  // No opinion is the default state and must change nothing.
  const abstained = streamAll(evts, { judge: () => undefined }).map((r) => r.finding.rule);
  assert.deepEqual(abstained, unopposed, "an abstaining judge must be a no-op");
});

test("a veto removes only the finding it is about", async () => {
  const data = await ingestClaudeCode({ root: mixedFixture() });
  const evts = data.events;

  const asked = [];
  const unopposed = new Set(streamAll(evts).map((r) => r.finding.rule));
  assert.ok(unopposed.has("model-fit"), "mixed fixture should still trigger model-fit");
  const unrelated = [...unopposed].filter((r) => r !== "model-fit");
  assert.ok(unrelated.length > 0, "mixed fixture should trigger a non-model rule too");

  const results = streamAll(evts, {
    judge: (e) => {
      asked.push(e.id);
      return 0.95;
    },
  });
  // Proposed = everything not marked withheld.
  const proposed = new Set(results.filter((r) => !r.withheld).map((r) => r.finding.rule));

  assert.ok(asked.length > 0, "expected the judge to be consulted");
  assert.ok(!proposed.has("model-fit"), "the veto should stop model-fit being proposed");
  assert.ok(
    results.some((r) => r.finding.rule === "model-fit" && r.withheld),
    "and should report it as withheld instead",
  );
  for (const rule of unrelated) {
    assert.ok(proposed.has(rule), `a model-fit veto must not silence ${rule}`);
  }
});

test("tailLedger follows appends and survives a partial line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-tail-"));
  const file = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(file, "");

  const seen = [];
  const tail = tailLedger((e) => seen.push(e.id), { path: file, intervalMs: 10 });

  const rec = (id) => JSON.stringify({ id, model: "claude-sonnet-5", ts: "2026-09-19T10:00:00Z" });
  fs.appendFileSync(file, rec("a") + "\n");
  // A record split across two reads must arrive intact, exactly once.
  const half = rec("b");
  fs.appendFileSync(file, half.slice(0, 10));
  await sleep(40);
  fs.appendFileSync(file, half.slice(10) + "\n");

  await sleep(60);
  tail.stop();

  assert.deepEqual(seen, ["a", "b"]);
});

test("a failing Jev never stops local recommendations", async () => {
  const { createLiveSession } = await import("@optimaizr/local");
  const evts = await events();

  const errors = [];
  const recs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const session = createLiveSession({
      analyzer: { minIntervalMs: 0 },
      jev: { apiKey: "sk-test", minCalls: 1, onError: (e) => errors.push(e) },
      onRecommendation: (r) => recs.push(r),
    });
    for (const e of evts) session.onEvent(e);
    session.flush();
    // Let the fire-and-forget refresh settle.
    await sleep(20);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(recs.length > 0, "local rules must keep working when Jev is down");
  assert.ok(errors.length > 0, "the failure should be reported, not swallowed silently");
  assert.ok(
    recs.some((r) => r.finding.rule === "model-fit"),
    "an unreachable Jev must not withhold a local finding",
  );
});

test("a live finding names the sessions and calls behind it", async () => {
  const recs = streamAll(await events());
  assert.ok(recs.length > 0, "expected live recommendations");
  for (const rec of recs) {
    assert.ok(rec.sessions >= 1);
    assert.ok(rec.examples.length > 0 && rec.examples.length <= 3);
    assert.ok(rec.examples.every((e) => rec.finding.affects(e)));
  }
});

test("cents are not announced: the default floor drops trivial findings", async () => {
  const evts = await events();
  const loose = streamAll(evts, { minUsd: 0 });
  const strict = streamAll(evts);
  assert.ok(strict.every((r) => r.observedUsd >= 0.25));
  assert.ok(strict.length <= loose.length);
});
