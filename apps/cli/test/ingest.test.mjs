import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingest, ingestClaudeCode, registerAdapter } from "@optimaizr/core";
import { findWaste } from "@optimaizr/core";
import { summarize } from "@optimaizr/core";

/**
 * Build a transcript that reproduces the real double-counting shape: one API
 * response written as several JSONL records, each stamped with the same usage.
 */
function writeFixture(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-test-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

const USAGE = {
  input_tokens: 4,
  output_tokens: 2488,
  cache_read_input_tokens: 200_000,
  cache_creation_input_tokens: 1_000,
};

function assistantRecord({ id, content, usage, ts = "2026-09-01T10:00:00.000Z" }) {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: "session-a",
    cwd: "/Users/someone/project",
    message: { id, model: "claude-sonnet-5", usage, content, stop_reason: "tool_use" },
  };
}

test("one API response split across records is counted once", async () => {
  const root = writeFixture([
    // Same message.id, three records: thinking, then two tool calls.
    assistantRecord({
      id: "msg_01",
      content: [{ type: "thinking", thinking: "..." }],
      usage: { ...USAGE, output_tokens: 3 }, // placeholder on the early record
    }),
    assistantRecord({
      id: "msg_01",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } }],
      usage: USAGE,
    }),
    assistantRecord({
      id: "msg_01",
      content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/b.ts" } }],
      usage: USAGE,
    }),
  ]);

  const data = await ingestClaudeCode({ root });

  assert.equal(data.events.length, 1, "three records are one API call");

  const event = data.events[0];
  // The completed record's usage wins over the placeholder.
  assert.equal(event.outputTokens, 2488);
  assert.equal(event.cacheReadTokens, 200_000);
  // Tool calls are unioned across the sibling records.
  assert.equal(event.tools.length, 2);
  assert.deepEqual(event.tools.map((t) => t.signature).sort(), ["Read:/a.ts", "Read:/b.ts"]);

  // The naive reading of this file - one row per record - overcounts 3x.
  const naive = 3 * (USAGE.cache_read_input_tokens + USAGE.output_tokens);
  const actual = event.cacheReadTokens + event.outputTokens;
  assert.ok(naive / actual > 2.9, "naive summing should inflate by roughly the record count");
});

test("distinct responses are kept separate", async () => {
  const root = writeFixture([
    assistantRecord({ id: "msg_01", content: [{ type: "text", text: "one" }], usage: USAGE }),
    assistantRecord({
      id: "msg_02",
      content: [{ type: "text", text: "two" }],
      usage: USAGE,
      ts: "2026-09-01T10:05:00.000Z",
    }),
  ]);
  const data = await ingestClaudeCode({ root });
  assert.equal(data.events.length, 2);
});

test("synthetic and model-less records are ignored", async () => {
  const root = writeFixture([
    { type: "assistant", message: { id: "x", model: "<synthetic>", usage: USAGE, content: [] } },
    { type: "assistant", message: { id: "y", usage: USAGE, content: [] } },
    { type: "system", subtype: "info" },
    assistantRecord({ id: "msg_real", content: [{ type: "text", text: "hi" }], usage: USAGE }),
  ]);
  const data = await ingestClaudeCode({ root });
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].id, "msg_real");
});

test("malformed lines are skipped and reported, not fatal", async () => {
  const root = writeFixture([
    assistantRecord({ id: "msg_01", content: [{ type: "text", text: "ok" }], usage: USAGE }),
  ]);
  const file = path.join(root, "-Users-someone-project", "session-a.jsonl");
  fs.appendFileSync(file, "{ this is not json\n");

  const data = await ingestClaudeCode({ root });
  assert.equal(data.events.length, 1);
  assert.ok(data.warnings.some((w) => w.includes("unparseable")));
});

test("an image result is measured by pixels, not by base64 length", async () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(900, 20);
  const base64 = Buffer.concat([png, Buffer.alloc(400_000)]).toString("base64");

  const root = writeFixture([
    assistantRecord({
      id: "msg_01",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/shot.png" } }],
      usage: USAGE,
    }),
    {
      type: "user",
      timestamp: "2026-09-01T10:00:01.000Z",
      sessionId: "session-a",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "image", source: { type: "base64", data: base64 } }],
          },
        ],
      },
    },
  ]);

  const data = await ingestClaudeCode({ root });
  const tool = data.events[0].tools[0];

  assert.equal(tool.imageCount, 1);
  assert.ok(tool.resultTokens < 2000, `expected a small token count, got ${tool.resultTokens}`);
  // Base64 length would have suggested a six-figure token count.
  assert.ok(base64.length / 4 > 100_000);
});

test("repeated reads of the same file are found and priced", async () => {
  const records = [];
  // Ten calls in one session, each re-reading the same large file.
  for (let i = 0; i < 10; i++) {
    records.push(
      assistantRecord({
        id: `msg_${i}`,
        ts: `2026-09-01T10:0${i}:00.000Z`,
        content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: "/big.ts" } }],
        usage: USAGE,
      }),
      {
        type: "user",
        timestamp: `2026-09-01T10:0${i}:01.000Z`,
        sessionId: "session-a",
        message: {
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(40_000) }],
        },
      },
    );
  }

  const data = await ingestClaudeCode({ root: writeFixture(records) });
  assert.equal(data.events.length, 10);

  const finding = findWaste(data).find((f) => f.rule === "repeat-tool-calls");
  assert.ok(finding, "expected a repeat-tool-calls finding");
  assert.ok(finding.savings.windowUsd > 0);
  assert.equal(finding.risk, "safe");
  assert.ok(finding.observations[0].includes("big.ts"));
});

test("summary totals agree with the sum of the events", async () => {
  const root = writeFixture([
    assistantRecord({ id: "m1", content: [{ type: "text", text: "a" }], usage: USAGE }),
    assistantRecord({
      id: "m2",
      ts: "2026-09-02T10:00:00.000Z",
      content: [{ type: "text", text: "b" }],
      usage: USAGE,
    }),
  ]);
  const data = await ingestClaudeCode({ root });
  const summary = summarize(data);

  const expected = data.events.reduce((s, e) => s + e.cost.total, 0);
  assert.ok(Math.abs(summary.totalCost - expected) < 1e-9);
  assert.equal(summary.calls, 2);
  assert.equal(summary.byModel[0].key, "claude-sonnet-5");
});

/*
 * Reported from a real install: 2,122 transcripts produced more responses
 * than a spread can pass as call arguments, and `ingest()` turned the whole
 * Claude Code history into one easily missed note.
 */
test("ingest merges an adapter's events however many there are", async () => {
  const n = 250_000;
  registerAdapter({
    provider: "any",
    label: "test: many events",
    canRead: (s) => s.kind === "test-many",
    read: async () => ({
      events: Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        ts: "2026-09-01T10:00:00.000Z",
      })),
      sources: [],
      warnings: [],
    }),
  });

  const data = await ingest([{ kind: "test-many" }]);
  assert.equal(data.events.length, n);
  assert.deepEqual(data.failures, []);
});

test("an adapter that throws is a failure, not a warning", async () => {
  registerAdapter({
    provider: "any",
    label: "test: broken",
    canRead: (s) => s.kind === "test-broken",
    read: async () => {
      throw new RangeError("Maximum call stack size exceeded");
    },
  });

  const data = await ingest([{ kind: "test-broken" }]);
  assert.deepEqual(data.failures, ["test: broken: Maximum call stack size exceeded"]);
  assert.deepEqual(data.warnings, []);
});

test(
  "an unreadable transcript is skipped, not the whole history",
  {
    // chmod does not deny reads on Windows, or to root.
    skip: process.platform === "win32" || process.getuid?.() === 0,
  },
  async () => {
    const root = writeFixture([
      assistantRecord({ id: "msg_01", content: [{ type: "text", text: "ok" }], usage: USAGE }),
    ]);
    const locked = path.join(root, "-Users-someone-other", "session-b.jsonl");
    fs.mkdirSync(path.dirname(locked));
    fs.writeFileSync(locked, "{}\n");
    fs.chmodSync(locked, 0o000);

    try {
      const data = await ingestClaudeCode({ root });
      assert.equal(data.events.length, 1);
      assert.ok(data.warnings.some((w) => w.startsWith("session-b.jsonl:")));
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  },
);
