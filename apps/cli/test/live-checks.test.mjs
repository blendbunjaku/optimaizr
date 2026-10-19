import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BIG_CONVERSATION,
  liveChecks,
  liveStep,
  renderLiveChecks,
  renderNextStep,
  renderTurnDone,
  rereadFloor,
} from "@optimaizr/core";
import { canNotify, notifyCommand } from "@optimaizr/local";

/**
 * 0.12's live when it is quiet: what each check saw, so "all clear" has
 * reasons, and one step in the agent's own words when money is avoidable.
 */

const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const NOW = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60_000;

let n = 0;
const call = (o = {}) => ({
  id: `c${n++}`,
  source: "claude-code",
  provider: "anthropic",
  ts: new Date(NOW - 10 * MIN).toISOString(),
  model: "claude-opus-5-5",
  sessionId: "s1",
  project: "/w",
  inputTokens: 10,
  outputTokens: 400,
  thinkingTokens: 0,
  cacheReadTokens: 100_000,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 2000,
  tools: [],
  cost: { total: 0.06, cacheRead: 0.05 },
  ...o,
});

const quiet = () =>
  Array.from({ length: 20 }, (_, i) =>
    call({ ts: new Date(NOW - (30 - i) * MIN).toISOString(), cacheReadTokens: 100_000 + i * 1000 }),
  );

const byName = (c) => Object.fromEntries(c.checks.map((x) => [x.name, x]));

test("a quiet window says what each check saw", () => {
  const c = liveChecks(quiet(), {
    minUsd: 0.25,
    compactAt: { "claude-code": 200_000 },
    warm: [{ context: 119_000, expiresAt: NOW + 20 * MIN }],
    cold: { count: 0, usd: 0 },
    now: NOW,
  });
  assert.equal(c.calls, 20);
  assert.equal(c.spanMs, 19 * MIN);
  const x = byName(c);
  assert.deepEqual(Object.keys(x), ["Cache", "Context", "Warm", "Returns", "Rules"]);
  assert.match(x.Cache.detail, /^98% of what was sent came from the cache$/);
  assert.equal(x.Context.ok, true);
  assert.match(x.Context.detail, /the open conversation is at 121K, compacts at 200K/);
  assert.match(x.Warm.detail, /stays warm for 20m more/);
  assert.match(x.Returns.detail, /nothing came back to an expired cache this run/);

  const text = strip(renderLiveChecks(c, { now: NOW }));
  assert.match(text, /the last 20 calls, 19m/);
  assert.doesNotMatch(text, /Next:/);
});

test("context counts only conversations used in the last hour", () => {
  const old = call({
    sessionId: "old",
    ts: new Date(NOW - 3 * 60 * MIN).toISOString(),
    cacheReadTokens: 380_000,
  });
  const c = liveChecks([old, ...quiet()], {
    minUsd: 0.25,
    compactAt: { "claude-code": 200_000 },
    now: NOW,
  });
  assert.equal(byName(c).Context.ok, true, byName(c).Context.detail);
  assert.match(byName(c).Context.detail, /^the open conversation/);

  const past = liveChecks([call({ cacheReadTokens: 230_000 })], {
    minUsd: 0.25,
    compactAt: { "claude-code": 200_000 },
    now: NOW,
  });
  assert.equal(byName(past).Context.ok, false);
  assert.match(byName(past).Context.detail, /past where it compacts \(200K\)/);
});

test("the rules row agrees with what the run already printed", () => {
  const c = liveChecks(quiet(), {
    minUsd: 0.25,
    cold: { count: 2, usd: 3.6 },
    shown: { count: 2, usd: 1.8 },
    now: NOW,
  });
  const x = byName(c);
  assert.equal(x.Rules.ok, false);
  assert.equal(x.Rules.detail, "2 found this run, $1.80 already paid");
  assert.equal(x.Returns.ok, false);
  assert.match(x.Returns.detail, /2 came back to an expired cache this run, \$3\.60 written again/);
  assert.match(strip(renderLiveChecks(c, { now: NOW })), /2 of \d need a look/);
});

test("with no calls yet it says so, and what it will check", () => {
  const text = strip(renderLiveChecks(liveChecks([], { minUsd: 0.25, now: NOW }), { now: NOW }));
  assert.match(text, /Nothing to check yet/);
  assert.match(text, /cache, context, warm time, returns, rules/);
});

const finding = (rule, o = {}) => ({
  rule,
  title: "t",
  fix: "Route the eligible requests to a smaller model. Keep the rest.",
  savings: { windowUsd: 1.8, monthlyUsd: 10 },
  ...o,
});
const claude = { slices: [], shareBySource: { "claude-code": 0.9, sdk: 0.1 } };
const sdk = { slices: [], shareBySource: { sdk: 1 } };

test("a step is said in the agent's words, and SDK traffic gets the fix", () => {
  const fit = liveStep(finding("model-fit", { candidate: { to: "claude-sonnet-5-5" } }), claude);
  assert.match(fit.now, /type \/model sonnet/);
  assert.equal(fit.later, "optimaizr apply model-fit");

  assert.match(liveStep(finding("reasoning-effort"), claude).now, /\/effort medium/);
  assert.match(liveStep(finding("oversized-input"), claude).now, /\/clear/);
  const cold = liveStep(finding("cold-resume"), claude);
  assert.match(cold.now, /handoff note/);
  assert.match(cold.later, /\/clear/);

  assert.deepEqual(liveStep(finding("model-fit"), sdk), {
    now: "Route the eligible requests to a smaller model.",
  });
  assert.doesNotMatch(
    liveStep(finding("oversized-input"), { slices: [], shareBySource: { codex: 1 } }).now,
    /\/clear/,
  );
});

const next = (rule, step, o = {}) => ({
  rule,
  paidUsd: 1.8,
  calls: 3,
  spanMs: 42 * MIN,
  step,
  ...o,
});

test("the next step prints under the checks, now and then", () => {
  const c = liveChecks(quiet(), { minUsd: 0.25, shown: { count: 1, usd: 1.8 }, now: NOW });
  const step = liveStep(finding("cold-resume"), claude);
  const steps = [next("cold-resume", step)];
  const text = strip(renderLiveChecks(c, { now: NOW, steps }));
  assert.match(text, /Next: cold cache returns · \$1\.80 already paid/);
  assert.match(text, /now {3}Before a break/);
  assert.match(text, /then {2}optimaizr guard on: it holds the next message to an expired/);
  assert.doesNotMatch(text, /a applies it/);
  // With keys on, a step that is a setting says which key makes it.
  assert.match(strip(renderLiveChecks(c, { now: NOW, steps, keys: true })), /\(a applies it\)/);
});

test("guard and compaction steps only come when they are not set already", () => {
  const cold = (ctx) => liveStep(finding("cold-resume"), claude, ctx);
  assert.equal(cold({}).apply, "guard");
  assert.equal(cold({ guard: true }).apply, undefined);
  assert.match(cold({ guard: true }).later, /^Guard is on: it holds the next one/);

  const read = liveStep(finding("oversized-tool-output"), claude);
  assert.match(read.later, /^optimaizr guard on: it holds a whole read of a big file once/);
  assert.equal(
    liveStep(finding("oversized-tool-output"), claude, { guard: true }).apply,
    undefined,
  );
  assert.match(liveStep(finding("error-loops"), claude).later, /holds the third run once$/);

  // Compaction is offered only when it is known to be off for that agent.
  const big = (ctx, traffic = claude) => liveStep(finding("oversized-input"), traffic, ctx);
  const off = big({ compacts: { "claude-code": false } });
  assert.equal(off.apply, "context-compaction");
  assert.equal(off.agent, "claude-code");
  assert.match(off.later, /compacts at 200K/);
  assert.equal(big({ compacts: { "claude-code": true } }).apply, undefined);
  assert.equal(big({}).apply, undefined);
  const opencode = { slices: [], shareBySource: { opencode: 1 } };
  assert.equal(big({ compacts: { "claude-code": false } }, opencode).apply, undefined);

  // Guard is Claude Code's: Codex and SDK traffic never get it.
  const codex = { slices: [], shareBySource: { codex: 1 } };
  assert.equal(liveStep(finding("cold-resume"), codex).apply, undefined);
  assert.equal(liveStep(finding("oversized-tool-output"), sdk).apply, undefined);
});

test("n prints one step: what was paid, what each call still pays, what to do", () => {
  const step = liveStep(finding("cold-resume"), claude);
  const text = strip(renderNextStep(next("cold-resume", step), { now: NOW, keys: true }));
  assert.match(text, /Next step: cold cache returns/);
  assert.match(text, /already paid {4}\$1\.80 over 3 calls, 42m/);
  assert.match(text, /still avoidable about \$0\.600 a call, until it changes/);
  assert.match(text, /now {3}Before a break/);
  assert.match(text, /\(a applies it\)/);

  const none = strip(renderNextStep(null, { now: NOW, keys: true }));
  assert.match(none, /No waste found/);
  assert.match(none, /\? shows what was checked/);
  assert.doesNotMatch(none, /most of this run/);

  // Nothing wasted still says where the money went, and what would make it cheaper.
  const biggest = {
    sessionId: "s1",
    name: "Fix the login bug",
    source: "claude-code",
    usd: 4.1,
    runUsd: 5.2,
    context: 161_000,
    perMessageUsd: 0.21,
  };
  const most = strip(renderNextStep(null, { now: NOW, keys: true, biggest }));
  assert.match(most, /most of this run: Fix the login bug \$4\.10 of \$5\.20/);
  assert.match(most, /it is 161\.0K long, and re-reading it costs about \$0\.210 a message here/);
  assert.match(
    most,
    /\/compact between tasks keeps a summary \(early details can drop\), \/clear starts empty/,
  );
  const codex = strip(
    renderNextStep(null, { biggest: { ...biggest, source: "codex", perMessageUsd: null } }),
  );
  assert.match(codex, /most of this run: Fix the login bug/);
  assert.doesNotMatch(codex, /re-reading|\/compact/);
  assert.match(
    strip(renderNextStep(null, { biggest: { ...biggest, source: "codex" } })),
    /\/new starts empty/,
  );
});

test("a big conversation says what each message re-reads first", () => {
  const big = call({ cacheReadTokens: 150_000 });
  const floor = rereadFloor(big);
  // 152,010 tokens at Opus 5.5's $0.20/M cache read.
  assert.ok(Math.abs(floor - 0.0304) < 0.0005, String(floor));
  assert.equal(rereadFloor(call({ model: "made-up-model" })), null);

  const c = liveChecks([big], { minUsd: 0.25, compactAt: { "claude-code": 200_000 }, now: NOW });
  assert.match(byName(c).Context.detail, /each message re-reads it, at least \$0\.03/);
  assert.equal(BIG_CONVERSATION, 100_000);
  const small = liveChecks([call({ cacheReadTokens: 40_000 })], { minUsd: 0.25, now: NOW });
  assert.doesNotMatch(byName(small).Context.detail, /re-reads/);

  const done = {
    event: big,
    workMs: 125_000,
    costUsd: 0.7,
    conversation: { costUsd: 9.2, workMs: 60 * MIN },
    usdPerPercent: null,
  };
  const line = strip(
    renderTurnDone({ ...done, next: { context: 152_010, floorUsd: floor, callsPerMessage: 6.4 } }),
  );
  assert.match(
    line,
    /now 152\.0K long: Claude re-reads all of it on every step, about \$0\.195 a message here/,
  );
  const one = strip(
    renderTurnDone({ ...done, next: { context: 152_010, floorUsd: floor, callsPerMessage: null } }),
  );
  assert.match(one, /at least \$0\.030 a step$/m);
  assert.doesNotMatch(strip(renderTurnDone(done)), /re-reads/);
});

test("notifications escape what they show, and only where there is a way to", () => {
  const [cmd, argv] = notifyCommand('Cache "expires" in 3 min', "a\\b\n  c", "darwin");
  assert.equal(cmd, "osascript");
  assert.equal(
    argv[1],
    'display notification "a\\\\b c" with title "optimAIzr" subtitle "Cache \\"expires\\" in 3 min"',
  );
  assert.deepEqual(notifyCommand("t", "b", "linux"), [
    "notify-send",
    ["--app-name=optimAIzr", "t", "b"],
  ]);
  assert.equal(notifyCommand("t", "b", "win32"), null);
  assert.equal(canNotify("darwin"), true);
  assert.equal(canNotify("win32"), false);
});
