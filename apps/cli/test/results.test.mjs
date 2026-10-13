import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeMetrics,
  measureChange,
  measureResults,
  renderResults,
  resultsDays,
} from "@optimaizr/core";
import {
  applyCompaction,
  appliedChanges,
  changesFrom,
  readChanges,
  recordChange,
  undoCompaction,
} from "@optimaizr/local";
import { codexRollout, load, loadCodex, transcript } from "./fixtures/transcripts.mjs";

const DAY = 86_400_000;
const AT = Date.UTC(2026, 9, 1, 0, 0);
const iso = (t) => new Date(t).toISOString();

/**
 * One day of usage, `d` days from the change (negative is before): `prompts`
 * prompts of `calls` calls each, costing `perPrompt` in all.
 */
function day(d, prompts, opts = {}) {
  const {
    perPrompt = 1,
    calls = 2,
    ctx = 100_000,
    project = "/w",
    model = "claude-opus-5-5",
    source = "claude-code",
    errors = 0,
    tag = "",
  } = opts;
  const out = [];
  for (let p = 0; p < prompts; p++) {
    const session = `s${tag}${d}-${Math.floor(p / 10)}`;
    for (let c = 0; c < calls; c++) {
      out.push({
        id: `${tag}${d}-${p}-${c}`,
        source,
        provider: "anthropic",
        ts: iso(AT + d * DAY + 3_600_000 + p * 120_000 + c * 1_000),
        model,
        sessionId: session,
        project,
        turnId: `${session}:${p}`,
        inputTokens: 10,
        outputTokens: 200,
        thinkingTokens: 0,
        cacheReadTokens: ctx,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        tools: c < errors ? [{ name: "Bash", isError: true }] : [],
        cost: { total: perPrompt / calls },
      });
    }
  }
  return out;
}

const days = (from, to, prompts, opts) => {
  const out = [];
  for (let d = from; d < to; d++) out.push(...day(d, prompts, opts));
  return out;
};

const compaction = (d, opts = {}) => ({
  source: "claude-code",
  ts: iso(AT + d * DAY + 7_200_000),
  sessionId: `c${d}`,
  project: "/w",
  trigger: "auto",
  preTokens: opts.pre ?? 168_000,
  durationMs: opts.ms ?? 60_000,
  midTask: opts.midTask ?? true,
});

const compact200 = {
  id: "context-compaction:claude-code:x",
  rule: "context-compaction",
  source: "claude-code",
  value: "200000",
  how: "optimaizr",
  at: iso(AT),
};

test("results: too early says how far along it is and when to look again", () => {
  const events = [...days(-14, 0, 30), ...day(0, 12, { ctx: 150_000 })];
  const r = measureChange({ events, compactions: [compaction(0)] }, compact200, {
    now: AT + 20 * 3_600_000,
  });
  assert.equal(r.verdict, "too-early");
  assert.equal(r.progress.activeDays, 1);
  assert.equal(r.progress.count, 12);
  assert.ok(r.progress.readyAround, "an estimate");
  assert.deepEqual(r.caveats, []);
  const facts = Object.fromEntries(r.since.map((f) => [f.key, f.value]));
  assert.equal(facts.prompts, 12);
  assert.equal(facts.compactions, 1);
  assert.equal(facts.callsPastPoint, 0);
  assert.match(r.since.find((f) => f.key === "compactions").text, /fired at 168K/);
});

test("results: a cheaper prompt after the change reads as working, with what it saved", () => {
  const events = [
    ...days(-14, 0, 30, { perPrompt: 1, ctx: 300_000 }),
    ...days(0, 5, 30, { perPrompt: 0.6, ctx: 120_000 }),
  ];
  const r = measureChange({ events }, compact200, { now: AT + 5 * DAY });
  assert.equal(r.verdict, "working");
  assert.equal(r.measure, "prompt");
  assert.equal(r.headline.key, "costPerPrompt");
  assert.ok(Math.abs(r.headline.change + 0.4) < 1e-9);
  assert.ok(r.early, "under a week");
  assert.ok(Math.abs(r.measuredSavingUsd - 0.4 * 150) < 1e-6);
  const past = r.rows.find((x) => x.key === "callsPastPoint");
  assert.equal(past.before, 1);
  assert.equal(past.after, 0);
  assert.equal(past.change, -1);
  assert.deepEqual(
    r.next.map((n) => n.command),
    ["optimaizr undo context-compaction"],
  );
});

test("metrics: realised savings are what results measured, not what was found", () => {
  const events = [
    ...days(-14, 0, 30, { perPrompt: 1, ctx: 300_000 }),
    ...days(0, 5, 30, { perPrompt: 0.6, ctx: 120_000 }),
  ];
  const data = { events, window: { from: "", to: "", days: 19 }, sources: [], warnings: [] };
  const undone = { ...compact200, id: "u", project: "/elsewhere", until: iso(AT + DAY) };
  const changes = [compact200, undone];
  const { results } = measureResults({ events }, changes, { now: AT + 5 * DAY });
  const recs = [
    { rule: "context-compaction", status: "new", savings: { monthlyUsd: 5 } },
    { rule: "cold-resume", status: "new", savings: { monthlyUsd: 3 } },
  ];
  const m = computeMetrics(data, [], recs, { changes, results });
  assert.equal(m.changesInPlace, 1);
  assert.equal(m.recommendationsAccepted, 1);
  assert.equal(m.changesMeasured, 1);
  assert.ok(Math.abs(m.realisedSavingsUsd - 0.4 * 150) < 1e-6);

  const before = computeMetrics(data, [], recs);
  assert.equal(before.realisedSavingsUsd, 0);
  assert.equal(before.changesMeasured, 0);
});

test("results: dearer after the change says so and puts undo first", () => {
  const events = [...days(-14, 0, 30, { perPrompt: 1 }), ...days(0, 8, 30, { perPrompt: 1.3 })];
  const r = measureChange({ events }, compact200, { now: AT + 8 * DAY });
  assert.equal(r.verdict, "worse");
  assert.equal(r.early, false);
  assert.equal(r.next[0].command, "optimaizr undo context-compaction");
  assert.match(r.next[0].why, /costs more/);
});

test("results: a small move is no clear effect", () => {
  const events = [...days(-14, 0, 30, { perPrompt: 1 }), ...days(0, 8, 30, { perPrompt: 0.95 })];
  assert.equal(measureChange({ events }, compact200, { now: AT + 8 * DAY }).verdict, "no-change");
});

test("results: nothing from before the change means no baseline, not a verdict", () => {
  const events = days(0, 8, 30, { perPrompt: 0.5 });
  const r = measureChange({ events }, compact200, { now: AT + 8 * DAY });
  assert.equal(r.verdict, "no-baseline");
  assert.equal(r.measuredSavingUsd, null);
});

test("results: more compactions are a trade-off, with a later point to try", () => {
  const events = [
    ...days(-14, 0, 30, { perPrompt: 1, ctx: 300_000 }),
    ...days(0, 8, 30, { perPrompt: 0.7, ctx: 120_000 }),
  ];
  const compactions = [compaction(-10), compaction(-3)];
  for (let d = 0; d < 8; d++) compactions.push(compaction(d), compaction(d + 0.1));
  const r = measureChange({ events, compactions }, compact200, { now: AT + 8 * DAY });
  assert.equal(r.verdict, "working");
  assert.equal(r.withCost, true);
  const perDay = r.rows.find((x) => x.key === "compactionsPerDay");
  assert.ok(perDay.tradeOff && perDay.worse);
  assert.equal(perDay.after, 2);
  assert.deepEqual(
    r.next.map((n) => n.command),
    ["optimaizr apply context-compaction --at 300K", "optimaizr undo context-compaction"],
  );
  assert.match(
    renderResults(measureResults({ events, compactions }, [compact200], { now: AT + 8 * DAY })),
    /trade-off/,
  );
});

test("results: caveats name a project shift, a shorter baseline and another change", () => {
  const events = [
    // Cheap for most of the fortnight, dear in the days just before.
    ...days(-14, -3, 30, { perPrompt: 1, project: "/w" }),
    ...days(-3, 0, 30, { perPrompt: 0.6, project: "/w" }),
    ...days(0, 8, 30, { perPrompt: 0.55, project: "/other" }),
  ];
  const other = {
    id: "heavy-start:claude-code:y",
    rule: "heavy-start",
    source: "claude-code",
    how: "by-hand",
    at: iso(AT + 2 * DAY),
  };
  const r = measureChange({ events }, compact200, {
    now: AT + 8 * DAY,
    others: [compact200, other],
  });
  assert.equal(r.verdict, "working");
  const text = r.caveats.join("\n");
  assert.match(text, /Against just the 3 days before the change it is 8% less instead of/);
  assert.match(text, /different projects: other went from 0% to 100%/);
  assert.match(text, /Another change landed in this period \(heavy-start, 2026-10-03\)/);
});

test("results: logs that stop short of the baseline are named", () => {
  const events = [...days(-5, 0, 40, { perPrompt: 1 }), ...days(0, 8, 30, { perPrompt: 0.5 })];
  const r = measureChange({ events }, compact200, { now: AT + 8 * DAY });
  assert.match(
    r.caveats.join("\n"),
    /Only 5 days of logs before the change, not 14\. Claude Code deletes/,
  );
});

test("results: a model override counts its own project and its new model", () => {
  const swap = {
    id: "model-fit:claude-code:z",
    rule: "model-fit",
    source: "claude-code",
    project: "/api",
    from: "claude-opus-5-5",
    to: "claude-sonnet-5-5",
    how: "optimaizr",
    at: iso(AT),
  };
  const events = [
    ...days(-14, 0, 20, { project: "/api" }),
    ...days(0, 6, 20, { project: "/api", model: "claude-sonnet-5-5", perPrompt: 0.5, calls: 3 }),
    // Elsewhere: not this change's business.
    ...days(-14, 6, 50, { project: "/w", perPrompt: 5, tag: "w" }),
  ];
  const r = measureChange({ events }, swap, { now: AT + 6 * DAY });
  assert.equal(r.after.prompts, 120);
  assert.equal(r.verdict, "working");
  const on = r.rows.find((x) => x.key === "onNewModel");
  assert.equal(on.label, "calls on Sonnet 5.5");
  assert.equal(on.before, 0);
  assert.equal(on.after, 1);
  // Three calls a prompt instead of two: the agent worked harder for the same answer.
  const calls = r.rows.find((x) => x.key === "callsPerPrompt");
  assert.ok(calls.tradeOff && calls.worse);
  assert.equal(r.withCost, true);
  assert.equal(r.since.find((f) => f.key === "callsOnNewModel").value, 360);
});

test("results: a change to an agent you never use is left out", () => {
  const codex = { ...compact200, id: "context-compaction:codex:x", source: "codex" };
  const events = [...days(-14, 0, 30), ...days(0, 5, 30)];
  const report = measureResults({ events }, [compact200, codex], { now: AT + 5 * DAY });
  assert.equal(report.schema, "optimaizr.results/1");
  assert.deepEqual(
    report.results.map((r) => r.change.source),
    ["claude-code"],
  );
});

test("results: loads enough history for the oldest change and its baseline", () => {
  assert.equal(resultsDays([compact200], AT + 10 * DAY), 10 + 30 + 1);
  assert.equal(resultsDays([], AT), 31);
});

test("results: renders a reading, and the empty state points at apply", () => {
  const events = [...days(-14, 0, 30), ...days(0, 8, 30, { perPrompt: 0.6 })];
  const out = renderResults(measureResults({ events }, [compact200], { now: AT + 8 * DAY }));
  assert.match(out, /Compact earlier: Claude Code at 200K/);
  assert.match(out, /Working:.*40% less per prompt than the 14 days before/);
  assert.match(out, /cost per prompt/);
  assert.match(out, /On a plan, the percentage is/);
  assert.doesNotMatch(out, /—/);

  const early = renderResults(
    measureResults({ events: days(-14, 1, 30) }, [compact200], { now: AT + DAY }),
  );
  assert.match(early, /Too early to tell: 1 of 3 active days and 30 of 100 prompts so far/);
  assert.doesNotMatch(early, /cost per prompt/);

  const empty = renderResults(measureResults({ events: [] }, [], { now: AT }));
  assert.match(empty, /No changes to measure yet/);
  assert.match(empty, /optimaizr apply <rule> --done/);
});

test("results: Claude Code transcripts give prompts and compactions to count", async () => {
  // One conversation a day; the change lands before the last one.
  const sessions = {};
  for (let d = 0; d < 4; d++) {
    sessions[`d${d}`] = transcript(`d${d}`, [
      { prompt: "go", gap: d * 24 * 60 },
      { ctx: d < 3 ? 250_000 : 120_000 },
      { compact: true, meta: { trigger: "auto", preTokens: 168_000, durationMs: 30_000 } },
      { prompt: "again" },
      { ctx: 40_000 },
    ]);
  }
  const data = await load(sessions);
  const change = { ...compact200, at: iso(Date.UTC(2026, 8, 23, 0, 0)) };
  const r = measureChange(data, change, { now: Date.UTC(2026, 8, 24, 0, 0) });
  assert.equal(r.before.prompts, 6);
  assert.equal(r.after.prompts, 2);
  assert.equal(r.since.find((f) => f.key === "compactions").value, 1);
  assert.equal(r.rows.find((x) => x.key === "callsPastPoint").before, 0.5);
});

test("results: Codex rollouts give prompts and compactions too, without a wait to add up", async () => {
  const rollouts = {};
  for (let d = 0; d < 4; d++) {
    rollouts[`d${d}`] = codexRollout(`d${d}`, [
      { prompt: "go", gap: d * 24 * 60 },
      { cmd: "npm test", ctx: d < 3 ? 250_000 : 120_000 },
      { compact: true },
      { prompt: "again" },
      { ctx: 40_000 },
    ]);
  }
  const data = await loadCodex(rollouts);
  const change = {
    ...compact200,
    id: "context-compaction:codex:x",
    source: "codex",
    at: iso(Date.UTC(2026, 8, 23, 0, 0)),
  };
  const r = measureChange(data, change, { now: Date.UTC(2026, 8, 24, 0, 0) });
  assert.equal(r.before.prompts, 6);
  assert.equal(r.after.prompts, 2);
  const since = r.since.find((f) => f.key === "compactions");
  assert.equal(since.value, 1);
  assert.match(since.text, /fired at 120K/);
  assert.equal(r.rows.find((x) => x.key === "midTaskShare").after, 1);
  // Codex doesn't time its summaries, so there is no row claiming zero minutes.
  assert.equal(
    r.rows.find((x) => x.key === "waitingPerDay"),
    undefined,
  );
});

/* ------------------------------------------------------------------ *
 * The change journal
 * ------------------------------------------------------------------ */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-changes-"));

test("journal: a new value replaces the old one, the same value again is not a new period", () => {
  const e = (kind, at, value) => ({
    kind,
    rule: "context-compaction",
    source: "claude-code",
    value,
    at,
  });
  const changes = changesFrom([
    e("apply", "2026-10-01T00:00:00.000Z", "200000"),
    e("apply", "2026-10-02T00:00:00.000Z", "200000"),
    e("apply", "2026-10-05T00:00:00.000Z", "300000"),
    e("undo", "2026-10-09T00:00:00.000Z"),
  ]);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].until, "2026-10-05T00:00:00.000Z");
  assert.equal(changes[1].value, "300000");
  assert.equal(changes[1].until, "2026-10-09T00:00:00.000Z");
});

test("journal: a change recorded by hand is marked so", () => {
  const [c] = changesFrom([
    { kind: "record", rule: "heavy-start", at: "2026-10-01T00:00:00.000Z" },
  ]);
  assert.equal(c.how, "by-hand");
  assert.equal(c.until, undefined);
});

test("journal: merges older settings and overrides without counting a change twice", () => {
  const dir = tmp();
  const journal = path.join(dir, "changes.jsonl");
  const settingsLedger = path.join(dir, "settings-changes.json");
  const overrides = path.join(dir, "overrides.json");
  fs.writeFileSync(
    settingsLedger,
    JSON.stringify({
      version: 1,
      changes: [
        {
          agent: "claude-code",
          file: "x",
          previous: null,
          value: "200000",
          at: "2026-10-01T00:00:00.000Z",
        },
      ],
    }),
  );
  fs.writeFileSync(
    overrides,
    JSON.stringify({
      version: 1,
      overrides: [
        {
          rule: "model-fit",
          source: "claude-code",
          project: "/api",
          from: "claude-opus-5-5",
          to: "claude-sonnet-5-5",
          at: "2026-10-02T00:00:00.000Z",
        },
      ],
    }),
  );
  // The journal already has the override, seconds apart from the file's stamp.
  recordChange(
    {
      kind: "apply",
      rule: "model-fit",
      source: "claude-code",
      project: "/api",
      from: "claude-opus-5-5",
      to: "claude-sonnet-5-5",
      at: "2026-10-02T00:00:05.000Z",
    },
    journal,
  );
  const changes = appliedChanges({ journal, settingsLedger, overrides });
  assert.deepEqual(
    changes.map((c) => c.rule),
    ["context-compaction", "model-fit"],
  );
  assert.equal(changes[0].value, "200000");
  assert.equal(changes[1].project, "/api");
});

test("journal: apply and undo of compaction are written next to the ledger", () => {
  const dir = tmp();
  const p = {
    claudeSettings: path.join(dir, "settings.json"),
    codexConfig: path.join(dir, "config.toml"),
    ledger: path.join(dir, "settings-changes.json"),
  };
  applyCompaction(["claude-code"], { ...p, now: new Date("2026-10-01T00:00:00.000Z") });
  applyCompaction(["claude-code"], {
    ...p,
    tokens: 300_000,
    now: new Date("2026-10-03T00:00:00.000Z"),
  });
  undoCompaction(p);
  const journal = path.join(dir, "changes.jsonl");
  assert.deepEqual(
    readChanges(journal).map((e) => `${e.kind} ${e.value ?? ""}`.trim()),
    ["apply 200000", "apply 300000", "undo"],
  );
  const changes = appliedChanges({
    journal,
    settingsLedger: p.ledger,
    overrides: path.join(dir, "none.json"),
  });
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.until));
});

test("journal: an undo keeps the record of a change made before the journal existed", () => {
  const dir = tmp();
  const p = {
    claudeSettings: path.join(dir, "settings.json"),
    codexConfig: path.join(dir, "config.toml"),
    ledger: path.join(dir, "settings-changes.json"),
  };
  applyCompaction(["claude-code"], { ...p, now: new Date("2026-10-01T00:00:00.000Z") });
  // As 0.10 left it: the ledger, no journal.
  fs.rmSync(path.join(dir, "changes.jsonl"));
  undoCompaction(p);
  const kinds = readChanges(path.join(dir, "changes.jsonl")).map((e) => e.kind);
  assert.deepEqual(kinds, ["apply", "undo"]);
});
