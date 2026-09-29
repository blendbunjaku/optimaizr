import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accept, proposedChange } from "@optimaizr/core";
import { claudeSettingsRewriter, settingsAliasFor } from "@optimaizr/local";

function settingsFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
  const file = path.join(dir, "settings.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** A model-fit finding covering `share` of spend. */
function finding(share = 1, to = "claude-haiku-4-5") {
  return {
    rule: "model-fit",
    risk: "needs-verification",
    verification: "replay",
    affected: {
      share,
      calls: 40,
      models: ["claude-opus-5"],
      projects: [],
      routes: [],
      sampleEventIds: [],
    },
    candidate: { kind: "swap-model", to, matches: () => true, description: "swap" },
    fix: "route mechanical steps to Haiku",
    savings: {},
  };
}

test("model ids are translated to the aliases Claude Code expects", () => {
  assert.equal(settingsAliasFor("claude-haiku-4-5"), "haiku");
  assert.equal(settingsAliasFor("claude-sonnet-5"), "sonnet");
  assert.equal(settingsAliasFor("claude-opus-5"), "opus");
  // An id we don't recognise is written through, never guessed at.
  assert.equal(settingsAliasFor("some-future-model"), "some-future-model");
});

test("it writes the model and keeps every other setting", () => {
  const file = settingsFile(
    JSON.stringify({ agentPushNotifEnabled: true, model: "opus", other: { deep: 1 } }),
  );
  const r = claudeSettingsRewriter({ settingsPath: file });
  const f = finding();

  assert.equal(r.supports(proposedChange(f), f), true);
  const res = r.install(proposedChange(f), f);

  assert.equal(res.ok, true);
  const after = read(file);
  assert.equal(after.model, "haiku");
  assert.equal(after.agentPushNotifEnabled, true, "unrelated settings must survive");
  assert.deepEqual(after.other, { deep: 1 });
  // The user is told what moved and how to put it back.
  assert.match(res.detail, /"opus" -> "haiku"/);
  assert.match(res.detail, /set "model": "opus" to undo/);
  assert.match(res.detail, /next session, not the one running/);
  // And how to reach the session that is running, which the file cannot.
  assert.match(res.now, /type \/model haiku in the running Claude Code session/);
});

test("it declines a global change when the finding covers little of the spend", () => {
  const file = settingsFile(JSON.stringify({ model: "opus" }));
  const r = claudeSettingsRewriter({ settingsPath: file });
  const f = finding(0.09);

  const res = r.install(proposedChange(f), f);
  assert.equal(res.ok, false);
  assert.equal(res.declined, true, "a judgement call, not a breakage");
  assert.match(res.detail, /only 9% of your Claude Code spend/);
  assert.match(res.detail, /per-agent override/);
  // And it must not have touched the file.
  assert.equal(read(file).model, "opus");
});

test("a declined global change records the decision and hands over the next command", () => {
  const file = settingsFile(JSON.stringify({ model: "opus" }));
  const f = finding(0.09);

  const outcome = accept(f, { rewriter: claudeSettingsRewriter({ settingsPath: file }) });
  assert.equal(outcome.kind, "queued", "a decline is not a failure");
  assert.equal(outcome.declined, true);
  assert.match(outcome.reason, /only 9% of your Claude Code spend/);
  assert.equal(outcome.next, "optimaizr verify model-fit");
  assert.equal(read(file).model, "opus");
});

test("the threshold is judged against Claude Code's own spend when it is known", () => {
  const file = settingsFile(JSON.stringify({ model: "opus" }));
  // 30% of all spend, but 95% of what Claude Code itself spent.
  const f = finding(0.3);
  const traffic = {
    slices: [{ source: "claude-code", project: "/repo", model: "claude-opus-5", calls: 40 }],
    shareBySource: { "claude-code": 0.95 },
  };

  const outcome = accept(f, {
    rewriter: claudeSettingsRewriter({ settingsPath: file }),
    traffic,
  });
  assert.equal(outcome.kind, "applied");
  assert.equal(read(file).model, "haiku");
});

test("it leaves Claude Code alone when none of the traffic came from it", () => {
  const r = claudeSettingsRewriter({ settingsPath: settingsFile("{}") });
  const f = finding();
  const sdkOnly = {
    slices: [{ source: "sdk", project: "svc", model: "claude-opus-5", calls: 40 }],
    shareBySource: { sdk: 1 },
  };
  assert.equal(r.supports(proposedChange(f, sdkOnly), f), false);
});

test("it does not claim a change it did not make", () => {
  const file = settingsFile(JSON.stringify({ model: "haiku" }));
  const r = claudeSettingsRewriter({ settingsPath: file });
  const f = finding();

  const res = r.install(proposedChange(f), f);
  assert.equal(res.ok, false);
  assert.equal(res.declined, true);
  assert.match(res.detail, /already sets model to "haiku"/);
  // The file is right, so a session on another model can only be reached by hand.
  assert.match(res.now, /\/model haiku/);
});

test("a settings file it cannot parse is left alone", () => {
  const file = settingsFile("{ not json");
  const r = claudeSettingsRewriter({ settingsPath: file });
  const f = finding();

  const res = r.install(proposedChange(f), f);
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "the file must be untouched");
});

test("a missing settings file is created", () => {
  const file = settingsFile(undefined);
  const r = claudeSettingsRewriter({ settingsPath: file });
  const f = finding();

  const res = r.install(proposedChange(f), f);
  assert.equal(res.ok, true);
  assert.equal(read(file).model, "haiku");
  assert.match(res.detail, /remove the "model" key to undo/);
});

test("it only supports swaps to models Claude Code can actually run", () => {
  const r = claudeSettingsRewriter({ settingsPath: settingsFile("{}") });
  const openai = finding(1, "gpt-5-nano");
  assert.equal(r.supports(proposedChange(openai), openai), false);

  const noCandidate = { ...finding(), candidate: undefined };
  assert.equal(r.supports(proposedChange(noCandidate), noCandidate), false);
});

test("accept() reports a real application, not a queued one", () => {
  const file = settingsFile(JSON.stringify({ model: "opus" }));
  const f = finding();

  const outcome = accept(f, { rewriter: claudeSettingsRewriter({ settingsPath: file }) });
  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.via, "claude-code settings");
  assert.equal(read(file).model, "haiku");
});

test("a dry run never writes, even with a rewriter attached", () => {
  const file = settingsFile(JSON.stringify({ model: "opus" }));
  const f = finding();

  const outcome = accept(f, {
    rewriter: claudeSettingsRewriter({ settingsPath: file }),
    dryRun: true,
  });

  assert.equal(outcome.kind, "queued", "a dry run must not apply");
  assert.equal(read(file).model, "opus", "the file must be untouched");
});
