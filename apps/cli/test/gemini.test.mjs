import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Redirect the store before anything imports it.
 *
 * `wrap()` appends every recorded call to the ledger, so a test that wraps a
 * client without doing this writes fixture traffic into the developer's real
 * ~/.optimaizr and it shows up in their next `scan`.
 */
process.env.OPTIMAIZR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-gemini-"));

import {
  priceFor,
  ratesFor,
  costOf,
  normalizeUsage,
  findWaste,
  dialectOf,
  providerOfDialect,
  setOutputLimit,
  outputLimitOf,
  textOf,
  toolNamesOf,
} from "@optimaizr/core";
import { enableGemini } from "@optimaizr/core";
import { wrap } from "@optimaizr/local";

// Gemini ships dark; this file is about what happens once it is switched on.
// `gemini-default-off.test.mjs` covers the other half. Node runs each test
// file in its own process, so enabling here cannot leak into that one.
enableGemini();

/* ------------------------------------------------------------------ *
 * Pricing
 * ------------------------------------------------------------------ */

test("the Gemini catalogue is registered under its own provider", () => {
  for (const id of [
    "gemini-3-pro",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ]) {
    const p = priceFor(id);
    assert.ok(p, `${id} should be priced`);
    assert.equal(p.provider, "google");
  }
  // A dated model id must still resolve, as it does for the other vendors.
  assert.equal(priceFor("gemini-2.5-flash-preview-05-20")?.id, "gemini-2.5-flash");
});

test("Pro models price long context at the higher band", () => {
  const pro = priceFor("gemini-2.5-pro");
  const short = ratesFor(pro, { promptTokens: 100_000 });
  const long = ratesFor(pro, { promptTokens: 300_000 });

  assert.equal(short.inputPerM, 1.25);
  assert.equal(short.outputPerM, 10);
  assert.equal(long.inputPerM, 2.5);
  assert.equal(long.outputPerM, 15);
  // The cached rate follows whichever band applies, at the provider multiple.
  assert.equal(long.cachedInputPerM, 2.5 * 0.25);
});

test("a flat card is unaffected by prompt size", () => {
  const flash = priceFor("gemini-2.5-flash");
  assert.equal(
    ratesFor(flash, { promptTokens: 10_000 }).inputPerM,
    ratesFor(flash, { promptTokens: 900_000 }).inputPerM,
  );
});

test("omitting the prompt size uses the cheaper band, never the dearer one", () => {
  const pro = priceFor("gemini-2.5-pro");
  assert.equal(ratesFor(pro, {}).inputPerM, 1.25);
});

test("tiering does not disturb the other two vendors", () => {
  for (const id of ["claude-opus-5", "gpt-5"]) {
    const p = priceFor(id);
    assert.equal(
      ratesFor(p, { promptTokens: 10_000 }).inputPerM,
      ratesFor(p, { promptTokens: 900_000 }).inputPerM,
      `${id} must stay flat`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Token semantics
 * ------------------------------------------------------------------ */

const USAGE = {
  promptTokenCount: 300_000,
  cachedContentTokenCount: 100_000,
  candidatesTokenCount: 1_000,
  thoughtsTokenCount: 500,
  totalTokenCount: 301_500,
};

test("usageMetadata is unpacked into the shared vocabulary", () => {
  const n = normalizeUsage(USAGE, "gemini-2.5-pro");
  // promptTokenCount includes cached, so billable input is the difference.
  assert.equal(n.inputTokens, 200_000);
  assert.equal(n.cacheReadTokens, 100_000);
  // candidatesTokenCount excludes thoughts, but both bill as output.
  assert.equal(n.outputTokens, 1_500);
  assert.equal(n.thinkingTokens, 500);
  // Gemini never reports a cache write.
  assert.equal(n.cacheWrite5mTokens, 0);
  assert.equal(n.cacheWrite1hTokens, 0);
});

test("cost picks its band from the prompt that was actually sent", () => {
  // 200k input + 100k cached = 300k prompt, so the long band applies.
  const long = costOf(USAGE, "gemini-2.5-pro").total;
  const expected = (200_000 * 2.5 + 100_000 * 0.625 + 1_500 * 15) / 1_000_000;
  assert.ok(Math.abs(long - expected) < 1e-9, `got ${long}, expected ${expected}`);

  const short = costOf(
    { promptTokenCount: 100_000, candidatesTokenCount: 1_000 },
    "gemini-2.5-pro",
  ).total;
  assert.ok(Math.abs(short - (100_000 * 1.25 + 1_000 * 10) / 1_000_000) < 1e-9);
});

/* ------------------------------------------------------------------ *
 * The SDK wrapper
 * ------------------------------------------------------------------ */

const response = () => ({
  responseId: "resp-1",
  modelVersion: "gemini-2.5-pro",
  usageMetadata: { ...USAGE },
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [{ text: "done" }, { functionCall: { name: "search_docs", args: { q: "x" } } }],
      },
    },
  ],
});

test("a Google client is instrumented even though its method is not create()", async () => {
  const events = [];
  const client = wrap(
    { models: { generateContent: async () => response() } },
    { service: "svc", onEvent: (e) => events.push(e) },
  );

  await client.models.generateContent({
    model: "gemini-2.5-pro",
    contents: "hello",
    config: { systemInstruction: "be brief" },
  });

  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.model, "gemini-2.5-pro");
  assert.equal(e.provider, "google");
  assert.equal(e.inputTokens, 200_000);
  assert.equal(e.cacheReadTokens, 100_000);
  assert.equal(e.outputTokens, 1_500);
  assert.equal(e.thinkingTokens, 500);
  assert.equal(e.stopReason, "STOP");
  assert.deepEqual(
    e.tools.map((t) => t.name),
    ["search_docs"],
  );
  assert.ok(e.cost.total > 0);
  assert.ok(e.prefixHash, "the cacheable prefix is fingerprinted");
});

test("generateContentStream is recorded without a stream:true flag", async () => {
  const events = [];
  const client = wrap(
    {
      models: {
        generateContentStream: async () =>
          (async function* () {
            yield { responseId: "resp-1", candidates: [{ content: { parts: [{ text: "a" }] } }] };
            yield {
              modelVersion: "gemini-2.5-pro",
              usageMetadata: { ...USAGE },
              candidates: [{ finishReason: "STOP", content: { parts: [{ text: "b" }] } }],
            };
          })(),
      },
    },
    { onEvent: (e) => events.push(e) },
  );

  const stream = await client.models.generateContentStream({
    model: "gemini-2.5-pro",
    contents: "hi",
  });
  for await (const _ of stream) {
    /* drain */
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].outputTokens, 1_500, "final usage is taken from the last chunk");
  assert.equal(events[0].stopReason, "STOP");
});

test("a client with no recognised surface is returned untouched", async () => {
  const events = [];
  const client = wrap(
    { somethingElse: { run: async () => ({}) } },
    { onEvent: (e) => events.push(e) },
  );
  await client.somethingElse.run({});
  assert.equal(events.length, 0);
});

/* ------------------------------------------------------------------ *
 * Verify: dialect and quality checks
 * ------------------------------------------------------------------ */

test("a Gemini request is never mistaken for an Anthropic one", () => {
  const d = dialectOf({ model: "gemini-2.5-pro", contents: "x" });
  assert.equal(d, "google-generate-content");
  assert.equal(providerOfDialect(d), "google");
  // The other two are unchanged.
  assert.equal(dialectOf({ model: "claude-opus-5" }), "anthropic-messages");
  assert.equal(dialectOf({ model: "gpt-5" }), "openai-chat");
});

test("the output ceiling is written where Gemini reads it", () => {
  const request = { model: "gemini-2.5-flash", contents: "x", max_tokens: 99 };
  setOutputLimit(request, "google-generate-content", 1024);

  assert.equal(request.config.maxOutputTokens, 1024);
  // The other dialects' spellings are dropped so exactly one survives.
  assert.equal(request.max_tokens, undefined);
  assert.equal(outputLimitOf(request), 1024);
});

test("the ceiling is capped at the model's real maximum", () => {
  const request = { model: "gemini-2.5-flash", contents: "x" };
  setOutputLimit(request, "google-generate-content", 10_000_000);
  assert.equal(request.config.maxOutputTokens, priceFor("gemini-2.5-flash").maxOutputTokens);
});

test("quality checks can read a Gemini response", () => {
  const r = response();
  assert.equal(textOf(r), "done");
  assert.deepEqual(toolNamesOf(r), ["search_docs"]);
  // And the answer fragment the recorder stores, not just the whole envelope.
  assert.equal(textOf(r.candidates[0].content), "done");
  assert.deepEqual(toolNamesOf(r.candidates[0].content), ["search_docs"]);
});

test("the other vendors' response shapes still read correctly", () => {
  assert.equal(textOf([{ type: "text", text: "anthropic" }]), "anthropic");
  assert.equal(textOf({ choices: [{ message: { content: "openai" } }] }), "openai");
  assert.equal(textOf({ output: [{ type: "output_text", text: "responses" }] }), "responses");
});

/* ------------------------------------------------------------------ *
 * The analysis engine, unchanged
 * ------------------------------------------------------------------ */

function geminiEvent(i) {
  const usage = { promptTokenCount: 50_000, candidatesTokenCount: 200, thoughtsTokenCount: 0 };
  return {
    id: `g${i}`,
    source: "sdk",
    provider: "google",
    ts: `2026-09-19T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
    model: "gemini-3-pro",
    sessionId: "s",
    project: "app",
    inputTokens: 50_000,
    outputTokens: 200,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    tools: [{ id: `t${i}`, name: "search", signature: "search:x" }],
    cost: costOf(usage, "gemini-3-pro", { at: `2026-09-19T10:00:00.000Z` }),
  };
}

test("model-fit works for Gemini with no change to the rules", () => {
  const events = Array.from({ length: 30 }, (_, i) => geminiEvent(i));
  const findings = findWaste({
    events,
    window: { from: events[0].ts, to: events.at(-1).ts, days: 1 },
    sources: [],
    warnings: [],
  });

  const fit = findings.find((f) => f.rule === "model-fit");
  assert.ok(fit, "mechanical Gemini traffic should trigger model-fit");
  // The downgrade target must stay inside the provider.
  assert.equal(priceFor(fit.candidate.to).provider, "google");
  assert.ok(fit.savings.windowUsd > 0);
});
