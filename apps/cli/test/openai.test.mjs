import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  costOf,
  dialectOf,
  findWaste,
  normalizeUsage,
  priceFor,
  providerOf,
  ratesFor,
  textOf,
  toolNamesOf,
} from "@optimaizr/core";
import { applyCandidate, drain, readLedger, wrap } from "@optimaizr/local";

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

test("OpenAI models are priced from the same catalogue as Anthropic's", () => {
  const cost = costOf({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, "gpt-5");
  assert.equal(cost.input, 1.25);
  assert.equal(cost.output, 10);
  assert.equal(cost.total, 11.25);
});

test("resolves date-suffixed and gateway-prefixed OpenAI ids", () => {
  assert.equal(priceFor("gpt-4o-2024-08-06").id, "gpt-4o");
  assert.equal(priceFor("gpt-5-mini-2025-08-07").id, "gpt-5-mini");
  assert.equal(priceFor("openai/gpt-5").id, "gpt-5");
  // The longest matching id wins, so a mini is never priced as its parent.
  assert.equal(priceFor("gpt-4.1-mini").id, "gpt-4.1-mini");
  assert.equal(providerOf("gpt-5-nano"), "openai");
});

test("a model's explicit cached rate beats the provider default", () => {
  // GPT-4o discounts cache reads 2x; GPT-5 discounts them 10x.
  assert.equal(ratesFor(priceFor("gpt-4o")).cachedInputPerM, 1.25);
  assert.equal(ratesFor(priceFor("gpt-5")).cachedInputPerM, 0.125);
});

test("OpenAI bills nothing to write to cache", () => {
  const cost = costOf({ prompt_tokens: 1_000_000, cache_creation_input_tokens: 0 }, "gpt-5");
  assert.equal(cost.cacheWrite, 0);
  // Anthropic charges a premium for the same write; the multipliers differ
  // because the vendors differ, not because the engine branches.
  const anthropic = costOf({ cache_creation_input_tokens: 1_000_000 }, "claude-opus-5");
  assert.ok(anthropic.cacheWrite > 0);
});

/* ------------------------------------------------------------------ *
 * The accounting difference that would double-bill
 * ------------------------------------------------------------------ */

test("OpenAI's prompt_tokens includes cached tokens, and is not counted twice", () => {
  // 10k prompt tokens of which 8k were served from cache.
  const n = normalizeUsage(
    {
      prompt_tokens: 10_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 8_000 },
    },
    "gpt-5",
  );
  assert.equal(n.inputTokens, 2_000);
  assert.equal(n.cacheReadTokens, 8_000);

  const cost = costOf(
    {
      prompt_tokens: 10_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 8_000 },
    },
    "gpt-5",
  );
  // 2k at $1.25/M + 8k at $0.125/M — not 10k at full rate.
  assert.equal(cost.total.toFixed(6), (0.0025 + 0.001).toFixed(6));
});

test("Anthropic's input_tokens excludes cache reads, and is left alone", () => {
  const n = normalizeUsage(
    { input_tokens: 2_000, output_tokens: 100, cache_read_input_tokens: 8_000 },
    "claude-sonnet-5",
  );
  assert.equal(n.inputTokens, 2_000);
  assert.equal(n.cacheReadTokens, 8_000);
});

test("reasoning tokens are read from either vendor's spelling", () => {
  assert.equal(
    normalizeUsage({ completion_tokens_details: { reasoning_tokens: 512 } }, "gpt-5")
      .thinkingTokens,
    512,
  );
  assert.equal(
    normalizeUsage({ output_tokens_details: { reasoning_tokens: 512 } }, "gpt-5").thinkingTokens,
    512,
  );
});

/* ------------------------------------------------------------------ *
 * The recorder
 * ------------------------------------------------------------------ */

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-openai-"));
  process.env.OPTIMAIZR_DIR = dir;
  return dir;
}

function fakeOpenAI(response) {
  const client = {
    apiKey: "sk-test",
    chat: {
      completions: {
        async create(params) {
          return (
            response ?? {
              id: "chatcmpl_1",
              model: params.model,
              choices: [
                {
                  message: { role: "assistant", content: "hello", tool_calls: [] },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10_000,
                completion_tokens: 500,
                prompt_tokens_details: { cached_tokens: 9_000 },
              },
            }
          );
        },
      },
    },
    responses: {
      async create(params) {
        return {
          id: "resp_1",
          model: params.model,
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: {
            input_tokens: 1_000,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 0 },
          },
        };
      },
    },
  };
  return client;
}

test("wrap records an OpenAI chat call without changing the response", async () => {
  useTempStore();
  const client = wrap(fakeOpenAI(), { service: "checkout-api" });

  const res = await client.chat.completions.create({
    model: "gpt-5-mini",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ],
  });

  assert.equal(res.id, "chatcmpl_1");
  assert.equal(res.choices[0].message.content, "hello");

  await drain();
  const { events } = await readLedger({});
  assert.equal(events.length, 1);

  const e = events[0];
  assert.equal(e.provider, "openai");
  assert.equal(e.model, "gpt-5-mini");
  assert.equal(e.project, "checkout-api");
  assert.equal(e.stopReason, "stop");
  // 10k prompt tokens minus 9k served from cache.
  assert.equal(e.inputTokens, 1_000);
  assert.equal(e.cacheReadTokens, 9_000);
  assert.equal(e.outputTokens, 500);
  assert.ok(e.cost.total > 0);
  // The system message is the cacheable prefix, not the user turn.
  assert.equal(e.systemChars, "You are helpful.".length);
});

test("wrap records an OpenAI Responses call", async () => {
  useTempStore();
  const client = wrap(fakeOpenAI(), { service: "api" });

  await client.responses.create({
    model: "gpt-5",
    instructions: "Be terse.",
    input: "hello",
  });

  await drain();
  const { events } = await readLedger({});
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "gpt-5");
  assert.equal(events[0].inputTokens, 1_000);
  assert.equal(events[0].systemChars, "Be terse.".length);
});

test("wrap leaves a client it does not recognise completely alone", async () => {
  useTempStore();
  const original = {
    widgets: {
      async create() {
        return { ok: true };
      },
    },
  };
  const client = wrap(original, {});
  const res = await client.widgets.create({});
  assert.deepEqual(res, { ok: true });

  await drain();
  const { events } = await readLedger({});
  assert.equal(events.length, 0);
});

test("one wrapped process can record both vendors into one ledger", async () => {
  useTempStore();
  const openai = wrap(fakeOpenAI(), { service: "app" });
  const anthropic = wrap(
    {
      messages: {
        async create(params) {
          return {
            id: "msg_1",
            model: params.model,
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1_000, output_tokens: 100 },
          };
        },
      },
    },
    { service: "app" },
  );

  await openai.chat.completions.create({ model: "gpt-5-mini", messages: [] });
  await anthropic.messages.create({ model: "claude-sonnet-5", messages: [] });

  await drain();
  const { events } = await readLedger({});
  assert.deepEqual(events.map((e) => e.provider).sort(), ["anthropic", "openai"]);
});

/* ------------------------------------------------------------------ *
 * Reading either vendor's answer
 * ------------------------------------------------------------------ */

test("quality checks read an answer in any vendor's shape", () => {
  const anthropic = { content: [{ type: "text", text: "yes" }] };
  const chat = { choices: [{ message: { content: "yes", tool_calls: [] } }] };
  const responses = {
    output: [{ type: "message", content: [{ type: "output_text", text: "yes" }] }],
  };

  assert.equal(textOf(anthropic), "yes");
  assert.equal(textOf(chat), "yes");
  assert.equal(textOf(responses), "yes");
});

test("tool calls are compared across vendors by name", () => {
  const anthropic = { content: [{ type: "tool_use", name: "get_weather", input: {} }] };
  const chat = {
    choices: [
      { message: { tool_calls: [{ function: { name: "get_weather", arguments: "{}" } }] } },
    ],
  };
  const responses = { output: [{ type: "function_call", name: "get_weather", arguments: "{}" }] };

  assert.deepEqual(toolNamesOf(anthropic), ["get_weather"]);
  assert.deepEqual(toolNamesOf(chat), ["get_weather"]);
  assert.deepEqual(toolNamesOf(responses), ["get_weather"]);
});

/* ------------------------------------------------------------------ *
 * Replay
 * ------------------------------------------------------------------ */

test("a recorded request is replayed in the dialect it was recorded in", () => {
  assert.equal(dialectOf({ model: "claude-sonnet-5", messages: [] }), "anthropic-messages");
  assert.equal(dialectOf({ model: "gpt-5-mini", messages: [] }), "openai-chat");
  assert.equal(dialectOf({ model: "gpt-5", input: "hi" }), "openai-responses");
});

test("a model swap uses the output-limit field its dialect understands", () => {
  const candidate = {
    kind: "swap-model",
    targetFor: () => "gpt-5-nano",
    matches: () => true,
    description: "test",
  };
  const next = applyCandidate(
    { model: "gpt-5", messages: [], max_completion_tokens: 4000 },
    candidate,
  );
  assert.equal(next.model, "gpt-5-nano");
  assert.equal(next.max_completion_tokens, 4000);
  assert.equal(next.max_tokens, undefined);
});

test("a swap is clamped to the target model's output ceiling", () => {
  const candidate = {
    kind: "swap-model",
    targetFor: () => "gpt-4.1-nano",
    matches: () => true,
    description: "test",
  };
  const next = applyCandidate(
    { model: "gpt-4.1", messages: [], max_completion_tokens: 100_000 },
    candidate,
  );
  assert.equal(next.max_completion_tokens, priceFor("gpt-4.1-nano").maxOutputTokens);
});

test("lower-effort is written where each vendor looks for it", () => {
  const candidate = { kind: "lower-effort", to: "low", matches: () => true, description: "t" };
  assert.equal(
    applyCandidate({ model: "claude-opus-5", messages: [] }, candidate).output_config.effort,
    "low",
  );
  assert.equal(applyCandidate({ model: "gpt-5", messages: [] }, candidate).reasoning_effort, "low");
  assert.equal(applyCandidate({ model: "gpt-5", input: "hi" }, candidate).reasoning.effort, "low");
});

test("enable-cache leaves an OpenAI request alone — it has no such switch", () => {
  const candidate = { kind: "enable-cache", matches: () => true, description: "t" };
  const request = { model: "gpt-5-mini", messages: [{ role: "system", content: "hi" }] };
  assert.deepEqual(applyCandidate(request, candidate), request);
});

/* ------------------------------------------------------------------ *
 * The rules engine
 * ------------------------------------------------------------------ */

function mechanicalEvent(model, provider, i) {
  return {
    id: `e${i}`,
    source: "sdk",
    provider,
    ts: `2026-09-0${(i % 9) + 1}T12:00:00.000Z`,
    model,
    sessionId: "s1",
    project: "app",
    inputTokens: 50_000,
    outputTokens: 100,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    tools: [],
    cost: costOf({ input_tokens: 50_000, output_tokens: 100 }, model),
  };
}

test("mechanical calls are re-routed within their own provider, never across vendors", () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push(mechanicalEvent("claude-opus-5", "anthropic", i));
  for (let i = 20; i < 40; i++) events.push(mechanicalEvent("gpt-5", "openai", i));

  const finding = findWaste({
    events,
    window: { from: events[0].ts, to: events[events.length - 1].ts, days: 9 },
    sources: ["test"],
    warnings: [],
  }).find((f) => f.rule === "model-fit");

  assert.ok(finding, "expected a model-fit finding");

  // Each vendor's traffic goes to that vendor's cheapest fast-tier model.
  assert.equal(finding.candidate.targetFor("claude-opus-5"), "claude-haiku-4-5");
  assert.equal(finding.candidate.targetFor("gpt-5"), "gpt-5-nano");
  assert.ok(finding.savings.windowUsd > 0);
});

test("a call already on the cheapest model in its provider has nowhere to go", () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push(mechanicalEvent("gpt-4.1-nano", "openai", i));

  const finding = findWaste({
    events,
    window: { from: events[0].ts, to: events[events.length - 1].ts, days: 9 },
    sources: ["test"],
    warnings: [],
  }).find((f) => f.rule === "model-fit");

  assert.equal(finding, undefined);
});
