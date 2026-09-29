import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { wrap, withRoute } from "@optimaizr/local";
import { drain, readLedger } from "@optimaizr/local";
import { readSamples } from "@optimaizr/local";
import { verifyCandidate } from "@optimaizr/local";

/**
 * Integration tests against the *real* Anthropic SDK.
 *
 * The stub tests prove the logic. These prove the wrapper survives contact with
 * the actual client: a real Proxy over a real class instance, real HTTP, real
 * SSE parsing, real error objects. The only thing faked is the endpoint, so no
 * money is spent and no key is needed.
 */

let Anthropic;
try {
  const mod = await import("@anthropic-ai/sdk");
  Anthropic = mod.default ?? mod.Anthropic;
} catch {
  Anthropic = null;
}

const SKIP = Anthropic ? false : "@anthropic-ai/sdk is not installed";

/** Token profiles per model, so the cheap model really is cheaper. */
const PROFILES = {
  "claude-sonnet-5": {
    input: 1200,
    output: 420,
    text: "A careful, complete summary of the ticket.",
  },
  "claude-haiku-4-5": {
    input: 1200,
    output: 380,
    text: "A careful, complete summary of the ticket.",
  },
  "claude-opus-5": { input: 900, output: 5, text: "TIE" },
};

/** A stand-in for the Anthropic API. Speaks the real wire format. */
function startMockApi() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let params = {};
      try {
        params = JSON.parse(body);
      } catch {
        /* malformed */
      }
      seen.push(params);

      if (params.__fail) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "slow down" },
          }),
        );
        return;
      }

      const model = params.model ?? "claude-sonnet-5";
      const profile = PROFILES[model] ?? PROFILES["claude-sonnet-5"];

      // The judge asks a specific question; answer it in its own format.
      const systemText =
        typeof params.system === "string"
          ? params.system
          : Array.isArray(params.system)
            ? params.system.map((b) => b.text ?? "").join("")
            : "";
      const isJudge = systemText.includes("evaluating two responses");
      const text = isJudge ? "TIE" : profile.text;

      const usage = {
        input_tokens: profile.input,
        output_tokens: isJudge ? 5 : profile.output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };

      if (params.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

        send("message_start", {
          message: {
            id: "msg_stream_1",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: profile.input, output_tokens: 0 },
          },
        });
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
        send("content_block_stop", { index: 0 });
        send("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: profile.output },
        });
        send("message_stop", {});
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${Math.random().toString(36).slice(2, 10)}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

/**
 * Shut a mock endpoint down completely.
 *
 * `server.close()` alone only stops *new* connections - it leaves established
 * keep-alive sockets open, and the SDK's HTTP client keeps them alive by
 * design. The server handle then holds the event loop open and `node --test`
 * never exits: the suite passes and the process hangs, which on CI reads as a
 * stuck job rather than a failing test.
 */
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-int-"));
  process.env.OPTIMAIZR_DIR = dir;
  return dir;
}

function makeClient(port, opts = {}) {
  const client = new Anthropic({
    apiKey: "sk-ant-test-key-not-real",
    baseURL: `http://127.0.0.1:${port}`,
    maxRetries: 0,
  });
  return wrap(client, opts);
}

test("wraps a real SDK client and records a real HTTP call", { skip: SKIP }, async () => {
  useTempStore();
  const { server, port } = await startMockApi();

  try {
    const client = makeClient(port, { service: "checkout-api" });
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system: "You summarise support tickets.",
      messages: [{ role: "user", content: "Customer cannot log in." }],
    });

    // The caller gets the genuine SDK response object.
    assert.equal(res.type, "message");
    assert.equal(res.model, "claude-sonnet-5");
    assert.equal(res.content[0].text, PROFILES["claude-sonnet-5"].text);

    await drain();
    const { events } = await readLedger();
    assert.equal(events.length, 1);

    const e = events[0];
    assert.equal(e.source, "sdk");
    assert.equal(e.project, "checkout-api");
    assert.equal(e.model, "claude-sonnet-5");
    assert.equal(e.provider, "anthropic");
    assert.equal(e.inputTokens, 1200);
    assert.equal(e.outputTokens, 420);
    assert.equal(e.systemChars, "You summarise support tickets.".length);
    assert.ok(e.latencyMs >= 0, "latency was measured");
    // Sonnet 5 at its list rate: $2/M in, $10/M out.
    assert.ok(Math.abs(e.cost.total - (1200 * 2 + 420 * 10) / 1e6) < 1e-9);
  } finally {
    await closeServer(server);
  }
});

test("real SDK streaming is recorded without disturbing the stream", { skip: SKIP }, async () => {
  useTempStore();
  const { server, port } = await startMockApi();

  try {
    const client = makeClient(port, { service: "streamer" });
    const stream = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });

    const types = [];
    for await (const chunk of stream) types.push(chunk.type);

    assert.ok(types.includes("message_start"), "caller saw message_start");
    assert.ok(types.includes("content_block_delta"), "caller saw the text delta");
    assert.ok(types.includes("message_stop"), "caller saw message_stop");

    await drain();
    const { events } = await readLedger();
    assert.equal(events.length, 1);
    assert.equal(events[0].inputTokens, 1200);
    assert.equal(events[0].outputTokens, 420, "final usage came from message_delta");
  } finally {
    await closeServer(server);
  }
});

test("the SDK's own .stream() helper is recorded too", { skip: SKIP }, async () => {
  useTempStore();
  const { server, port } = await startMockApi();

  try {
    const client = makeClient(port, { service: "helper" });
    const stream = client.messages.stream({
      model: "claude-sonnet-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });
    const final = await stream.finalMessage();

    assert.equal(final.content[0].text, PROFILES["claude-sonnet-5"].text);

    await drain();
    const { events } = await readLedger();
    assert.equal(events.length, 1);
    assert.equal(events[0].outputTokens, 420);
  } finally {
    await closeServer(server);
  }
});

test("a real SDK error propagates unchanged through the wrapper", { skip: SKIP }, async () => {
  useTempStore();
  const { server, port } = await startMockApi();

  try {
    const client = makeClient(port, { service: "failing" });
    await assert.rejects(
      () =>
        client.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 10,
          messages: [{ role: "user", content: "x" }],
          // @ts-expect-error - mock-only switch
          __fail: true,
        }),
      (err) => {
        // A genuine Anthropic SDK error class, not something we mangled.
        assert.equal(err.status, 429);
        assert.equal(err.constructor.name, "RateLimitError");
        return true;
      },
    );

    await drain();
    const { events } = await readLedger();
    assert.equal(events.length, 0, "a failed call is not recorded as spend");
  } finally {
    await closeServer(server);
  }
});

test("non-instrumented SDK methods still work through the Proxy", { skip: SKIP }, async () => {
  useTempStore();
  const { server, port } = await startMockApi();
  try {
    const client = makeClient(port, { service: "api" });
    assert.equal(typeof client.messages.countTokens, "function");
    assert.equal(client.baseURL, `http://127.0.0.1:${port}`);
    assert.equal(typeof client.beta.messages.create, "function");
  } finally {
    await closeServer(server);
  }
});

test("capture records a redacted sample from a real request", { skip: SKIP }, async () => {
  const dir = useTempStore();
  const { server, port } = await startMockApi();

  try {
    const client = makeClient(port, {
      service: "checkout-api",
      capture: { rate: 1 },
    });

    await withRoute("summarise-ticket", () =>
      client.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 512,
        system: "You summarise support tickets.",
        messages: [
          { role: "user", content: "Reach me at person@example.com about order 123456789012" },
        ],
      }),
    );

    const samples = await readSamples();
    assert.equal(samples.length, 1);
    assert.equal(samples[0].route, "summarise-ticket");
    assert.equal(samples[0].model, "claude-sonnet-5");

    const raw = fs.readFileSync(path.join(dir, "samples.jsonl"), "utf8");
    assert.ok(!raw.includes("person@example.com"), "email redacted before disk");
    assert.ok(!raw.includes("123456789012"), "long digit run redacted");
    assert.ok(raw.includes("[email]"));

    await drain();
    const { events } = await readLedger();
    assert.equal(events[0].route, "summarise-ticket");
  } finally {
    await closeServer(server);
  }
});

test(
  "end to end: record real traffic, then verify a cheaper model against it",
  { skip: SKIP },
  async () => {
    useTempStore();
    const { server, port, seen } = await startMockApi();

    try {
      // 1. A production workload runs through the wrapper, with capture on.
      const client = makeClient(port, { service: "checkout-api", capture: { rate: 1 } });
      for (let i = 0; i < 12; i++) {
        await withRoute("summarise-ticket", () =>
          client.messages.create({
            model: "claude-sonnet-5",
            max_tokens: 512,
            system: "You summarise support tickets.",
            messages: [{ role: "user", content: `Ticket ${i}: customer cannot log in.` }],
          }),
        );
      }

      await drain();
      const { events } = await readLedger();
      assert.equal(events.length, 12, "all traffic recorded");

      const samples = await readSamples({ route: "summarise-ticket" });
      assert.equal(samples.length, 12, "all traffic captured for replay");

      // 2. Now verify a model swap against that captured traffic.
      const rawClient = new Anthropic({
        apiKey: "sk-ant-test-key-not-real",
        baseURL: `http://127.0.0.1:${port}`,
        maxRetries: 0,
      });

      const before = seen.length;
      const result = await verifyCandidate({
        client: rawClient,
        candidate: {
          kind: "swap-model",
          to: "claude-haiku-4-5",
          matches: () => true,
          description: "Route to Haiku 4.5",
        },
        bar: {
          checks: [{ type: "no-refusal" }, { type: "min-chars", value: 10 }],
          judge: {
            model: "claude-opus-5",
            criteria: "Which response is more accurate and complete?",
            minWinRate: 0.45,
          },
          sampleSize: 12,
        },
        monthlyCalls: 3000,
      });

      // 12 replays + 12 pairs judged twice = 36 requests.
      assert.equal(seen.length - before, 36, "replays and swapped-order judging both happened");

      const replayed = seen.slice(before).filter((p) => p.model === "claude-haiku-4-5");
      assert.equal(replayed.length, 12, "the candidate model was actually called");

      assert.equal(result.samples, 12);
      assert.equal(result.verdict, "PASS");
      assert.ok(result.savingPerCall > 0, "Haiku really was cheaper");
      assert.ok(result.monthlySaving > 0);
      assert.equal(result.judge.winRate, 0.5, "all ties is parity");
      assert.ok(
        result.checks.every((c) => c.ok),
        "no quality check regressed",
      );
      assert.ok(result.verificationCost > 0, "the cost of proving it is reported");

      // The economics must match the token profiles the mock returned.
      const expectedBaseline = (1200 * 2 + 420 * 10) / 1e6;
      const expectedCandidate = (1200 * 1 + 380 * 5) / 1e6;
      assert.ok(Math.abs(result.baselineCostPerCall - expectedBaseline) < 1e-9);
      assert.ok(Math.abs(result.candidateCostPerCall - expectedCandidate) < 1e-9);
    } finally {
      await closeServer(server);
    }
  },
);
