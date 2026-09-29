import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  priceFor,
  ratesFor,
  cardFor,
  costOf,
  registerModels,
  resetModels,
  providerOf,
  allModels,
} from "@optimaizr/core";
import { importUsageFile, parseCsv } from "@optimaizr/core";

/**
 * Dated rate cards are exercised against a registered fixture, not a shipped
 * model.
 *
 * These tests used to assert Sonnet 5's announced rise to $3/$15 on
 * 2026-09-01. Anthropic cancelled that rise, so the assertions were pinning a
 * price that never took effect and the catalogue was over-billing every
 * September Sonnet call by 1.5x to satisfy them. A fixture keeps the
 * mechanism covered without coupling it to what a real model charges.
 */
function withPromoModel(fn) {
  registerModels([
    {
      id: "test-promo-model",
      label: "Promo",
      provider: "anthropic",
      tier: "balanced",
      rates: [
        {
          from: "2026-02-05",
          until: "2026-08-31",
          inputPerM: 2,
          outputPerM: 10,
          label: "introductory pricing",
        },
        { from: "2026-09-01", inputPerM: 3, outputPerM: 15 },
      ],
      contextTokens: 200_000,
      maxOutputTokens: 8_192,
      capabilities: ["tools"],
      bestFor: "test fixture",
    },
  ]);
  try {
    fn();
  } finally {
    resetModels();
  }
}

test("a call is priced at the rate in force on the day it was made", () => {
  withPromoModel(() => {
    const m = priceFor("test-promo-model");

    const august = ratesFor(m, { at: "2026-08-15T12:00:00Z" });
    assert.equal(august.inputPerM, 2);
    assert.equal(august.card.label, "introductory pricing");

    const september = ratesFor(m, { at: "2026-09-15T12:00:00Z" });
    assert.equal(september.inputPerM, 3);
    assert.equal(september.card.label, undefined);
  });
});

test("the promotional card covers the whole of its final day", () => {
  withPromoModel(() => {
    const m = priceFor("test-promo-model");
    assert.equal(cardFor(m, "2026-08-31T23:59:59Z").inputPerM, 2);
    assert.equal(cardFor(m, "2026-09-01T00:00:01Z").inputPerM, 3);
  });
});

test("the same usage costs different amounts either side of a rate change", () => {
  withPromoModel(() => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const before = costOf(usage, "test-promo-model", { at: "2026-08-01T00:00:00Z" });
    const after = costOf(usage, "test-promo-model", { at: "2026-09-02T00:00:00Z" });

    assert.equal(before.total, 12); // $2 + $10
    assert.equal(after.total, 18); // $3 + $15
  });
});

test("Sonnet 5 itself has no September 2026 rate change", () => {
  const sonnet = priceFor("claude-sonnet-5");
  assert.equal(cardFor(sonnet, "2026-08-31T23:59:59Z").inputPerM, 2);
  assert.equal(cardFor(sonnet, "2026-09-01T00:00:01Z").inputPerM, 2);
});

test("Sonnet 5.5 is its own model, not a dated Sonnet 5", () => {
  const sonnet = priceFor("claude-sonnet-5-5");
  assert.equal(sonnet.label, "Sonnet 5.5");
  const r = ratesFor(sonnet, { at: "2026-09-29T12:00:00Z" });
  assert.deepEqual([r.inputPerM, r.outputPerM, r.cachedInputPerM], [2, 10, 0.2]);
  // Prefix matching must still prefer the longer id.
  assert.equal(priceFor("claude-sonnet-5-5-20260925").label, "Sonnet 5.5");
  assert.equal(priceFor("claude-sonnet-5-20260205").label, "Sonnet 5");
});

test("a call before any known card falls back to the current rate", () => {
  const haiku = priceFor("claude-haiku-4-5");
  assert.equal(ratesFor(haiku, { at: "2020-01-01T00:00:00Z" }).inputPerM, 1);
});

test("a new provider can be added without touching the engine", (t) => {
  t.after(resetModels);

  registerModels([
    {
      id: "acme-turbo-1",
      label: "Turbo 1",
      provider: "acme",
      tier: "fast",
      rates: [{ from: "2026-01-01", inputPerM: 0.5, outputPerM: 1.5 }],
      contextTokens: 128_000,
      maxOutputTokens: 8_000,
      capabilities: ["tools"],
      bestFor: "Cheap bulk work.",
    },
  ]);

  assert.equal(providerOf("acme-turbo-1"), "acme");
  const cost = costOf({ input_tokens: 2_000_000, output_tokens: 1_000_000 }, "acme-turbo-1");
  assert.equal(cost.total, 2 * 0.5 + 1.5);
  // Falls back to the default cache policy when the provider defines none.
  const cached = costOf({ cache_read_input_tokens: 1_000_000 }, "acme-turbo-1");
  assert.equal(cached.cacheRead, 0.05);
});

test("registering a model with an existing id replaces its prices", (t) => {
  t.after(resetModels);
  const before = allModels().length;

  registerModels([
    {
      ...priceFor("claude-haiku-4-5"),
      rates: [{ from: "2026-01-01", inputPerM: 9, outputPerM: 9 }],
    },
  ]);

  assert.equal(allModels().length, before, "replacing must not duplicate the entry");
  assert.equal(ratesFor(priceFor("claude-haiku-4-5"), {}).inputPerM, 9);
});

test("an explicit cached-input rate overrides the provider multiplier", (t) => {
  t.after(resetModels);
  registerModels([
    {
      id: "acme-cached",
      label: "Cached",
      provider: "acme",
      tier: "fast",
      rates: [{ from: "2026-01-01", inputPerM: 4, outputPerM: 8, cachedInputPerM: 2 }],
      contextTokens: 100_000,
      maxOutputTokens: 4_000,
      capabilities: ["caching"],
      bestFor: "test",
    },
  ]);
  // Half the input rate, not the default tenth.
  assert.equal(costOf({ cache_read_input_tokens: 1_000_000 }, "acme-cached").cacheRead, 2);
});

/* ---- import ---- */

test("CSV parsing handles quotes, escapes and embedded commas", () => {
  const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n');
  assert.deepEqual(rows, [{ a: "x,1", b: 'he said "hi"' }]);
});

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-import-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test("imports a CSV export and prices it", () => {
  const file = tmpFile(
    "usage.csv",
    [
      "timestamp,model,prompt_tokens,completion_tokens,route",
      "2026-09-01T10:00:00Z,claude-sonnet-5,1000000,1000000,summarise",
      "2026-09-01T11:00:00Z,claude-haiku-4-5,1000000,0,classify",
    ].join("\n"),
  );

  const { events, skipped } = importUsageFile(file, { service: "billing-export" });

  assert.equal(skipped, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].model, "claude-sonnet-5");
  assert.equal(events[0].provider, "anthropic");
  assert.equal(events[0].route, "summarise");
  assert.equal(events[0].project, "billing-export");
  // Sonnet 5 is $2 + $10 per million, in September as in August.
  assert.equal(events[0].cost.total, 12);
  assert.equal(events[1].cost.total, 1);
});

test("column aliases from different providers all map", () => {
  const file = tmpFile(
    "alt.csv",
    ["date,engine,input,output", "2026-09-01,claude-haiku-4-5,2000000,1000000"].join("\n"),
  );
  const { events } = importUsageFile(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 2_000_000);
  assert.equal(events[0].cost.total, 2 * 1 + 1 * 5);
});

test("a stated cost in the export beats our computed one", () => {
  const file = tmpFile(
    "stated.json",
    JSON.stringify([
      {
        timestamp: "2026-09-01T10:00:00Z",
        model: "claude-sonnet-5",
        input_tokens: 1000,
        output_tokens: 100,
        cost: 4.25,
      },
    ]),
  );
  const { events } = importUsageFile(file);
  // The export is the bill; our arithmetic does not override it.
  assert.equal(events[0].cost.total, 4.25);
});

test("rows with no model or no tokens are skipped, not guessed at", () => {
  const file = tmpFile(
    "messy.csv",
    [
      "timestamp,model,input,output",
      "2026-09-01,claude-haiku-4-5,100,50",
      "2026-09-01,,100,50",
      "2026-09-01,claude-haiku-4-5,0,0",
    ].join("\n"),
  );
  const { events, skipped } = importUsageFile(file);
  assert.equal(events.length, 1);
  assert.equal(skipped, 2);
});

test("an unknown model imports but is flagged unpriced rather than assumed", () => {
  const file = tmpFile(
    "unknown.csv",
    ["timestamp,model,input,output", "2026-09-01,some-other-llm,1000,500"].join("\n"),
  );
  const { events } = importUsageFile(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].cost.unpriced, true);
  assert.equal(events[0].cost.total, 0);
  assert.equal(events[0].provider, "unknown");
});
