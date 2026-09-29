import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OPTIMAIZR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-gemini-off-"));

import {
  priceFor,
  providerOf,
  listProviders,
  geminiEnabled,
  enableGemini,
  GEMINI_MODELS,
} from "@optimaizr/core";
import { wrap } from "@optimaizr/local";

/*
 * Gemini is implemented but its rate cards are unverified, so it must stay off
 * until someone asks for it. These tests are the guard on that: they run in
 * their own process, before anything calls `enableGemini()`.
 */

test("Gemini is not registered on import", () => {
  assert.equal(geminiEnabled(), false);
  assert.equal(priceFor("gemini-2.5-pro"), null);
  assert.equal(priceFor("gemini-3-pro"), null);
  assert.equal(providerOf("gemini-2.5-flash"), "unknown");
  assert.ok(!listProviders().some((p) => p.id === "google"));
});

test("the catalogue still exists, it is just not loaded", () => {
  assert.equal(GEMINI_MODELS.length, 4);
  assert.ok(GEMINI_MODELS.every((m) => m.provider === "google"));
});

test("a Google client is left completely alone while it is off", async () => {
  const events = [];
  const client = wrap(
    {
      models: {
        generateContent: async () => ({
          responseId: "r",
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10 },
          candidates: [{ content: { parts: [{ text: "hi" }] } }],
        }),
      },
    },
    { onEvent: (e) => events.push(e) },
  );

  const res = await client.models.generateContent({ model: "gemini-2.5-flash", contents: "x" });

  // Recording a $0 call against an unknown provider would be worse than not
  // recording it: it would put untrustworthy rows in the user's ledger.
  assert.equal(events.length, 0);
  assert.equal(res.responseId, "r", "the call itself must still work normally");
});

test("enabling it turns on the catalogue, the provider and the wrapper together", async () => {
  enableGemini();

  assert.equal(geminiEnabled(), true);
  assert.equal(priceFor("gemini-2.5-pro")?.provider, "google");
  assert.ok(listProviders().some((p) => p.id === "google"));

  const events = [];
  const client = wrap(
    {
      models: {
        generateContent: async () => ({
          responseId: "r",
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10 },
          candidates: [{ content: { parts: [{ text: "hi" }] } }],
        }),
      },
    },
    { onEvent: (e) => events.push(e) },
  );
  await client.models.generateContent({ model: "gemini-2.5-flash", contents: "x" });

  assert.equal(events.length, 1, "one switch enables recording too");
  assert.equal(events[0].provider, "google");
  assert.ok(events[0].cost.total > 0);
});

test("enabling twice is harmless", () => {
  enableGemini();
  enableGemini();
  assert.equal(listProviders().filter((p) => p.id === "google").length, 1);
});
