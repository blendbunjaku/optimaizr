import { test } from "node:test";
import assert from "node:assert/strict";

import { lib } from "./helpers.mjs";

const { money, tokens, percent, multiple, countdown, duration, ago, clip, folder } = lib;
const { expiringText, coldText, longText, doneText, guardCatchText } = lib;

test("money keeps cents under $100 and drops them above", () => {
  assert.equal(money(0.5), "$0.50");
  assert.equal(money(60.544), "$60.54");
  assert.equal(money(123.4), "$123");
  assert.equal(money(1234.5), "$1,235");
  assert.equal(money(Number.NaN), "$0");
});

test("tokens read as K and M", () => {
  assert.equal(tokens(950), "950");
  assert.equal(tokens(142_400), "142K");
  assert.equal(tokens(1_500_000), "1.5M");
  assert.equal(tokens(12_000_000), "12M");
});

test("percent says <1% for a sliver, not 0%", () => {
  assert.equal(percent(0), "0%");
  assert.equal(percent(0.004), "<1%");
  assert.equal(percent(0.134), "13%");
  assert.equal(multiple(33.8), "34x");
  assert.equal(multiple(1.4), "1.4x");
});

test("countdown and duration read like a clock and a stopwatch", () => {
  assert.equal(countdown(247_000), "4:07");
  assert.equal(countdown(59_001), "1:00");
  assert.equal(countdown(-5), "0:00");
  assert.equal(countdown(4_320_000), "1h 12m");
  assert.equal(duration(48_000), "48s");
  assert.equal(duration(134_000), "2m 14s");
  assert.equal(duration(120_000), "2m");
  assert.equal(duration(3_780_000), "1h 3m");
});

test("ago, clip and folder", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(ago("2026-10-28T11:59:50Z", now), "just now");
  assert.equal(ago("2026-10-28T11:48:00Z", now), "12 min ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(ago("not a date", now), "just now");
  assert.equal(clip("hello world", 6), "hello…");
  assert.equal(clip("short", 10), "short");
  assert.equal(folder("/Users/me/work/app/"), "app");
  assert.equal(folder("C:\\Users\\me\\app"), "app");
});

test("heads-up copy names the conversation and the money, with no em dashes", () => {
  const lines = [
    expiringText("Fix the login bug", 4 * 60_000, 1.78),
    coldText("Fix the login bug", 142_000, 1.78),
    longText("Fix the login bug", 212_000, 0.11),
    doneText(134_000, 0.62, 3.4),
    doneText(50_000, 0.02, null),
    ...["cold-hold", "big-read", "retry", "handoff-used", "compact", "other"].flatMap((kind) => {
      const t = guardCatchText({
        at: "",
        session: "s",
        kind,
        usd: 1.2,
        tokens: 90_000,
        detail: "/a/big.log",
      });
      return [t.title, t.text];
    }),
  ];
  assert.match(lines[0], /^4 min left on the cache for "Fix the login bug"\. .*\$1\.78 rewrite\.$/);
  assert.match(lines[1], /\$1\.78 to write 142K again/);
  assert.match(lines[2], /passed 212K tokens.*\(\$0\.11 a call\)/);
  assert.equal(lines[3], "Worked 2m 14s, $0.62, 3% of your 5h window.");
  assert.equal(lines[4], "Worked 50s, $0.02.");
  for (const line of lines) assert.doesNotMatch(line, /\u2014/);
});
