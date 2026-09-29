import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { wrap, withRoute } from "@optimaizr/local";
import { drain, readLedger } from "@optimaizr/local";

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-wrap-"));
  process.env.OPTIMAIZR_DIR = dir;
  return dir;
}

/** A stand-in for the Anthropic client, with the same call surface. */
function fakeClient(response) {
  return {
    apiKey: "sk-test",
    messages: {
      async create(params) {
        return (
          response ?? {
            id: "msg_1",
            model: params.model,
            content: [{ type: "text", text: "hello" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000 },
          }
        );
      },
      async countTokens() {
        return { input_tokens: 7 };
      },
    },
  };
}

test("wrap records a call without changing the response", async () => {
  useTempStore();
  const client = wrap(fakeClient(), { service: "checkout-api" });

  const res = await client.messages.create({
    model: "claude-sonnet-5",
    system: "You are helpful.",
    messages: [{ role: "user", content: "hi" }],
  });

  // The caller sees exactly what the SDK returned.
  assert.equal(res.id, "msg_1");
  assert.deepEqual(res.content, [{ type: "text", text: "hello" }]);

  await drain();
  const { events } = await readLedger();
  assert.equal(events.length, 1);

  const e = events[0];
  assert.equal(e.source, "sdk");
  assert.equal(e.project, "checkout-api");
  assert.equal(e.model, "claude-sonnet-5");
  assert.equal(e.inputTokens, 1000);
  assert.equal(e.cacheReadTokens, 9000);
  assert.ok(e.cost.total > 0);
  assert.ok(typeof e.latencyMs === "number");
  assert.equal(e.systemChars, "You are helpful.".length);
});

test("withRoute labels calls for per-route analysis", async () => {
  useTempStore();
  const client = wrap(fakeClient(), { service: "api" });

  await withRoute("summarise-ticket", () =>
    client.messages.create({ model: "claude-sonnet-5", messages: [] }),
  );

  await drain();
  const { events } = await readLedger();
  assert.equal(events[0].route, "summarise-ticket");
});

test("the prefix fingerprint is stable for identical prefixes and moves when they change", async () => {
  useTempStore();
  const client = wrap(fakeClient(), { service: "api" });
  const base = { model: "claude-sonnet-5", system: "stable prompt", messages: [] };

  await client.messages.create(base);
  await client.messages.create({ ...base, messages: [{ role: "user", content: "differs" }] });
  await client.messages.create({ ...base, system: "stable prompt at 10:31:02" });

  await drain();
  const { events } = await readLedger();

  // Message content is below the cache breakpoint, so the prefix is unchanged.
  assert.equal(events[0].prefixHash, events[1].prefixHash);
  // A timestamp in the system prompt invalidates it - exactly what the rule looks for.
  assert.notEqual(events[0].prefixHash, events[2].prefixHash);
});

test("a recorder failure never breaks the caller", async () => {
  // Point the store at a path that cannot be created, so every append fails.
  //
  // Deliberately a directory *under a regular file*: mkdir then fails with
  // ENOTDIR immediately, on every platform. The previous version used a path
  // under /proc, which does not exist on macOS (so it failed fast locally) but
  // is real procfs on Linux - where it hung CI instead.
  const blocker = path.join(os.tmpdir(), `optimaizr-blocker-${process.pid}`);
  fs.writeFileSync(blocker, "not a directory");
  process.env.OPTIMAIZR_DIR = path.join(blocker, "optimaizr");
  const client = wrap(fakeClient(), { service: "api" });

  const res = await client.messages.create({ model: "claude-sonnet-5", messages: [] });
  assert.equal(res.id, "msg_1", "the call must still return normally");
  await drain();
});

test("API errors propagate unchanged", async () => {
  useTempStore();
  const failing = {
    messages: {
      async create() {
        const err = new Error("rate limited");
        err.status = 429;
        throw err;
      },
    },
  };

  const client = wrap(failing, { service: "api" });
  await assert.rejects(
    () => client.messages.create({ model: "claude-sonnet-5", messages: [] }),
    (err) => err.message === "rate limited" && err.status === 429,
  );
});

test("untouched methods still work", async () => {
  useTempStore();
  const client = wrap(fakeClient(), { service: "api" });
  const counted = await client.messages.countTokens({ messages: [] });
  assert.equal(counted.input_tokens, 7);
  assert.equal(client.apiKey, "sk-test");
});

test("streaming records the final usage from message_delta", async () => {
  useTempStore();
  const streaming = {
    messages: {
      async create() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "message_start",
              message: { id: "msg_s", model: "claude-sonnet-5", usage: { input_tokens: 800 } },
            };
            yield { type: "content_block_start", content_block: { type: "text", text: "" } };
            yield {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 250 },
            };
          },
        };
      },
    },
  };

  const client = wrap(streaming, { service: "api" });
  const stream = await client.messages.create({
    model: "claude-sonnet-5",
    messages: [],
    stream: true,
  });

  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks.length, 3, "every chunk still reaches the caller");

  await drain();
  const { events } = await readLedger();
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 800);
  assert.equal(events[0].outputTokens, 250);
});

test("capture is off unless asked for", async () => {
  const dir = useTempStore();
  const client = wrap(fakeClient(), { service: "api" });
  await client.messages.create({ model: "claude-sonnet-5", messages: [] });
  await drain();
  assert.equal(fs.existsSync(path.join(dir, "samples.jsonl")), false);
});

test("captured samples are redacted before they touch disk", async () => {
  const dir = useTempStore();
  const client = wrap(fakeClient(), { service: "api", capture: { rate: 1 } });

  await client.messages.create({
    model: "claude-sonnet-5",
    messages: [
      { role: "user", content: "email me at person@example.com, key sk-abcdefghijklmnop1234" },
    ],
  });

  const raw = fs.readFileSync(path.join(dir, "samples.jsonl"), "utf8");
  assert.ok(!raw.includes("person@example.com"), "email must not be stored");
  assert.ok(!raw.includes("sk-abcdefghijklmnop1234"), "api key must not be stored");
  assert.ok(raw.includes("[email]") && raw.includes("[api-key]"));
});
