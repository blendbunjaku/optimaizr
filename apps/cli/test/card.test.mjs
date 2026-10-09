import { test } from "node:test";
import assert from "node:assert/strict";

import { cardData, renderCardHtml, renderCardSvg } from "@optimaizr/core";

/**
 * The card leaves the machine by design, so the invariants are about what it
 * carries: the profile's own headline, and never a project name or path.
 */

function profile(overrides = {}) {
  return {
    window: { from: "", to: "", days: 167 },
    windowDays: { from: "2026-04-08", to: "2026-09-22" },
    spendUsd: 470,
    perMonthUsd: 448,
    pace: "last-30-days",
    calls: 3900,
    tokens: { input: 710e6, output: 3.6e6, total: 713.6e6 },
    flaggedCalls: 900,
    flaggedShare: 0.23,
    wasteWindowUsd: 47,
    savingsMonthlyUsd: 44.8,
    savingsAnnualUsd: 545,
    overlapping: false,
    opportunities: [],
    bottleneck: { rule: "model-fit" },
    nextCommand: "optimaizr simulate model-fit",
    budget: null,
    plan: null,
    levers: [],
    likelyMonthlyUsd: 0,
    biggestWin: null,
    habits: [],
    breakdown: { reread: 0.56, output: 0.2, cacheWrite: 0.2, input: 0.04, tools: 0 },
    ...overrides,
  };
}

const summary = {
  window: { from: "", to: "", days: 27 },
  windowDays: { from: "2026-08-26", to: "2026-09-22" },
  totalCost: 440,
  calls: 3730,
  totalTokens: 659.3e6,
  inputTokens: 1e6,
  cacheReadTokens: 650e6,
  cacheWriteTokens: 5e6,
  cacheHitRate: 0.99,
  byModel: [
    {
      // A fine-tune id names the organisation that trained it.
      key: "ft:gpt-4o-mini:secret-corp::abc123",
      cost: { total: 390 },
    },
  ],
};

test("the headline and waste are the profile's, the tiles are the recent window's", () => {
  const d = cardData(profile(), summary);
  assert.equal(d.headlineUsd, 448);
  assert.ok(Math.abs(d.wasteShare - 0.1) < 1e-9);
  assert.equal(d.biggestWaste, "Model mismatch");
  assert.equal(d.calls, 3730);
  assert.equal(d.from, "2026-08-26");
  assert.match(d.shareText, /\$448\/month at list prices/);
  assert.match(d.shareText, /10% of it was waste, mostly model mismatch/);
});

test("on a plan the headline is the subscription's value, with the multiple", () => {
  const d = cardData(
    profile({
      plan: { label: "Claude Pro", priceUsd: 20, valueMonthlyUsd: 448, multiple: 22.4, calls: 900 },
    }),
    summary,
  );
  assert.equal(d.multiple, "22x");
  assert.deepEqual(d.headlineNote, ["a month of API-equivalent usage", "on a $20 Claude Pro plan"]);
  assert.match(d.shareText, /on a \$20 plan \(22x what I pay\)/);
});

test("the card says where the money goes, how clean it is, and the biggest lever", () => {
  const plain = cardData(profile(), summary);
  assert.equal(plain.rereadShare, 0.56);
  assert.equal(plain.lever, null, "a fix is not a lever");
  assert.match(
    plain.shareText,
    /56% of the cost was Claude re-reading the conversation, at the cheap cache-read rate\./,
  );
  assert.match(plain.shareText, /10% of it was waste/);

  const withLever = cardData(
    profile({
      biggestWin: {
        recommendation: {
          rule: "context-compaction",
          tier: "test",
          savings: { monthlyUsd: 257.8 },
        },
        share: 0.28,
        moreWork: 1.39,
      },
    }),
    summary,
  );
  assert.deepEqual(withLever.lever, { label: "compact earlier", share: 0.28 });
  assert.match(
    withLever.shareText,
    /Biggest lever: compact earlier, up to 28% less \(\$258\/month\)\./,
  );
  const svg = renderCardSvg(withLever);
  assert.match(svg, /56% of the cost: re-reading the conversation/);
  assert.match(svg, /clear waste \$44\.80\/mo/);
  assert.match(svg, /biggest lever: compact earlier, up to 28% less/);
});

test("nothing that names a codebase reaches the image or the page", () => {
  const d = cardData(profile(), summary);
  const out = renderCardSvg(d) + renderCardHtml(d);
  assert.doesNotMatch(out, /secret-corp/);
  assert.equal(d.topModel.label, "Custom model");
});

test("the page is self-contained: no script, style or image is fetched", () => {
  const html = renderCardHtml(cardData(profile(), summary));
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|<img[^>]+src="http/);
  assert.match(html, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="1200" height="630"/);
});
