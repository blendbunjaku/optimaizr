import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingestCodex } from "@optimaizr/core";

/** Write a rollout in the real on-disk layout: sessions/YYYY/MM/DD/rollout-*.jsonl */
function rollout(lines, name = "rollout-2026-04-08T20-23-03-abc.jsonl") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-"));
  const dir = path.join(root, "2026", "04", "08");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return root;
}

const meta = (cwd = "/Users/someone/project") => ({
  type: "session_meta",
  timestamp: "2026-04-08T18:23:00.000Z",
  payload: { id: "sess-1", cwd },
});

const turn = (model = "gpt-5.4", effort = "medium") => ({
  type: "turn_context",
  timestamp: "2026-04-08T18:23:01.000Z",
  payload: { model, effort },
});

/** A billable event. `total` is the running sum; `last` is this call's delta. */
const tokens = (ts, last, total) => ({
  type: "event_msg",
  timestamp: ts,
  payload: {
    type: "token_count",
    info: { last_token_usage: last, total_token_usage: total ?? last },
  },
});

const usage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

test("one populated token_count becomes one call", async () => {
  const root = rollout([
    meta(),
    turn(),
    // Sessions open with an empty token_count before anything is spent.
    {
      type: "event_msg",
      timestamp: "2026-04-08T18:23:02.000Z",
      payload: { type: "token_count", info: null },
    },
    tokens("2026-04-08T18:23:15.000Z", usage(13510, 9600, 231, 25)),
  ]);

  const data = await ingestCodex({ root });
  assert.equal(data.events.length, 1, "the null-info opener must not become a call");

  const e = data.events[0];
  assert.equal(e.source, "codex");
  assert.equal(e.provider, "openai");
  assert.equal(e.model, "gpt-5.4");
  assert.equal(e.sessionId, "sess-1");
  assert.equal(e.project, "/Users/someone/project");
  assert.equal(e.effort, "medium");
});

test("OpenAI token semantics are unpacked, not double counted", async () => {
  const root = rollout([
    meta(),
    turn(),
    tokens("2026-04-08T18:23:15.000Z", usage(13510, 9600, 231, 25)),
  ]);
  const [e] = (await ingestCodex({ root })).events;

  // input_tokens is inclusive of cached, so billable input is the difference.
  assert.equal(e.cacheReadTokens, 9600);
  assert.equal(e.inputTokens, 13510 - 9600);
  assert.equal(e.outputTokens, 231);
  assert.equal(e.thinkingTokens, 25);
  // OpenAI never charges to create a cache entry.
  assert.equal(e.cacheWrite5mTokens, 0);
  assert.equal(e.cacheWrite1hTokens, 0);
  assert.ok(e.cost.total > 0, "a priced model must produce a cost");
});

test("each call is the delta, not the running total", async () => {
  const root = rollout([
    meta(),
    turn(),
    tokens("2026-04-08T18:23:15.000Z", usage(13510, 9600, 231, 25), usage(13510, 9600, 231, 25)),
    tokens("2026-04-08T18:23:24.000Z", usage(15674, 13568, 403, 13), usage(29184, 23168, 634, 38)),
  ]);

  const { events } = await ingestCodex({ root });
  assert.equal(events.length, 2);
  assert.equal(events[1].inputTokens, 15674 - 13568);
  assert.equal(events[1].outputTokens, 403);
  // The sum of the deltas is the session total — the invariant that proves
  // last_token_usage is per call.
  assert.equal(
    events.reduce((s, e) => s + e.inputTokens + e.cacheReadTokens, 0),
    29184,
  );
});

test("a token_count that bills nothing new is ignored", async () => {
  const total = usage(13510, 9600, 231, 25);
  const root = rollout([
    meta(),
    turn(),
    tokens("2026-04-08T18:23:15.000Z", usage(13510, 9600, 231, 25), total),
    // Re-emitted on a rate-limit refresh: the running total has not moved.
    tokens("2026-04-08T18:23:18.000Z", usage(13510, 9600, 231, 25), total),
  ]);

  assert.equal((await ingestCodex({ root })).events.length, 1);
});

test("the model is tracked across turns, not read once", async () => {
  const root = rollout([
    meta(),
    turn("gpt-5.4"),
    tokens("2026-04-08T18:23:15.000Z", usage(1000, 0, 100, 0), usage(1000, 0, 100, 0)),
    turn("gpt-5-mini", "low"),
    tokens("2026-04-08T18:24:15.000Z", usage(500, 0, 50, 0), usage(1500, 0, 150, 0)),
  ]);

  const { events } = await ingestCodex({ root });
  assert.equal(events[0].model, "gpt-5.4");
  assert.equal(events[1].model, "gpt-5-mini");
  assert.equal(events[1].effort, "low");
});

test("tool calls and their output sizes are attached to the call that made them", async () => {
  const root = rollout([
    meta(),
    turn(),
    {
      type: "response_item",
      timestamp: "2026-04-08T18:23:10.000Z",
      payload: {
        type: "function_call",
        call_id: "c1",
        name: "exec_command",
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      type: "response_item",
      timestamp: "2026-04-08T18:23:11.000Z",
      payload: { type: "function_call_output", call_id: "c1", output: "x".repeat(4000) },
    },
    tokens("2026-04-08T18:23:15.000Z", usage(1000, 0, 100, 0)),
  ]);

  const [e] = (await ingestCodex({ root })).events;
  assert.equal(e.tools.length, 1);
  assert.equal(e.tools[0].name, "exec_command");
  assert.equal(e.tools[0].signature, 'exec_command:{"cmd":"ls"}');
  assert.equal(e.tools[0].resultChars, 4000);
});

test("tools belong to one call only", async () => {
  const root = rollout([
    meta(),
    turn(),
    {
      type: "response_item",
      timestamp: "2026-04-08T18:23:10.000Z",
      payload: { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
    },
    tokens("2026-04-08T18:23:15.000Z", usage(1000, 0, 100, 0), usage(1000, 0, 100, 0)),
    tokens("2026-04-08T18:23:25.000Z", usage(500, 0, 50, 0), usage(1500, 0, 150, 0)),
  ]);

  const { events } = await ingestCodex({ root });
  assert.equal(events[0].tools.length, 1);
  assert.equal(events[1].tools.length, 0, "tools must not carry over to the next call");
});

test("ids are deterministic, so decisions stay attached across re-reads", async () => {
  const lines = [meta(), turn(), tokens("2026-04-08T18:23:15.000Z", usage(1000, 0, 100, 0))];
  const root = rollout(lines);
  const a = await ingestCodex({ root });
  const b = await ingestCodex({ root });
  assert.deepEqual(
    a.events.map((e) => e.id),
    b.events.map((e) => e.id),
  );
  assert.match(a.events[0].id, /^sess-1#0$/);
});

test("a malformed line costs one record, not the file", async () => {
  const root = rollout([
    meta(),
    turn(),
    tokens("2026-04-08T18:23:15.000Z", usage(1000, 0, 100, 0)),
  ]);
  const file = path.join(root, "2026", "04", "08", "rollout-2026-04-08T20-23-03-abc.jsonl");
  fs.appendFileSync(file, "{not json}\n");

  const data = await ingestCodex({ root });
  assert.equal(data.events.length, 1);
  assert.ok(data.warnings.some((w) => w.includes("unparseable")));
});

test("a missing root warns rather than throwing", async () => {
  const data = await ingestCodex({ root: "/nope/does/not/exist" });
  assert.deepEqual(data.events, []);
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0], /No Codex transcripts/);
});

test("filters apply the same way they do for Claude Code", async () => {
  const root = rollout([
    meta("/Users/someone/alpha"),
    turn(),
    tokens("2026-04-08T18:23:15.000Z", usage(1000, 0, 100, 0)),
  ]);

  assert.equal((await ingestCodex({ root, project: "alpha" })).events.length, 1);
  assert.equal((await ingestCodex({ root, project: "beta" })).events.length, 0);
  // Every fixture timestamp is well in the past.
  assert.equal((await ingestCodex({ root, days: 1 })).events.length, 0);
});
