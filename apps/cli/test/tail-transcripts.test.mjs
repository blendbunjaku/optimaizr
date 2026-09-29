import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ingestClaudeCode, ingestCodex } from "@optimaizr/core";
import { tailTranscripts, tailCodex } from "@optimaizr/local";

const USAGE = {
  input_tokens: 4,
  output_tokens: 300,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 1_000,
};

function projectTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

/** One assistant record, as Claude Code writes them. */
function assistant(i, over = {}) {
  return {
    type: "assistant",
    timestamp: `2026-09-19T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
    sessionId: "session-a",
    cwd: "/Users/someone/project",
    message: {
      id: `msg_${i}`,
      model: "claude-sonnet-5",
      usage: USAGE,
      content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }],
      stop_reason: "end_turn",
      ...over,
    },
  };
}

/** Collect events while `write` appends to the transcript. */
async function follow(write, opts = {}) {
  const { root, dir } = projectTree();
  const file = path.join(dir, "session-a.jsonl");
  fs.writeFileSync(file, "");

  const seen = [];
  const tail = tailTranscripts((e) => seen.push(e), {
    roots: [root],
    intervalMs: 40,
    quietMs: 120,
    keepAlive: true,
    // Start at byte 0 so nothing written before the first poll is missed.
    backfill: 1,
    ...opts,
  });

  await write(file);
  await sleep(400);
  tail.flush();
  tail.stop();
  return { seen, file, root };
}

test("follows a session as it is written", async () => {
  const { seen } = await follow(async (file) => {
    for (let i = 0; i < 6; i++) {
      fs.appendFileSync(file, JSON.stringify(assistant(i)) + "\n");
      await sleep(20);
    }
  });

  assert.equal(seen.length, 6);
  assert.equal(seen[0].source, "claude-code");
  assert.equal(seen[0].model, "claude-sonnet-5");
  assert.equal(seen[0].project, "/Users/someone/project");
  assert.ok(seen[0].cost.total > 0);
});

test("live and batch agree exactly on the same transcript", async () => {
  const records = Array.from({ length: 12 }, (_, i) => assistant(i));

  const { seen } = await follow(async (file) => {
    for (const r of records) {
      fs.appendFileSync(file, JSON.stringify(r) + "\n");
      await sleep(15);
    }
  });

  const { root: bRoot, dir: bDir } = projectTree();
  fs.writeFileSync(
    path.join(bDir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const batch = (await ingestClaudeCode({ root: bRoot })).events;

  const key = (e) => `${e.id}|${e.inputTokens}|${e.outputTokens}|${e.cost.total.toFixed(8)}`;
  assert.deepEqual(seen.map(key).sort(), batch.map(key).sort());
});

test("a response split across records is emitted once, with the final usage", async () => {
  // Claude Code writes the same message id several times; the last carries the
  // completed usage. Emitting per record would double count.
  const { seen } = await follow(async (file) => {
    const partial = assistant(1, { usage: { input_tokens: 4, output_tokens: 10 } });
    const complete = assistant(1, { usage: USAGE });
    fs.appendFileSync(file, JSON.stringify(partial) + "\n");
    await sleep(20);
    fs.appendFileSync(file, JSON.stringify(complete) + "\n");
  });

  assert.equal(seen.length, 1, "one response must produce one event");
  assert.equal(seen[0].outputTokens, 300, "the completed usage wins");
  assert.equal(seen[0].cacheReadTokens, 50_000);
});

test("history is ignored by default - live means live", async () => {
  const { root, dir } = projectTree();
  const file = path.join(dir, "session-a.jsonl");
  // A transcript that already exists before anyone starts watching.
  fs.writeFileSync(
    file,
    Array.from({ length: 5 }, (_, i) => JSON.stringify(assistant(i))).join("\n") + "\n",
  );

  const seen = [];
  const tail = tailTranscripts((e) => seen.push(e), {
    roots: [root],
    intervalMs: 40,
    quietMs: 120,
    keepAlive: true,
  });
  await sleep(200);
  fs.appendFileSync(file, JSON.stringify(assistant(99)) + "\n");
  await sleep(400);
  tail.flush();
  tail.stop();

  assert.equal(seen.length, 1, "only the call made after watching began");
  assert.equal(seen[0].id, "msg_99");
});

test("backfill replays what is already there", async () => {
  const { root, dir } = projectTree();
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    Array.from({ length: 5 }, (_, i) => JSON.stringify(assistant(i))).join("\n") + "\n",
  );

  const seen = [];
  const tail = tailTranscripts((e) => seen.push(e), {
    roots: [root],
    intervalMs: 40,
    quietMs: 120,
    backfill: 1,
    keepAlive: true,
  });
  await sleep(400);
  tail.flush();
  tail.stop();

  assert.equal(seen.length, 5);
});

test("a session that starts after watching began is picked up", async () => {
  const { root, dir } = projectTree();
  fs.writeFileSync(path.join(dir, "session-a.jsonl"), "");

  const seen = [];
  const tail = tailTranscripts((e) => seen.push(e), {
    roots: [root],
    intervalMs: 40,
    quietMs: 120,
    keepAlive: true,
  });
  await sleep(120);

  // A brand new session file, as opening a second Claude Code window would.
  const later = path.join(dir, "session-b.jsonl");
  fs.writeFileSync(later, JSON.stringify(assistant(7)) + "\n");
  await sleep(400);
  tail.flush();
  tail.stop();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, "msg_7");
});

test("a multi-byte character split across two reads is not corrupted", async () => {
  // Transcripts are full of non-ASCII. Decoding each chunk independently turns
  // a half-written character into U+FFFD and silently loses the whole record.
  const record = assistant(3, {
    content: [{ type: "text", text: "em—dash and ünïcode ✅ in the answer" }],
  });
  const bytes = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const cut = bytes.indexOf(Buffer.from("—", "utf8")) + 1; // mid-character

  const { seen } = await follow(async (file) => {
    fs.appendFileSync(file, bytes.subarray(0, cut));
    await sleep(120); // let a poll read the half character
    fs.appendFileSync(file, bytes.subarray(cut));
  });

  assert.equal(seen.length, 1, "the record must survive the split");
  assert.equal(seen[0].id, "msg_3");
});

test("flush emits a response that has not settled yet", async () => {
  const { root, dir } = projectTree();
  const file = path.join(dir, "session-a.jsonl");
  fs.writeFileSync(file, "");

  const seen = [];
  const tail = tailTranscripts((e) => seen.push(e), {
    roots: [root],
    intervalMs: 40,
    // Long settle window: nothing would be emitted on its own.
    quietMs: 60_000,
    backfill: 1,
    keepAlive: true,
  });
  fs.appendFileSync(file, JSON.stringify(assistant(1)) + "\n");
  await sleep(200);
  assert.equal(seen.length, 0, "not settled yet");

  tail.flush();
  tail.stop();
  assert.equal(seen.length, 1, "shutdown must not lose the call in flight");
});

test("an unreadable root is survivable", async () => {
  const seen = [];
  const tail = tailTranscripts((e) => seen.push(e), {
    roots: ["/nope/not/here"],
    intervalMs: 40,
    keepAlive: true,
  });
  await sleep(120);
  tail.flush();
  tail.stop();
  assert.equal(seen.length, 0);
});

/* ------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------ */

function codexTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tail-"));
  const dir = path.join(root, "2026", "04", "08");
  fs.mkdirSync(dir, { recursive: true });
  return { root, file: path.join(dir, "rollout-2026-04-08T20-23-03-abc.jsonl") };
}

const cxUsage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

const cxLines = (n) => {
  const out = [
    {
      type: "session_meta",
      timestamp: "2026-04-08T18:23:00.000Z",
      payload: { id: "sess-1", cwd: "/w" },
    },
    {
      type: "turn_context",
      timestamp: "2026-04-08T18:23:01.000Z",
      payload: { model: "gpt-5.4", effort: "medium" },
    },
    // Sessions open with an empty token_count before anything is spent.
    {
      type: "event_msg",
      timestamp: "2026-04-08T18:23:02.000Z",
      payload: { type: "token_count", info: null },
    },
  ];
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1100;
    out.push({
      type: "event_msg",
      timestamp: `2026-04-08T18:${String(23 + i).padStart(2, "0")}:15.000Z`,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: cxUsage(1000, 200, 100, 10),
          total_token_usage: cxUsage(total, 0, 0, 0),
        },
      },
    });
  }
  return out.map((r) => JSON.stringify(r));
};

test("codex: follows a session as it is written", async () => {
  const { root, file } = codexTree();
  fs.writeFileSync(file, "");
  const seen = [];
  const tail = tailCodex((e) => seen.push(e), {
    roots: [root],
    intervalMs: 40,
    backfill: 1,
    keepAlive: true,
  });

  for (const l of cxLines(4)) {
    fs.appendFileSync(file, l + "\n");
    await sleep(15);
  }
  await sleep(200);
  tail.flush();
  tail.stop();

  assert.equal(seen.length, 4, "the null-info opener must not become a call");
  assert.equal(seen[0].source, "codex");
  assert.equal(seen[0].provider, "openai");
  assert.equal(seen[0].model, "gpt-5.4");
  assert.equal(seen[0].inputTokens, 800, "cached tokens come out of input");
  assert.equal(seen[0].cacheReadTokens, 200);
  assert.ok(seen[0].cost.total > 0);
});

test("codex: live and batch agree exactly", async () => {
  const lines = cxLines(6);

  const a = codexTree();
  fs.writeFileSync(a.file, "");
  const seen = [];
  const tail = tailCodex((e) => seen.push(e), {
    roots: [a.root],
    intervalMs: 40,
    backfill: 1,
    keepAlive: true,
  });
  for (const l of lines) {
    fs.appendFileSync(a.file, l + "\n");
    await sleep(10);
  }
  await sleep(200);
  tail.flush();
  tail.stop();

  const b = codexTree();
  fs.writeFileSync(b.file, lines.join("\n") + "\n");
  const batch = (await ingestCodex({ root: b.root })).events;

  const key = (e) => `${e.id}|${e.inputTokens}|${e.outputTokens}|${e.cost.total.toFixed(8)}`;
  assert.deepEqual(seen.map(key), batch.map(key));
});

test("codex: history is ignored by default", async () => {
  const { root, file } = codexTree();
  fs.writeFileSync(file, cxLines(3).join("\n") + "\n");

  const seen = [];
  const tail = tailCodex((e) => seen.push(e), { roots: [root], intervalMs: 40, keepAlive: true });
  await sleep(150);
  tail.flush();
  tail.stop();

  assert.equal(seen.length, 0, "existing rollouts are history, not live traffic");
});
