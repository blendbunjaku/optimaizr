import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCheck, judgePair, costOf } from "@optimaizr/core";
import { applyCandidate, verifyCandidate } from "@optimaizr/local";

const textBlock = (t) => [{ type: "text", text: t }];

test("deterministic checks judge content, not vibes", () => {
  assert.equal(runCheck({ type: "json-parses" }, textBlock('{"a":1}'), null), true);
  assert.equal(runCheck({ type: "json-parses" }, textBlock("nope"), null), false);
  // Fenced JSON is still JSON.
  assert.equal(runCheck({ type: "json-parses" }, textBlock('```json\n{"a":1}\n```'), null), true);

  assert.equal(runCheck({ type: "contains", value: "total" }, textBlock("the total"), null), true);
  assert.equal(runCheck({ type: "max-chars", value: 5 }, textBlock("abcdef"), null), false);
  assert.equal(runCheck({ type: "min-chars", value: 5 }, textBlock("abcdef"), null), true);
  assert.equal(runCheck({ type: "matches", pattern: "^\\d+$" }, textBlock("12345"), null), true);
});

test("a refusal fails the no-refusal check", () => {
  assert.equal(runCheck({ type: "no-refusal" }, textBlock("Sure, here it is."), null), true);
  assert.equal(runCheck({ type: "no-refusal" }, textBlock("I can't help with that."), null), false);
});

test("tool-name-matches compares against the baseline's tool calls", () => {
  const baseline = [{ type: "tool_use", name: "get_weather", input: {} }];
  const same = [{ type: "tool_use", name: "get_weather", input: { city: "Oslo" } }];
  const different = [{ type: "tool_use", name: "get_time", input: {} }];

  assert.equal(runCheck({ type: "tool-name-matches" }, same, baseline), true);
  assert.equal(runCheck({ type: "tool-name-matches" }, different, baseline), false);
});

/** A judge that always names whichever response is in position A. */
function positionBiasedJudge() {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: "A" }] }),
    },
  };
}

/** A judge that consistently prefers the text containing "better". */
function honestJudge() {
  return {
    messages: {
      create: async ({ messages }) => {
        const prompt = messages[0].content;
        const aStart = prompt.indexOf("--- RESPONSE A ---");
        const bStart = prompt.indexOf("--- RESPONSE B ---");
        const a = prompt.slice(aStart, bStart);
        const b = prompt.slice(bStart);
        const pick = a.includes("better") ? "A" : b.includes("better") ? "B" : "TIE";
        return { content: [{ type: "text", text: pick }] };
      },
    },
  };
}

test("position bias is neutralised into a tie, not a win", async () => {
  // This judge always says "A", so swapping positions must cancel it out.
  const { verdict } = await judgePair(
    positionBiasedJudge(),
    { model: "m", criteria: "c" },
    "prompt",
    "baseline answer",
    "candidate answer",
  );
  assert.equal(verdict, "tie", "a judge that always picks position A must not produce a winner");
});

test("a consistent preference survives the swap", async () => {
  const judge = honestJudge();
  assert.equal(
    (await judgePair(judge, { model: "m", criteria: "c" }, "p", "worse answer", "a better answer"))
      .verdict,
    "candidate",
  );
  assert.equal(
    (await judgePair(judge, { model: "m", criteria: "c" }, "p", "a better answer", "worse answer"))
      .verdict,
    "baseline",
  );
});

/** A judge that reports usage, so its calls can be priced like any other. */
function pricedJudge(usage) {
  return {
    messages: {
      create: async () => ({
        model: "claude-opus-5",
        content: [{ type: "text", text: "TIE" }],
        usage,
      }),
    },
  };
}

test("judge cost is priced from reported usage, not a flat assumption", async () => {
  const usage = { input_tokens: 1000, output_tokens: 10 };
  const { cost } = await judgePair(
    pricedJudge(usage),
    { model: "claude-opus-5", criteria: "c" },
    "p",
    "baseline",
    "candidate",
  );

  // Both orderings are judged, so both calls are priced.
  assert.equal(cost.priced, 2, "both judge calls were priced");
  assert.equal(cost.unpriced, 0, "nothing was left unpriced");

  // The figure must equal the catalogue's own answer for that usage, twice
  // over - not a per-call constant that happens to be in the right region.
  const expected = costOf(usage, "claude-opus-5").total * 2;
  assert.ok(expected > 0, "the fixture usage prices to something");
  assert.equal(cost.usd, expected, "judge cost is costOf() applied to real usage");
});

test("an unpriceable judge call is reported, never counted as free", async () => {
  const { cost } = await judgePair(
    pricedJudge(undefined),
    { model: "claude-opus-5", criteria: "c" },
    "p",
    "baseline",
    "candidate",
  );

  assert.equal(cost.usd, 0, "no usage means no measured cost");
  assert.equal(cost.priced, 0);
  assert.equal(cost.unpriced, 2, "both calls are flagged as unknown, not as $0");
});

test("judge cost scales with the traffic it judged", async () => {
  const small = await judgePair(
    pricedJudge({ input_tokens: 100, output_tokens: 5 }),
    { model: "claude-opus-5", criteria: "c" },
    "p",
    "b",
    "c",
  );
  const large = await judgePair(
    pricedJudge({ input_tokens: 100_000, output_tokens: 5 }),
    { model: "claude-opus-5", criteria: "c" },
    "p",
    "b",
    "c",
  );
  // The flat estimate this replaced returned the same number for both.
  assert.ok(large.cost.usd > small.cost.usd * 10, "a bigger judge call costs measurably more");
});

test("applyCandidate rewrites the request for each kind of change", () => {
  const swapped = applyCandidate(
    { model: "claude-opus-5", max_tokens: 100_000, messages: [] },
    { kind: "swap-model", to: "claude-haiku-4-5" },
  );
  assert.equal(swapped.model, "claude-haiku-4-5");
  // Clamped to the target's output ceiling.
  assert.equal(swapped.max_tokens, 64_000);

  const effort = applyCandidate({ model: "m" }, { kind: "lower-effort", to: "low" });
  assert.equal(effort.output_config.effort, "low");

  const cached = applyCandidate(
    { model: "m", system: "a stable prompt" },
    { kind: "enable-cache" },
  );
  assert.deepEqual(cached.system[0].cache_control, { type: "ephemeral" });

  const cachedTools = applyCandidate(
    { model: "m", tools: [{ name: "a" }, { name: "b" }] },
    { kind: "enable-cache" },
  );
  assert.deepEqual(cachedTools.tools[1].cache_control, { type: "ephemeral" });
  assert.equal(cachedTools.tools[0].cache_control, undefined);
});

test("applyCandidate does not mutate the recorded request", () => {
  const original = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] };
  applyCandidate(original, { kind: "swap-model", to: "claude-haiku-4-5" });
  assert.equal(original.model, "claude-opus-5");
});

/** Point the ledger and sample store at a scratch directory. */
function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-verify-"));
  process.env.OPTIMAIZR_DIR = dir;
  return dir;
}

function writeSamples(dir, n, baselineText) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(
      JSON.stringify({
        id: `s${i}`,
        ts: "2026-09-01T10:00:00.000Z",
        route: "summarise",
        model: "claude-opus-5",
        request: {
          model: "claude-opus-5",
          messages: [{ role: "user", content: `summarise ticket ${i}` }],
          max_tokens: 512,
        },
        response: {
          content: [{ type: "text", text: baselineText }],
          usage: { input_tokens: 2000, output_tokens: 200 },
        },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, "samples.jsonl"), lines.join("\n") + "\n");
}

test("a candidate that degrades quality is rejected despite being cheaper", async () => {
  const dir = useTempStore();
  writeSamples(dir, 12, "a complete and accurate summary");

  // The cheap candidate refuses - much cheaper, clearly worse.
  const client = {
    messages: {
      create: async ({ model }) => {
        if (model === "claude-haiku-4-5") {
          return {
            model,
            content: [{ type: "text", text: "I can't help with that." }],
            usage: { input_tokens: 2000, output_tokens: 10 },
          };
        }
        return { content: [{ type: "text", text: "A" }] }; // judge call
      },
    },
  };

  const result = await verifyCandidate({
    client,
    candidate: { kind: "swap-model", to: "claude-haiku-4-5", description: "swap to Haiku" },
    bar: { checks: [{ type: "no-refusal" }], sampleSize: 12 },
    monthlyCalls: 1000,
  });

  assert.equal(result.verdict, "FAIL");
  assert.ok(result.savingPerCall > 0, "the change really was cheaper");
  assert.ok(
    result.reasons.some((r) => r.includes("no-refusal")),
    "the failure must name the check that regressed",
  );
});

test("a candidate that holds quality and cuts cost passes", async () => {
  const dir = useTempStore();
  writeSamples(dir, 12, "a complete and accurate summary");

  const client = {
    messages: {
      create: async ({ model }) => {
        if (model === "claude-haiku-4-5") {
          return {
            model,
            content: [{ type: "text", text: "a complete and accurate summary" }],
            usage: { input_tokens: 2000, output_tokens: 200 },
          };
        }
        return { content: [{ type: "text", text: "TIE" }] };
      },
    },
  };

  const result = await verifyCandidate({
    client,
    candidate: { kind: "swap-model", to: "claude-haiku-4-5", description: "swap to Haiku" },
    bar: {
      checks: [{ type: "no-refusal" }],
      judge: { model: "claude-opus-5", criteria: "accuracy", minWinRate: 0.45 },
      sampleSize: 12,
    },
    monthlyCalls: 1000,
  });

  assert.equal(result.verdict, "PASS");
  assert.ok(result.monthlySaving > 0);
  assert.equal(result.judge.winRate, 0.5, "all ties is parity");
});

test("too few samples is inconclusive rather than a pass", async () => {
  const dir = useTempStore();
  writeSamples(dir, 3, "fine");

  const client = {
    messages: {
      create: async () => ({
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "fine" }],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    },
  };

  const result = await verifyCandidate({
    client,
    candidate: { kind: "swap-model", to: "claude-haiku-4-5", description: "swap" },
    bar: { checks: [], sampleSize: 40 },
    monthlyCalls: 100,
  });

  assert.equal(result.verdict, "INCONCLUSIVE");
});

test("with no captured traffic, verify refuses to guess", async () => {
  useTempStore();
  const result = await verifyCandidate({
    client: {},
    candidate: { kind: "swap-model", to: "claude-haiku-4-5", description: "swap" },
    bar: { checks: [] },
  });
  assert.equal(result.verdict, "INCONCLUSIVE");
  assert.equal(result.samples, 0);
  assert.ok(result.reasons[0].includes("No captured samples"));
});
