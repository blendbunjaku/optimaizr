import { test } from "node:test";
import assert from "node:assert/strict";

import {
  costOf,
  priceFor,
  ratesFor,
  registerModels,
  resetModels,
  CACHE_MULTIPLIER,
  addCost,
  emptyCost,
} from "@optimaizr/core";

test("prices a plain call at list rates", () => {
  // Opus 5: $5/M in, $25/M out.
  const cost = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(cost.input, 5);
  assert.equal(cost.output, 25);
  assert.equal(cost.total, 30);
});

test("cache reads bill at a tenth of the input rate", () => {
  const cost = costOf({ cache_read_input_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(cost.cacheRead, 5 * CACHE_MULTIPLIER.read);
  assert.equal(cost.total, 0.5);
});

test("cache writes bill by TTL, and the 1h bucket is not double-counted", () => {
  const cost = costOf(
    {
      cache_creation_input_tokens: 1_000_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 400_000,
        ephemeral_1h_input_tokens: 600_000,
      },
    },
    "claude-opus-5",
  );
  // 400k at 1.25x + 600k at 2.0x, on a $5/M base.
  assert.equal(cost.cacheWrite, 0.4 * 5 * 1.25 + 0.6 * 5 * 2.0);
});

test("an aggregate cache-write count falls back to the cheaper 5m rate", () => {
  const cost = costOf({ cache_creation_input_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(cost.cacheWrite, 5 * CACHE_MULTIPLIER.write5m);
});

/**
 * Regression: Sonnet 5 stays at $2/$10 across the 2026-09-01 boundary.
 *
 * The $2/$10 launch price was announced as introductory pricing through
 * 2026-08-31, with a rise to $3/$15 scheduled for 2026-09-01. Anthropic
 * cancelled that rise and made $2/$10 standard. The catalogue had the
 * announced-but-cancelled increase encoded, which over-billed every Sonnet 5
 * call from September onwards by exactly 1.5x, across input, output *and*
 * the cache rates that derive from the input rate.
 */
test("Sonnet 5 stays at $2/$10 across the cancelled September 2026 increase", () => {
  for (const at of [
    "2026-02-05T00:00:00Z",
    "2026-08-31T23:59:00Z",
    "2026-09-01T00:00:01Z",
    "2026-12-31T00:00:00Z",
    "2027-06-01T00:00:00Z",
  ]) {
    const r = ratesFor(priceFor("claude-sonnet-5"), { at });
    assert.equal(r.inputPerM, 2, `input rate changed at ${at}`);
    assert.equal(r.outputPerM, 10, `output rate changed at ${at}`);
    // The cache rates hang off the input rate, so a bad card inflates them too.
    assert.equal(r.cachedInputPerM, 0.2, `cache read rate changed at ${at}`);
    assert.equal(r.cacheWrite5mPerM, 2.5, `5m write rate changed at ${at}`);
    assert.equal(r.cacheWrite1hPerM, 4, `1h write rate changed at ${at}`);
  }
});

test("catalogue rates match Anthropic's published list prices", () => {
  const published = {
    "claude-opus-5": [5, 25],
    "claude-sonnet-5": [2, 10],
    "claude-haiku-4-5": [1, 5],
    "claude-fable-5": [10, 50],
    "claude-opus-5-5": [4, 20],
    "claude-fable-5-1": [10, 50],
    "claude-mythos-5-1": [10, 50],
  };
  for (const [id, [input, output]] of Object.entries(published)) {
    const r = ratesFor(priceFor(id), { at: "2026-09-14T12:00:00Z" });
    assert.equal(r.inputPerM, input, `${id} input rate`);
    assert.equal(r.outputPerM, output, `${id} output rate`);
  }
});

/**
 * Regression: the new ids share a prefix with their predecessors.
 *
 * Before they were catalogued, `claude-opus-5-5` prefix-matched Opus 5 and
 * billed at $5/$25 instead of $4/$20; `claude-fable-5-1` matched Fable 5 and
 * billed cache reads at $1.00 instead of $0.25.
 */
test("Opus 5.5 and Fable 5.1 resolve to their own cards, not their predecessors'", () => {
  assert.equal(priceFor("claude-opus-5-5").id, "claude-opus-5-5");
  assert.equal(priceFor("claude-fable-5-1").id, "claude-fable-5-1");
  assert.equal(priceFor("us.anthropic.claude-opus-5-5").id, "claude-opus-5-5");
  assert.equal(priceFor("claude-opus-5").id, "claude-opus-5");
  assert.equal(priceFor("claude-fable-5").id, "claude-fable-5");
});

test("Opus 5.5 and Fable 5.1 bill cache reads at their published rates", () => {
  const opus = costOf({ cache_read_input_tokens: 1_000_000 }, "claude-opus-5-5");
  assert.equal(opus.cacheRead, 0.2);
  const fable = costOf({ cache_read_input_tokens: 1_000_000 }, "claude-fable-5-1");
  assert.equal(fable.cacheRead, 0.25);
  // Writes keep Anthropic's multipliers on the input rate.
  const writes = costOf({ cache_creation_input_tokens: 1_000_000 }, "claude-opus-5-5");
  assert.equal(writes.cacheWrite, 4 * CACHE_MULTIPLIER.write5m);
});

test("Opus 5.5 fast mode doubles every rate, including its explicit cache rate", () => {
  const r = ratesFor(priceFor("claude-opus-5-5"), { speed: "fast" });
  assert.equal(r.inputPerM, 8);
  assert.equal(r.outputPerM, 40);
  assert.equal(r.cachedInputPerM, 0.4);
  assert.equal(r.cacheWrite5mPerM, 10);
});

test("GPT-6 Astra: cache writes come out of input and bill at 1.25x", () => {
  // Responses usage: input_tokens includes both the cached and written tokens.
  const cost = costOf(
    {
      input_tokens: 200_000,
      output_tokens: 10_000,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 40_000 },
    },
    "gpt-6-astra",
  );
  assert.equal(cost.input, (60_000 * 10) / 1e6);
  assert.equal(cost.cacheRead, (100_000 * 1) / 1e6);
  assert.equal(cost.cacheWrite, (40_000 * 12.5) / 1e6);
  assert.equal(cost.output, (10_000 * 50) / 1e6);
});

test("GPT-6 Astra: past 272K input the whole request moves to the long-context band", () => {
  const usage = {
    input_tokens: 300_000,
    output_tokens: 1_000,
    input_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 50_000 },
  };
  const cost = costOf(usage, "gpt-6-astra");
  assert.equal(cost.input, (50_000 * 20) / 1e6);
  assert.equal(cost.cacheRead, (200_000 * 2) / 1e6);
  assert.equal(cost.cacheWrite, (50_000 * 25) / 1e6);
  assert.equal(cost.output, (1_000 * 75) / 1e6);

  // Cache writes count toward the threshold: 250K fresh + 30K written is over it.
  const edge = costOf(
    { input_tokens: 280_000, input_tokens_details: { cache_write_tokens: 30_000 } },
    "gpt-6-astra",
  );
  assert.equal(edge.input, (250_000 * 20) / 1e6);
});

test("an OpenAI model without a write charge bills written tokens as plain input", () => {
  // GPT-5 predates cache-write billing: splitting writes out must not change the total.
  const plain = costOf({ input_tokens: 100_000 }, "gpt-5");
  const split = costOf(
    { input_tokens: 100_000, input_tokens_details: { cache_write_tokens: 40_000 } },
    "gpt-5",
  );
  assert.equal(split.total, plain.total);
});

/**
 * Regression: GPT-5.x ids prefix-match `gpt-5`.
 *
 * Before they were catalogued, `gpt-5.5` and `gpt-5.4-mini` resolved to GPT-5
 * and billed at $1.25/$10 — a quarter of GPT-5.5's price — and `gpt-6-sol`
 * resolved to nothing at all.
 */
test("GPT-5.x and GPT-6 ids resolve to their own cards", () => {
  const published = {
    "gpt-6-sol": [2, 10],
    "gpt-6-luna": [0.1, 0.5],
    "gpt-5.6-sol": [4, 20],
    "gpt-5.6-terra": [2, 12],
    "gpt-5.6-luna": [0.2, 1.2],
    "gpt-5.5": [5, 30],
    "gpt-5.5-2026-04-23": [5, 30],
    "gpt-5.5-pro": [30, 180],
    "gpt-5.4": [2.5, 15],
    "gpt-5.4-mini": [0.75, 4.5],
    "gpt-5.4-nano": [0.2, 1.25],
    "gpt-5.2": [1.75, 14],
    "gpt-5.1": [1.25, 10],
    "gpt-5": [1.25, 10],
    "gpt-5-mini": [0.25, 2],
  };
  for (const [id, [input, output]] of Object.entries(published)) {
    const r = ratesFor(priceFor(id));
    assert.equal(r.inputPerM, input, `${id} input rate`);
    assert.equal(r.outputPerM, output, `${id} output rate`);
  }
});

test("GPT-5.5 has a long-context band but no cache-write charge", () => {
  const long = ratesFor(priceFor("gpt-5.5"), { promptTokens: 300_000 });
  assert.equal(long.inputPerM, 10);
  assert.equal(long.cachedInputPerM, 1);
  assert.equal(long.outputPerM, 45);
  // Writes bill as plain input: OpenAI's charge starts at GPT-5.6.
  assert.equal(long.cacheWrite5mPerM, 10);
  const terra = ratesFor(priceFor("gpt-5.6-terra"));
  assert.equal(terra.cacheWrite5mPerM, 2.5);
});

test("a dated rate card still switches on its effective date", () => {
  // The cancelled Sonnet increase removed the last multi-card model from the
  // catalogue, so the mechanism is covered with a registered one instead.
  registerModels([
    {
      id: "test-dated-model",
      label: "Dated",
      provider: "anthropic",
      tier: "balanced",
      rates: [
        { from: "2026-01-01", until: "2026-06-30", inputPerM: 1, outputPerM: 4 },
        { from: "2026-07-01", inputPerM: 2, outputPerM: 8 },
      ],
      contextTokens: 200_000,
      maxOutputTokens: 8_192,
      capabilities: ["tools"],
      bestFor: "test fixture",
    },
  ]);
  try {
    const before = ratesFor(priceFor("test-dated-model"), { at: "2026-06-30T23:59:59Z" });
    assert.equal(before.inputPerM, 1);
    const after = ratesFor(priceFor("test-dated-model"), { at: "2026-07-01T00:00:01Z" });
    assert.equal(after.inputPerM, 2);
  } finally {
    resetModels();
  }
});

test("fast mode and batch pricing adjust the rate", () => {
  const fast = ratesFor(priceFor("claude-opus-5"), { speed: "fast" });
  assert.equal(fast.inputPerM, 10);

  const batch = ratesFor(priceFor("claude-opus-5"), { batch: true });
  assert.equal(batch.inputPerM, 2.5);
});

test("resolves date-suffixed and platform-prefixed model ids", () => {
  assert.equal(priceFor("claude-haiku-4-5-20251001").id, "claude-haiku-4-5");
  assert.equal(priceFor("us.anthropic.claude-opus-5").id, "claude-opus-5");
  assert.equal(priceFor("anthropic.claude-sonnet-5").id, "claude-sonnet-5");
});

test("an unknown model costs zero and is flagged rather than guessed", () => {
  const cost = costOf({ input_tokens: 1000 }, "some-other-vendor-model");
  assert.equal(cost.total, 0);
  assert.equal(cost.unpriced, true);
});

/**
 * Server-side tools are billed per request, not per token.
 *
 * A report built only from input/output/cache token counts silently omits
 * these: nothing in the token numbers moves when a search runs, so the
 * omission is invisible rather than merely wrong.
 */
test("web searches bill at $10 per 1,000 on top of tokens", () => {
  const cost = costOf(
    { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 1000 } },
    "claude-opus-5",
  );
  assert.equal(cost.serverTools, 10);
  assert.equal(cost.total, 10);
});

test("web search cost adds to token cost rather than replacing it", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    server_tool_use: { web_search_requests: 5 },
  };
  const cost = costOf(usage, "claude-opus-5");
  assert.equal(cost.input, 5);
  assert.equal(cost.output, 25);
  assert.equal(cost.serverTools, 0.05); // 5 / 1000 * $10
  assert.equal(cost.total, 30.05);
});

test("web fetch is free, and absent server_tool_use costs nothing", () => {
  const fetched = costOf(
    { output_tokens: 0, server_tool_use: { web_fetch_requests: 250, web_search_requests: 0 } },
    "claude-opus-5",
  );
  assert.equal(fetched.serverTools, 0);
  assert.equal(costOf({ output_tokens: 100 }, "claude-opus-5").serverTools, 0);
});

test("per-request tool charges are not discounted by batch or raised by fast mode", () => {
  const usage = { server_tool_use: { web_search_requests: 1000 } };
  assert.equal(costOf(usage, "claude-opus-5", { batch: true }).serverTools, 10);
  assert.equal(costOf(usage, "claude-opus-5", { speed: "fast" }).serverTools, 10);
});

test("summed costs carry the server-tool component", () => {
  const a = costOf({ server_tool_use: { web_search_requests: 100 } }, "claude-opus-5");
  const b = costOf({ server_tool_use: { web_search_requests: 400 } }, "claude-opus-5");
  const sum = addCost(a, b);
  assert.equal(sum.serverTools, 5);
  assert.equal(sum.total, 5);
  assert.equal(emptyCost().serverTools, 0);
});
