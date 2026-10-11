import { test } from "node:test";
import assert from "node:assert/strict";

import { findWaste, renderProfile, buildProfile, summarize } from "@optimaizr/core";
import { load, read, transcript } from "./fixtures/transcripts.mjs";

/**
 * Everything Claude Code loads before the first message (MCP servers, agents,
 * skills, memory files) is part of every call after it. The heavy-start rule
 * takes each project's smallest recent start as its setup and prices what sits
 * above a usual 30K start.
 */

/** A conversation whose first call carries `start` tokens, then `calls` more calls. */
function conversation(start, calls = 20) {
  const script = [{ prompt: "fix the login bug" }, { out: 300, ctx: start }];
  for (let i = 0; i < calls; i++) {
    script.push({ tools: [read(`/w/a${i}.ts`)], out: 300, ctx: start + 5_000 + i * 2_000 });
  }
  return script;
}

const rule = (findings, name) => findings.find((f) => f.rule === name);

test("conversations that all start heavy are a setup worth a look", async () => {
  const data = await load({
    s1: transcript("s1", conversation(120_000)),
    s2: transcript("s2", conversation(125_000)),
    s3: transcript("s3", conversation(130_000)),
  });
  const finding = rule(findWaste(data), "heavy-start");
  assert.ok(finding, "three conversations from 120K are a setup, not an accident");
  assert.equal(finding.tier, "test", "what loads isn't recorded, so it is up to");
  assert.match(finding.title, /^Conversations in \/w start at 120\.5K before any work$/);
  assert.match(
    finding.detail,
    /3 conversations in \/w started at 120\.5K or more, where a usual start is about 30(\.0)?K/,
  );
  assert.match(finding.fix, /\/context/);
  assert.match(finding.fix, /\/mcp/);
  assert.equal(finding.affected.calls, 63);

  // 90,510 above a usual start, read from cache at Opus 5.5's $0.20 a million, on 63 calls.
  assert.ok(Math.abs(finding.savings.windowUsd - (63 * 90_510 * 0.2) / 1e6) < 1e-9);

  const summary = summarize(data);
  const profile = buildProfile(data, summary, findWaste(data));
  assert.match(renderProfile(profile), /Heavy start/);
});

test("one heavy start among light ones is a resumed conversation, not the setup", async () => {
  const data = await load({
    s1: transcript("s1", conversation(32_000)),
    s2: transcript("s2", conversation(150_000)),
    s3: transcript("s3", conversation(33_000)),
  });
  assert.equal(rule(findWaste(data), "heavy-start"), undefined);
});

test("two heavy conversations are not a habit yet, and a normal start is never flagged", async () => {
  const two = await load({
    s1: transcript("s1", conversation(120_000)),
    s2: transcript("s2", conversation(120_000)),
  });
  assert.equal(rule(findWaste(two), "heavy-start"), undefined);

  const normal = await load({
    s1: transcript("s1", conversation(45_000)),
    s2: transcript("s2", conversation(45_000)),
    s3: transcript("s3", conversation(45_000)),
  });
  assert.equal(rule(findWaste(normal), "heavy-start"), undefined, "under 60K is a normal start");
});
