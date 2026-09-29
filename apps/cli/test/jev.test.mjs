import { test } from "node:test";
import assert from "node:assert/strict";

import { createJevJudge } from "@optimaizr/local";

function call(i, over = {}) {
  return {
    id: `c${i}`,
    source: "sdk",
    provider: "anthropic",
    ts: "2026-09-19T10:00:00.000Z",
    model: "claude-sonnet-5",
    sessionId: "s",
    project: "app",
    route: "summarise-ticket",
    inputTokens: 1200,
    outputTokens: 180,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    tools: [{ id: "t", name: "Read", signature: "Read:/a.ts" }],
    cost: { total: 0.01 },
    ...over,
  };
}

/** Every key the request is permitted to disclose. Nothing else may appear. */
const ALLOWED_KEYS = [
  "route",
  "model",
  "calls",
  "median_input_tokens",
  "median_output_tokens",
  "thinking_tokens",
  "tools",
];

test("nothing is described until a route has enough traffic to be worth asking about", () => {
  const judge = createJevJudge({ minCalls: 5 });
  for (let i = 0; i < 4; i++) judge.observe(call(i));
  assert.equal(judge.describeEgress(), null);

  judge.observe(call(99));
  assert.ok(judge.describeEgress(), "five calls should qualify the route");
});

test("the request is exactly the documented shape", () => {
  const judge = createJevJudge({ minCalls: 1 });
  judge.observe(call(1));
  const body = judge.describeEgress();

  assert.equal(body.model, "jev-latest");
  assert.ok(Array.isArray(body.state));
  assert.equal(body.state.length, 1);

  const questions = Object.values(body.questions);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].type, "noul");
  assert.ok(typeof questions[0].instructions === "string");
  assert.ok(typeof questions[0].criteria.true === "string");
  assert.ok(typeof questions[0].criteria.false === "string");
  // Question ids are positional, never the free-form route label.
  assert.deepEqual(Object.keys(body.questions), ["r0"]);
});

test("only route metadata is ever described - no prompt content can leak", () => {
  const judge = createJevJudge({ minCalls: 1 });
  // A prompt-shaped payload smuggled through every field a caller controls.
  const secret = "PATIENT SSN 123-45-6789 please summarise this record";
  judge.observe(
    call(1, {
      tools: [{ id: "t", name: "Read", signature: `Read:${secret}` }],
    }),
  );

  const body = judge.describeEgress();
  const wire = JSON.stringify(body);

  // Tool *signatures* carry file paths and arguments. Only names may travel.
  assert.ok(!wire.includes(secret), "a tool signature leaked into the request");
  assert.ok(!wire.includes("123-45-6789"), "payload content leaked into the request");

  // Whitelist the state line: every key present must be one we sanctioned.
  for (const line of body.state) {
    const keys = [...line.matchAll(/(^|\s)([a-z_]+)=/g)].map((m) => m[2]);
    for (const k of keys) {
      assert.ok(ALLOWED_KEYS.includes(k), `undisclosed field in egress: ${k}`);
    }
  }
});

test("with no API key nothing is sent and no verdict is formed", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network call attempted without a key");
  };
  try {
    const judge = createJevJudge({
      apiKey: undefined,
      minCalls: 1,
      onRequest: (b) => sent.push(b),
    });
    judge.observe(call(1));
    await judge.refresh();

    assert.equal(sent.length, 0, "nothing should be sent without a key");
    assert.equal(judge.verdicts().size, 0);
    assert.equal(judge.judge(call(1)), undefined, "no opinion is the default state");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a dry run shows the request without making one", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("dry run must not touch the network");
  };
  try {
    const judge = createJevJudge({
      apiKey: "sk-test",
      minCalls: 1,
      dryRun: true,
      onRequest: (b) => sent.push(b),
    });
    judge.observe(call(1));
    await judge.refresh();

    assert.equal(sent.length, 1, "the request should be shown");
    assert.equal(judge.verdicts().size, 0, "a dry run forms no verdicts");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failing Jev degrades to no opinion, never to an error", async () => {
  const errors = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 529, statusText: "Overloaded" });
  try {
    const judge = createJevJudge({
      apiKey: "sk-test",
      minCalls: 1,
      onError: (e) => errors.push(e),
    });
    judge.observe(call(1));
    await judge.refresh(); // must not reject

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /529/);
    assert.equal(judge.judge(call(1)), undefined, "a failure leaves the rules unopposed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a verdict is parsed back onto the right route", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: "jev-1.13.0",
      answers: { r0: { type: "noul", noul: 0.91 } },
      usage: { input_tokens: 120, output_tokens: 0 },
    }),
  });
  try {
    const judge = createJevJudge({ apiKey: "sk-test", minCalls: 1 });
    judge.observe(call(1));
    await judge.refresh();

    assert.equal(judge.judge(call(2)), 0.91, "the verdict applies to the whole route");
    assert.equal(
      judge.judge(call(3, { route: "other-route" })),
      undefined,
      "and only to that route",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
