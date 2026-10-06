import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProfile,
  createLiveAnalyzer,
  findWaste,
  likelyMonthly,
  recoverableMonthly,
  renderFindings,
  renderProfile,
  renderRecommendations,
  summarize,
  toRecommendations,
} from "@optimaizr/core";
import { autoEligible } from "@optimaizr/local";
import {
  codexRollout,
  edit,
  load,
  loadCodex,
  lookup,
  read,
  transcript,
} from "./fixtures/transcripts.mjs";

/**
 * Findings come in three tiers: `fix` (clear waste, the headline), `try`
 * (likely, but it changes what the model does) and `test` (trade-offs sized
 * from the user's own usage, shown as "up to" and never added to anything).
 */

/** One long conversation whose context grows past the compaction window. */
function longConversation(perCall = 6_000, calls = 100) {
  const script = [{ prompt: "build the whole thing" }];
  for (let i = 0; i < calls; i++) {
    script.push({ tools: [read(`/w/f${i}.ts`)], out: 300, ctx: 50_000 + i * perCall });
  }
  script.push({ out: 400, ctx: 50_000 + calls * perCall });
  return script;
}

/** A finished multi-step task on Opus with no heavy reasoning. */
const steadyTask = (i, think = 0) => [
  { prompt: `task ${i}` },
  ...Array.from({ length: 10 }, (_, k) => ({
    tools: [edit(`/w/t${i}-${k}.ts`, `${i}-${k}`)],
    out: 1_500,
    think,
    ctx: 50_000,
  })),
  { out: 400, ctx: 50_000 },
];

const rule = (findings, name) => findings.find((f) => f.rule === name);

test("each finding carries a tier and the three parts of its story", async () => {
  const script = [];
  for (let i = 0; i < 8; i++) script.push(...lookup());
  script.push(
    { prompt: "x" },
    { tools: [{ ...read("/w/big.ts"), chars: 40_000 }] },
    { tools: [{ ...read("/w/big.ts"), chars: 40_000 }] },
    { out: 50 },
  );
  const findings = findWaste(await load({ s1: transcript("s1", script) }));

  assert.equal(rule(findings, "repeat-tool-calls").tier, "fix");
  assert.equal(rule(findings, "model-fit").tier, "try");
  for (const f of findings) {
    assert.ok(f.why.length > 20, `${f.rule} says why it matters`);
    assert.ok(f.fix.length > 20, `${f.rule} says what to do`);
  }

  const recs = toRecommendations(findings, 100);
  for (const r of recs) {
    assert.equal(r.happened, findings.find((f) => f.rule === r.rule).title);
    assert.ok(r.why && r.fix);
  }
  const order = { fix: 0, try: 1, test: 2 };
  assert.deepEqual(
    recs.map((r) => order[r.tier]),
    [...recs.map((r) => order[r.tier])].sort(),
    "clear waste first, then what to try, then what to test",
  );
});

test("the headline is clear waste; likely savings never count a call twice", async () => {
  const script = [];
  for (let i = 0; i < 8; i++) script.push(...lookup());
  const findings = findWaste(await load({ s1: transcript("s1", script) }));
  const fix = recoverableMonthly(findings);
  const both = recoverableMonthly(findings, ["fix", "try"]);
  assert.ok(Math.abs(likelyMonthly(findings) - (both - fix)) < 1e-9);
  assert.ok(likelyMonthly(findings) > 0, "the quick tasks on Opus are a likely saving");
});

test("compacting earlier is a lever sized from the conversation's own growth", async () => {
  const data = await load({ s1: transcript("s1", longConversation()) });
  const findings = findWaste(data);
  const lever = rule(findings, "context-compaction");
  assert.ok(lever, "a conversation that grows to 650K should suggest compacting earlier");
  assert.equal(lever.tier, "test");
  assert.equal(lever.savings.confidence, "low", "a lever is possible until tested");
  assert.match(lever.title, /of your Claude Code calls carried over 200K of conversation/);
  assert.match(lever.fix, /CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"/);
  assert.match(lever.why, /re-reading took \d+% of your Claude Code spend/);
  // The compactions themselves are paid for.
  assert.match(lever.observations[1], /compactions? at 200K would have cost \$/);

  const short = findWaste(await load({ s1: transcript("s1", longConversation(0)) }));
  assert.equal(rule(short, "context-compaction"), undefined, "nothing to say under 200K");
});

test("a smaller default model is a lever over work without heavy reasoning", async () => {
  const script = [];
  for (let i = 0; i < 12; i++) script.push(...steadyTask(i));
  for (let i = 12; i < 15; i++) script.push(...steadyTask(i, 3_000));
  const lever = rule(findWaste(await load({ s1: transcript("s1", script) })), "model-default");
  assert.ok(lever);
  assert.equal(lever.tier, "test");
  assert.match(
    lever.detail,
    /^12 tasks on Opus 5\.5/,
    "the three reasoning-heavy tasks stay on Opus",
  );
  assert.match(lever.fix, /\/model sonnet/);
  assert.equal(lever.candidate?.kind, "swap-model", "verify can replay it before anyone switches");
});

test("levers never reach the headline, the totals or the opportunities", async () => {
  const data = await load({ s1: transcript("s1", longConversation()) });
  const summary = summarize(data);
  const findings = findWaste(data);
  const profile = buildProfile(data, summary, findings);

  assert.ok(profile.levers.some((r) => r.rule === "context-compaction"));
  assert.ok(profile.opportunities.every((r) => r.tier !== "test"));
  assert.equal(profile.savingsMonthlyUsd, recoverableMonthly(findings));
  const leverUsd = profile.levers.reduce((s, r) => s + r.savings.monthlyUsd, 0);
  assert.ok(
    profile.savingsMonthlyUsd < leverUsd,
    "the lever is far bigger, and still not in the headline",
  );

  const text = renderProfile(profile);
  assert.match(text, /Clear waste/);
  assert.match(text, /Up to, if you test\s+\$[\d,.]+\/mo\s+compact earlier/);
  assert.match(text, /Biggest win\s+Compact earlier/, "the biggest lever leads the screen");
  assert.match(text, /Up to \d+% less usage/);
});

test("the long-conversation fact and the compaction lever count the same calls", async () => {
  const claude = await load({ s1: transcript("s1", longConversation()) });
  const codex = await loadCodex({
    a: codexRollout("a", [{ prompt: "x" }, { ctx: 10_000 }, { ctx: 10_000 }]),
  });
  const data = { ...claude, events: [...claude.events, ...codex.events] };
  const profile = buildProfile(data, summarize(data), findWaste(data));
  const fact = profile.habits.find((h) => h.key === "context").note.match(/^(\d+)%/)[1];
  const lever = findWaste(data).find((f) => f.rule === "context-compaction");
  assert.equal(
    lever.title.match(/^(\d+)%/)[1],
    fact,
    "two Codex calls must not move one figure and not the other",
  );
});

test("waste, recommend and profile report the same clear-waste figure", async () => {
  const script = [];
  for (let i = 0; i < 8; i++) script.push(...lookup());
  script.push(...longConversation());
  const data = await load({ s1: transcript("s1", script) });
  const summary = summarize(data);
  const findings = findWaste(data);
  const profile = buildProfile(data, summary, findings);
  const money = (n) => `$${n.toFixed(2)}`;

  const waste = renderFindings(findings, summary);
  assert.match(waste, new RegExp(`Clear waste\\s+\\${money(profile.savingsMonthlyUsd)}/mo`));
  assert.match(waste, /What happened/);
  assert.match(waste, /Why it matters/);
  assert.match(waste, /What to do/);
  assert.match(waste, /up to \$/);
  assert.match(waste, /possible/, "a lever says how sure it is in words");

  const recommend = renderRecommendations(
    toRecommendations(findings, data.events.length),
    summary.perMonth,
    {
      fix: recoverableMonthly(findings),
      try: likelyMonthly(findings),
    },
  );
  assert.match(recommend, new RegExp(`\\${money(profile.savingsMonthlyUsd)}/month of clear waste`));
});

test("live never proposes a lever, and --auto never applies one", async () => {
  const data = await load({ s1: transcript("s1", longConversation()) });
  const analyzer = createLiveAnalyzer({ minUsd: 0, maxEvents: 1_000 });
  for (const e of data.events) analyzer.push(e);
  assert.ok(analyzer.flush().every((r) => r.finding.tier !== "test"));

  const rec = (tier) => ({
    finding: { tier, candidate: { kind: "swap-model" }, savings: { confidence: "high" } },
    traffic: { slices: [{ source: "claude-code" }] },
  });
  assert.equal(autoEligible(rec("try"), 1), true);
  assert.equal(autoEligible(rec("test"), 1), false);
});

test("savings found: exact dollars per tier, each lever with the fact behind it", async () => {
  const data = await load({ s1: transcript("s1", longConversation()) });
  const profile = buildProfile(data, summarize(data), findWaste(data));
  const long = profile.habits.find((h) => h.key === "context");
  assert.equal(long.rule, "context-compaction");
  assert.match(long.note, /^\d+% of calls carry over 200K of conversation$/);
  const lever = profile.levers.find((r) => r.rule === "context-compaction");

  const text = renderProfile(profile);
  assert.match(text, /Savings found/);
  assert.match(text, new RegExp(`Clear waste\\s+\\$${profile.savingsMonthlyUsd.toFixed(2)}/mo`));
  assert.match(
    text,
    new RegExp(
      `Up to, if you test\\s+\\$${lever.savings.monthlyUsd.toFixed(2)}/mo\\s+compact earlier · \\d+% of calls carry over 200K`,
    ),
  );
  assert.doesNotMatch(text, /\b[A-F]\s+·\s+Context/, "no letter grades");
});

test("the profile leads with the biggest win and says where the money goes", async () => {
  const data = await load({ s1: transcript("s1", longConversation()) });
  const summary = summarize(data);
  const findings = findWaste(data);

  const plain = buildProfile(data, summary, findings);
  const b = plain.breakdown;
  assert.ok(Math.abs(b.reread + b.output + b.cacheWrite + b.input + b.tools - 1) < 1e-9);
  assert.ok(b.reread > 0.5, "a long conversation is mostly re-reading");
  const win = plain.biggestWin;
  assert.equal(win.recommendation.rule, "context-compaction");
  assert.ok(Math.abs(win.moreWork - 1 / (1 - win.share)) < 1e-9);
  assert.equal(plain.nextCommand, "optimaizr simulate context-compaction");

  // Headroom is a plan's idea: only shown when there is a window to stretch.
  const text = renderProfile(plain);
  assert.match(text, /Re-reading the conversation\s+\d+%/);
  assert.doesNotMatch(text, /per 5-hour window/);
  const onPlan = renderProfile(buildProfile(data, summary, findings, undefined, { plan: "pro" }));
  assert.match(onPlan, /about \d\.\dx the work per 5-hour window/);
  assert.match(onPlan, /Your Claude Pro did \$[\d,.]+\/mo of work at API prices/);
});

/* ------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------ */

/** A Codex session whose context grows past the window, as `longConversation` does. */
function longCodex(perCall = 6_000, calls = 100) {
  const script = [{ prompt: "build it" }];
  for (let i = 0; i < calls; i++) {
    script.push({ cmd: `cat f${i}.ts`, out: 300, ctx: 50_000 + i * perCall });
  }
  return script;
}

test("compacting earlier covers Codex, with Codex's own setting", async () => {
  const data = await loadCodex({ a: codexRollout("a", longCodex()) });
  const lever = rule(findWaste(data), "context-compaction");
  assert.ok(lever, "a Codex session growing to 650K should suggest compacting earlier");
  assert.match(lever.title, /of your Codex calls carried over 200K/);
  assert.match(lever.fix, /model_auto_compact_token_limit = 200000 in ~\/\.codex\/config\.toml/);
  assert.doesNotMatch(lever.fix, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
});

test("with both agents, the lever names both settings", async () => {
  const claude = await load({ s1: transcript("s1", longConversation()) });
  const codex = await loadCodex({ a: codexRollout("a", longCodex()) });
  const data = { ...claude, events: [...claude.events, ...codex.events] };
  const lever = rule(findWaste(data), "context-compaction");
  assert.match(lever.title, /of your Claude Code and Codex calls/);
  assert.match(lever.fix, /CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  assert.match(lever.fix, /model_auto_compact_token_limit/);
});

test("a Codex compaction starts a new context", async () => {
  const data = await loadCodex({
    a: codexRollout("a", [{ prompt: "x" }, { ctx: 300_000 }, { compact: true }, { ctx: 40_000 }]),
  });
  assert.deepEqual(
    data.events.map((e) => e.contextEpoch ?? 0),
    [0, 1],
  );
});

test("a smaller default model covers Codex, with Codex's own setting", async () => {
  const script = [];
  for (let i = 0; i < 12; i++) {
    script.push({ prompt: `task ${i}` });
    for (let k = 0; k < 10; k++) script.push({ cmd: `make step${k}`, out: 1_500, ctx: 50_000 });
  }
  script.push({ prompt: "done" }, { ctx: 50_000 });
  const lever = rule(findWaste(await loadCodex({ a: codexRollout("a", script) })), "model-default");
  assert.ok(lever);
  assert.match(lever.title, /of your GPT-5\.4 spend went to tasks without heavy reasoning/);
  assert.match(lever.fix, /Codex: model = "gpt-5\.4-mini" in ~\/\.codex\/config\.toml/);
  assert.doesNotMatch(lever.fix, /live --auto/, "the mod only switches Claude Code");
});
