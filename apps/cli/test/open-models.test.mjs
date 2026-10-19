import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allModels,
  costOf,
  isPeak,
  normalizeUsage,
  pricingGaps,
  priceFor,
  ratesFor,
  statedCost,
  summarize,
} from "@optimaizr/core";

/**
 * Models people run through opencode that optimAIzr prices but never
 * recommends: DeepSeek, GLM, Kimi and MiniMax, at each vendor's own list price.
 */

const M = 1_000_000;
const TUESDAY_PEAK = "2026-10-20T02:00:00Z";
const TUESDAY_OFF = "2026-10-20T12:00:00Z";
const SATURDAY = "2026-10-24T02:00:00Z";

test("each open model is priced, but never listed in guide or proposed as a switch", () => {
  const open = allModels().filter((m) => m.listed === false);
  assert.ok(open.length >= 25);
  for (const m of open) {
    assert.equal(m.switchTarget, false, m.id);
    assert.ok(["deepseek", "zai", "moonshot", "minimax"].includes(m.provider), m.id);
  }
  for (const id of ["deepseek-v4-pro", "deepseek-flash", "glm-4.6", "kimi-k3", "minimax-m3"]) {
    assert.ok(
      open.some((m) => m.id === id),
      id,
    );
  }
});

test("vendor prefixes and mixed case resolve, a host's own ids do not", () => {
  const cases = [
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
    ["z-ai/glm-4.6", "glm-4.6"],
    ["moonshotai/kimi-k3", "kimi-k3"],
    ["minimax/minimax-m2.7", "minimax-m2.7"],
    ["MiniMax-M3", "minimax-m3"],
    ["GLM-4.5-Air", "glm-4.5-air"],
    ["glm-4.5-airx", "glm-4.5-airx"],
    ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash"],
    ["claude-opus-5-5", "claude-opus-5-5"],
  ];
  for (const [id, want] of cases) assert.equal(priceFor(id)?.id, want, id);
  // A host sets its own price, so its spelling stays unpriced.
  assert.equal(priceFor("deepseek-ai/DeepSeek-V4-Pro"), null);
  assert.equal(priceFor("qwen3-coder-plus"), null);
});

test("Z.ai's free models are $0 cards, not a prefix of a paid one", () => {
  const free = costOf({ input_tokens: M, output_tokens: M }, "glm-4.7-flash");
  assert.equal(free.unpriced, false);
  assert.equal(free.total, 0);
  assert.equal(costOf({ input_tokens: M }, "glm-4.7-flashx").total.toFixed(2), "0.07");
  assert.equal(costOf({ input_tokens: M }, "glm-4.7").total.toFixed(2), "0.60");
});

test("DeepSeek bills half outside its weekday peak hours", () => {
  const usage = { input_tokens: M, output_tokens: M, cache_read_input_tokens: M };
  const peak = costOf(usage, "deepseek-v4-pro", { at: TUESDAY_PEAK });
  assert.equal(peak.total.toFixed(3), (1.32 + 3.96 + 0.044).toFixed(3));
  assert.equal(
    costOf(usage, "deepseek-v4-pro", { at: TUESDAY_OFF }).total.toFixed(3),
    (peak.total / 2).toFixed(3),
  );
  assert.equal(
    costOf(usage, "deepseek-v4-pro", { at: SATURDAY }).total.toFixed(3),
    (peak.total / 2).toFixed(3),
  );
  // Other vendors keep one rate around the clock.
  const glm = (at) => costOf(usage, "glm-4.6", { at }).total;
  assert.equal(glm(TUESDAY_PEAK), glm(TUESDAY_OFF));
});

test("peak hours are weekdays inside the UTC ranges, end exclusive", () => {
  const ranges = [
    [1, 4],
    [6, 10],
  ];
  assert.equal(isPeak(ranges, "2026-10-20T01:00:00Z"), true);
  assert.equal(isPeak(ranges, "2026-10-20T03:59:00Z"), true);
  assert.equal(isPeak(ranges, "2026-10-20T04:00:00Z"), false);
  assert.equal(isPeak(ranges, "2026-10-20T09:30:00Z"), true);
  assert.equal(isPeak(ranges, "2026-10-20T10:00:00Z"), false);
  assert.equal(isPeak(ranges, "2026-10-25T08:00:00Z"), false);
});

test("MiniMax-M3 doubles past 512K input", () => {
  const short = ratesFor(priceFor("minimax-m3"), { promptTokens: 400_000 });
  const long = ratesFor(priceFor("minimax-m3"), { promptTokens: 600_000 });
  assert.deepEqual([short.inputPerM, short.cachedInputPerM, short.outputPerM], [0.3, 0.06, 1.2]);
  assert.deepEqual([long.inputPerM, long.cachedInputPerM, long.outputPerM], [0.6, 0.12, 2.4]);
});

test("Kimi K3 bills a 1h cache write at twice input", () => {
  const r = ratesFor(priceFor("kimi-k3"));
  assert.equal(r.cachedInputPerM, 0.3);
  assert.equal(r.cacheWrite5mPerM, 3);
  assert.equal(r.cacheWrite1hPerM, 6);
});

test("Chat Completions' prompt_tokens includes cache reads, in each vendor's spelling", () => {
  const deepseek = normalizeUsage(
    { prompt_tokens: 10_000, completion_tokens: 10, prompt_cache_hit_tokens: 8_000 },
    "deepseek-flash",
  );
  assert.deepEqual([deepseek.inputTokens, deepseek.cacheReadTokens], [2_000, 8_000]);
  const kimi = normalizeUsage({ prompt_tokens: 10_000, cached_tokens: 6_000 }, "kimi-k2.6");
  assert.deepEqual([kimi.inputTokens, kimi.cacheReadTokens], [4_000, 6_000]);
  const glm = normalizeUsage(
    { prompt_tokens: 10_000, prompt_tokens_details: { cached_tokens: 9_000 } },
    "glm-4.6",
  );
  assert.deepEqual([glm.inputTokens, glm.cacheReadTokens], [1_000, 9_000]);
  // Anthropic's own shape is left alone.
  const claude = normalizeUsage(
    { input_tokens: 2_000, cache_read_input_tokens: 8_000 },
    "claude-sonnet-5",
  );
  assert.equal(claude.inputTokens, 2_000);
});

test("a stated cost keeps its total and splits by token mix", () => {
  const c = statedCost(1, { input_tokens: 1_000, output_tokens: 1_000 }, "qwen3-coder-plus");
  assert.equal(c.total, 1);
  assert.equal(c.stated, true);
  assert.equal(c.unpriced, false);
  // Output weighs four times input.
  assert.equal(c.output.toFixed(2), "0.80");
  assert.equal(c.input.toFixed(2), "0.20");
  // No tokens at all: the whole figure sits on input, so it still adds up.
  assert.equal(statedCost(0.5, {}, "x").input, 0.5);
});

function event(id, model, cost) {
  return {
    id,
    source: "opencode",
    ts: "2026-10-19T10:00:00.000Z",
    model,
    provider: "unknown",
    sessionId: "s1",
    project: "/p",
    inputTokens: 1000,
    outputTokens: 100,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    tools: [],
    cost,
  };
}

test("the summary counts calls with no price, and those priced from opencode's figure", () => {
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const events = [
    event("a", "mystery-1", costOf(usage, "mystery-1")),
    event("b", "mystery-1", costOf(usage, "mystery-1")),
    event("c", "mystery-2", costOf(usage, "mystery-2")),
    event("d", "qwen3-coder-plus", statedCost(0.25, usage, "qwen3-coder-plus")),
    event("e", "glm-4.6", costOf(usage, "glm-4.6")),
  ];
  const s = summarize({
    events,
    window: { from: events[0].ts, to: events[0].ts, days: 1 },
    sources: [],
    warnings: [],
  });
  assert.deepEqual(s.unpriced, { calls: 3, models: ["mystery-1", "mystery-2"] });
  assert.deepEqual(s.stated, { calls: 1, usd: 0.25 });

  const lines = pricingGaps(s).join("\n");
  assert.match(lines, /3 calls counted as \$0/);
  assert.match(lines, /mystery-1, mystery-2/);
  assert.match(lines, /models\.json/);
  assert.match(lines, /1 call on models with no price here uses opencode's own cost: \$0\.250/);
  assert.deepEqual(
    pricingGaps({ unpriced: { calls: 0, models: [] }, stated: { calls: 0, usd: 0 } }),
    [],
  );
});

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const skip = fs.existsSync(CLI) ? false : "dist/cli.js is not built";

test("guide leaves the open models out and says they are priced", { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "guide-"));
  const out = execFileSync(process.execPath, [CLI, "guide"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
      NO_COLOR: "1",
    },
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.match(out, /Opus 5\.5/);
  assert.doesNotMatch(out, /Kimi K3|GLM-4\.6|DeepSeek V4 Pro/);
  assert.match(
    out,
    /Also priced, so their calls count, but not compared here: DeepSeek, GLM, Kimi, MiniMax/,
  );
});
