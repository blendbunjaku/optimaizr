import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accept, trafficOf } from "@optimaizr/core";
import {
  activeModSessions,
  claudeModRewriter,
  claudeSettingsRewriter,
  describeClaudeOverride,
  overrideFor,
  projectRoot,
  readModSessions,
  readOverrides,
  writeOverrides,
} from "@optimaizr/local";

const NOW = new Date("2026-10-02T21:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-mod-"));
}

/** A sessions folder holding what the mod would have written. */
function sessions(...list) {
  const dir = tempDir();
  for (const s of list) {
    fs.writeFileSync(
      path.join(dir, `${s.id}.json`),
      JSON.stringify({ version: "0.8.0", cwd: "/work/shop-api", startedAt: ago(0), ...s }),
    );
  }
  return dir;
}

/** A model-fit finding whose traffic is the given slices. */
function finding(slices, to = "claude-sonnet-5-5") {
  return {
    rule: "model-fit",
    risk: "needs-verification",
    verification: "replay",
    affected: { share: 1, calls: 40, models: [], projects: [], routes: [], sampleEventIds: [] },
    candidate: { kind: "swap-model", to, matches: () => true, description: "swap" },
    fix: "route mechanical steps to Sonnet",
    savings: {},
    traffic: { slices, shareBySource: { "claude-code": 1 } },
  };
}

const slice = (over = {}) => ({
  source: "claude-code",
  project: "/work/shop-api",
  model: "claude-opus-5-5",
  calls: 23,
  subagent: true,
  share: 0.9,
  ...over,
});

test("a session counts as running until three beats are missed or it ends", () => {
  const dir = sessions(
    { id: "fresh", seenAt: ago(30_000) },
    { id: "stale", seenAt: ago(4 * 60_000) },
    { id: "ended", seenAt: ago(10_000), endedAt: ago(10_000) },
  );
  const running = activeModSessions({ dir, now: NOW }).map((s) => s.id);
  assert.deepEqual(running, ["fresh"]);
});

test("files of sessions gone for a week are removed as they are read", () => {
  const dir = sessions(
    { id: "old", seenAt: ago(8 * 24 * 3_600_000) },
    { id: "new", seenAt: ago(0) },
  );
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  assert.deepEqual(
    readModSessions(dir, NOW).map((s) => s.id),
    ["new"],
  );
  assert.equal(fs.existsSync(path.join(dir, "old.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "broken.json")), true, "a half-written file stays");
});

test("Y switches running sessions through the mod, per project and agent", () => {
  const file = path.join(tempDir(), "overrides.json");
  writeOverrides([{ rule: "other", project: "billing", from: "a", to: "b", at: "x" }], file);
  const r = claudeModRewriter({
    file,
    sessionsDir: sessions({ id: "s1", seenAt: ago(5_000) }),
    now: () => NOW,
  });
  const f = finding([slice()]);

  const outcome = accept(f, { rewriters: [r], traffic: f.traffic });
  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.via, "optimAIzr mod");
  assert.match(outcome.detail, /1 Claude Code session running the optimAIzr mod switches from/);
  assert.match(outcome.detail, /`\/optimaizr off` in a session goes back for that session/);
  assert.match(outcome.detail, /optimaizr undo model-fit` reverts it everywhere/);

  const written = readOverrides(file);
  assert.equal(written.length, 2, "the wrap() override is kept");
  assert.deepEqual(written[1], {
    rule: "model-fit",
    source: "claude-code",
    project: "/work/shop-api",
    subagent: true,
    from: "claude-opus-5-5",
    to: "claude-sonnet-5-5",
    at: NOW.toISOString(),
  });
  assert.equal(describeClaudeOverride(written[1]), "shop-api subagents: Opus 5.5 -> Sonnet 5.5");
});

test("a switch names the repository, not the subfolder Claude was in", () => {
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, "apps", "api", "src"), { recursive: true });
  assert.equal(projectRoot(path.join(repo, "apps", "api", "src")), repo);
  assert.equal(projectRoot("/work/no-repo-here"), "/work/no-repo-here");
});

test("an accepted effort finding lowers effort through the mod, same model", () => {
  const file = path.join(tempDir(), "overrides.json");
  const r = claudeModRewriter({
    file,
    sessionsDir: sessions({ id: "s1", seenAt: ago(5_000) }),
    now: () => NOW,
  });
  const f = {
    ...finding([slice({ subagent: false })]),
    rule: "reasoning-effort",
    candidate: {
      kind: "lower-effort",
      from: "high",
      to: "low",
      matches: () => true,
      description: "x",
    },
  };
  const outcome = accept(f, { rewriters: [r], traffic: f.traffic });
  assert.equal(outcome.kind, "applied");
  const [o] = readOverrides(file);
  assert.equal(o.effort, "low");
  assert.equal(o.to, o.from);
  assert.equal(describeClaudeOverride(o), "shop-api main: Opus 5.5 at low effort");
  assert.doesNotMatch(outcome.detail, /without the cache/);
});

test("a model switch and an effort switch for the same model live side by side", () => {
  const file = path.join(tempDir(), "overrides.json");
  const base = {
    rule: "x",
    source: "claude-code",
    project: "/p",
    from: "claude-opus-5-5",
    at: "x",
  };
  writeOverrides([{ ...base, to: "claude-haiku-4-5" }], file);
  const r = claudeModRewriter({
    file,
    sessionsDir: sessions({ id: "s1", seenAt: ago(5_000) }),
    now: () => NOW,
  });
  const f = {
    ...finding([slice({ project: "/p", subagent: undefined })]),
    rule: "reasoning-effort",
    candidate: { kind: "lower-effort", to: "low", matches: () => true, description: "x" },
  };
  accept(f, { rewriters: [r], traffic: f.traffic });
  assert.equal(readOverrides(file).length, 2);
});

test("without a running session the mod rewriter stands aside", () => {
  const r = claudeModRewriter({
    file: path.join(tempDir(), "overrides.json"),
    sessionsDir: sessions({ id: "s1", seenAt: ago(10 * 60_000) }),
    now: () => NOW,
  });
  const f = finding([slice()]);
  assert.equal(r.supports({ kind: "swap-model", traffic: f.traffic }, f), false);
});

test("a finding over a small part of a slice is declined, not half-applied", () => {
  const file = path.join(tempDir(), "overrides.json");
  const r = claudeModRewriter({
    file,
    sessionsDir: sessions({ id: "s1", seenAt: ago(5_000) }),
    now: () => NOW,
  });
  const f = finding([slice({ share: 0.35 })]);
  const outcome = accept(f, { rewriters: [r], traffic: f.traffic });
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.reason, /only 35% of their project's spend/);
  assert.deepEqual(readOverrides(file), []);
});

test("while the mod runs, Claude Code's global settings are left alone", () => {
  const settingsPath = path.join(tempDir(), "settings.json");
  const settings = claudeSettingsRewriter({ settingsPath, unless: () => true });
  const f = finding([slice({ subagent: false })]);
  assert.equal(settings.supports({ kind: "swap-model", toModelId: "claude-sonnet-5-5" }, f), false);
  assert.equal(fs.existsSync(settingsPath), false);
});

test("wrap() never picks up a Claude Code entry for the same name", () => {
  const list = [
    {
      rule: "model-fit",
      source: "claude-code",
      project: "shop-api",
      from: "claude-opus-5-5",
      to: "claude-sonnet-5-5",
      at: "x",
    },
  ];
  assert.equal(overrideFor(list, { project: "shop-api", model: "claude-opus-5-5" }), undefined);
});

test("Claude Code traffic is split by agent, each slice with its own share", () => {
  const ev = (model, isSubagent, total) => ({
    source: "claude-code",
    project: "/work/shop-api",
    model,
    isSubagent,
    cost: { total },
  });
  const events = [
    ev("claude-opus-5-5", true, 3),
    ev("claude-opus-5-5", true, 1),
    ev("claude-opus-5-5", false, 4),
    ev("claude-opus-5-5", false, 4),
  ];
  // The rule flags every subagent call and one of the two main calls.
  let n = 0;
  const f = { affects: (e) => e.isSubagent || n++ === 0 };
  const { slices } = trafficOf(f, events);
  const sub = slices.find((s) => s.subagent === true);
  const main = slices.find((s) => s.subagent === false);
  assert.deepEqual([sub.calls, sub.share], [2, 1]);
  assert.deepEqual([main.calls, main.share], [1, 0.5]);
});
