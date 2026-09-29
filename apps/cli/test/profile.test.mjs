import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  analyze,
  buildProfile,
  ingestClaudeCode,
  recoverableMonthly,
  recoverableWindow,
  renderProfile,
  setDecisionStore,
  summarize,
  toRecommendations,
} from "@optimaizr/core";
import "@optimaizr/local";

const execFileAsync = promisify(execFile);

/**
 * `profile` is a composition of numbers other commands already report. The
 * invariants under test are that it agrees with them, that it degrades cleanly
 * when there is nothing to say, and that looking at it changes nothing.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const call = ({ id, ts, session, usage, content }) => ({
  type: "assistant",
  timestamp: ts,
  sessionId: session,
  cwd: "/Users/someone/project",
  message: { id, model: "claude-sonnet-5", stop_reason: "end_turn", usage, content },
});

const bash = (i) => [
  { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } },
];

const day = (i) => `2026-09-${String((i % 28) + 1).padStart(2, "0")}`;

/** Mostly small calls, plus a top decile carrying a whole session's context. */
function oversizedRecords() {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push(
      call({
        id: `small${i}`,
        ts: `${day(i)}T10:00:00.000Z`,
        session: "s-small",
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 500,
        },
        content: bash(i),
      }),
    );
  }
  for (let i = 0; i < 10; i++) {
    records.push(
      call({
        id: `big${i}`,
        ts: `${day(i)}T11:00:00.000Z`,
        session: "s-big",
        usage: {
          input_tokens: 20,
          output_tokens: 120,
          cache_read_input_tokens: 400_000,
          cache_creation_input_tokens: 2_000,
        },
        content: bash(i),
      }),
    );
  }
  return records;
}

/** A handful of ordinary, uniform calls: nothing for any detector to find. */
function quietRecords() {
  return [0, 1, 2].map((i) =>
    call({
      id: `q${i}`,
      ts: `${day(i)}T10:00:00.000Z`,
      session: "s-q",
      usage: { input_tokens: 800, output_tokens: 300 },
      content: [{ type: "text", text: "Here is a thoughtful answer." }],
    }),
  );
}

/** Lay records out where the transcript reader looks: <root>/<project>/<session>.jsonl */
function writeProjects(root, records) {
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

async function profileOf(records) {
  const root = writeProjects(fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-prof-")), records);
  const data = await ingestClaudeCode({ root });
  const summary = summarize(data);
  const { findings } = analyze(data);
  return { data, summary, findings, profile: buildProfile(data, summary, findings) };
}

/* ------------------------------------------------------------------ *
 * buildProfile
 * ------------------------------------------------------------------ */

test("profile figures are the engine's figures, not new ones", async () => {
  const { data, summary, findings, profile } = await profileOf(oversizedRecords());

  assert.equal(profile.calls, summary.calls);
  assert.equal(profile.spendUsd, summary.totalCost);
  assert.equal(profile.tokens.total, summary.totalTokens);
  assert.equal(profile.savingsMonthlyUsd, recoverableMonthly(findings));
  assert.equal(profile.wasteWindowUsd, recoverableWindow(findings));

  const recs = toRecommendations(findings, data.events.length);
  assert.ok(recs.length > 0, "fixture should produce at least one recommendation");
  assert.deepEqual(
    profile.opportunities.map((r) => r.id),
    recs.slice(0, 3).map((r) => r.id),
  );
  assert.equal(profile.bottleneck?.id, recs[0].id);
  assert.equal(profile.nextCommand, `optimaizr simulate ${recs[0].id}`);
});

test("flagged calls are the union of what recoverable findings counted", async () => {
  const { data, findings, profile } = await profileOf(oversizedRecords());
  const recoverable = findings.filter((f) => !f.advisory);
  const union = data.events.filter((e) => recoverable.some((f) => f.affects(e)));

  assert.equal(profile.flaggedCalls, union.length);
  assert.ok(profile.flaggedCalls > 0);
  assert.ok(profile.flaggedCalls <= profile.calls);
  assert.equal(profile.flaggedShare, union.length / profile.calls);
});

test("with nothing recoverable, the profile says so and points at why", async () => {
  const { profile } = await profileOf(quietRecords());

  assert.equal(profile.bottleneck, null);
  assert.equal(profile.opportunities.length, 0);
  assert.equal(profile.flaggedCalls, 0);
  assert.equal(profile.nextCommand, "optimaizr why");

  const text = renderProfile(profile);
  assert.match(text, /No recoverable waste found/);
  assert.match(text, /optimaizr why/);
  assert.doesNotMatch(text, /Biggest opportunity/);
});

test("building a profile never writes a decision", async () => {
  let saves = 0;
  setDecisionStore({ load: () => ({}), save: () => saves++ });
  try {
    const { profile } = await profileOf(oversizedRecords());
    renderProfile(profile);
  } finally {
    setDecisionStore({ load: () => ({}), save: () => {} });
  }
  assert.equal(saves, 0);
});

test("the rendered profile answers usage, waste and what next", async () => {
  const { profile } = await profileOf(oversizedRecords());
  const text = renderProfile(profile);

  for (const heading of [
    "AI usage",
    "Optimization",
    "Biggest opportunity",
    "Top opportunities",
    "Next step",
  ]) {
    assert.ok(text.includes(heading), `missing section: ${heading}`);
  }
  assert.ok(text.includes(profile.nextCommand));
});

/* ------------------------------------------------------------------ *
 * The built CLI
 * ------------------------------------------------------------------ */

const CLI = path.join(new URL("..", import.meta.url).pathname, "dist/cli.js");
const HAS_CLI = fs.existsSync(CLI);
const skip = HAS_CLI ? false : "dist/cli.js is not built";

function fixtureHome(records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-prof-cli-"));
  if (records) writeProjects(path.join(home, ".claude", "projects"), records);
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
  };
}

async function runCli(argv, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...argv], {
      env: { ...process.env, ...env, NO_COLOR: "1" },
      cwd: env.HOME,
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "" };
  }
}

test("profile prints the snapshot and writes nothing", { skip }, async () => {
  const env = fixtureHome(oversizedRecords());
  const { code, stdout } = await runCli(["profile"], env);

  assert.equal(code, 0);
  assert.match(stdout, /optimAIzr \| profile/);
  assert.match(stdout, /Biggest opportunity/);
  assert.match(stdout, /optimaizr simulate [a-z-]+/);
  assert.equal(fs.existsSync(env.OPTIMAIZR_DIR), false, "profile must not create state");
});

test("profile --json is machine-readable and matches the text", { skip }, async () => {
  const env = fixtureHome(oversizedRecords());
  const { code, stdout } = await runCli(["profile", "--json"], env);
  assert.equal(code, 0);

  const p = JSON.parse(stdout);
  assert.equal(p.calls, 50);
  assert.ok(p.savingsMonthlyUsd > 0);
  assert.equal(p.nextCommand, `optimaizr simulate ${p.bottleneck.id}`);
  assert.deepEqual(p.errors, []);
});

test("profile with no usage data explains how to get some", { skip }, async () => {
  const env = fixtureHome(null);
  const { code, stdout } = await runCli(["profile"], env);

  assert.equal(code, 0);
  assert.match(stdout, /nothing to analyse yet/);
  assert.match(stdout, /optimaizr import/);
});

test("help lists profile", { skip }, async () => {
  const { stdout } = await runCli(["--help"], fixtureHome(null));
  assert.match(stdout, /optimaizr profile/);
});
