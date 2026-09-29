import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accept, createLiveAnalyzer, ingestClaudeCode } from "@optimaizr/core";
import {
  wrap,
  withRoute,
  drain,
  readLedger,
  sdkOverrideRewriter,
  claudeSettingsRewriter,
  readOverrides,
  writeOverrides,
  removeOverrides,
} from "@optimaizr/local";

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-overrides-"));
  process.env.OPTIMAIZR_DIR = dir;
  return dir;
}

/** A stand-in Anthropic client that remembers the model each request asked for. */
function recordingClient({ reject } = {}) {
  const sent = [];
  return {
    sent,
    messages: {
      async create(params) {
        sent.push(params.model);
        if (reject?.(params)) {
          const err = new Error(`model ${params.model} does not support this`);
          err.status = 400;
          throw err;
        }
        return {
          id: `msg_${sent.length}`,
          model: params.model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  };
}

const override = (over = {}) => ({
  rule: "model-fit",
  project: "svc",
  route: "classify",
  from: "claude-sonnet-5",
  to: "claude-haiku-4-5",
  at: "2026-09-23T10:00:00.000Z",
  ...over,
});

/** A model-fit finding over the given slices of traffic. */
function finding({ share = 1, to = "claude-haiku-4-5", targetFor } = {}) {
  return {
    rule: "model-fit",
    risk: "needs-verification",
    verification: "replay",
    affected: {
      share,
      calls: 40,
      models: ["claude-sonnet-5"],
      projects: [],
      routes: [],
      sampleEventIds: [],
    },
    candidate: {
      kind: "swap-model",
      to,
      ...(targetFor ? { targetFor } : {}),
      matches: () => true,
      description: "swap",
    },
    fix: "route mechanical steps to Haiku",
    savings: {},
  };
}

const slice = (over = {}) => ({
  source: "sdk",
  project: "svc",
  route: "classify",
  model: "claude-sonnet-5",
  calls: 30,
  ...over,
});

// ---------------------------------------------------------------- wrap()

test("an accepted override reaches the running client's very next request", async () => {
  useTempStore();
  const raw = recordingClient();
  const client = wrap(raw, { service: "svc" });
  const params = { model: "claude-sonnet-5", messages: [] };

  await withRoute("classify", () => client.messages.create(params));
  writeOverrides([override()]);
  const res = await withRoute("classify", () => client.messages.create(params));

  assert.deepEqual(raw.sent, ["claude-sonnet-5", "claude-haiku-4-5"]);
  assert.equal(res.model, "claude-haiku-4-5");
  assert.equal(params.model, "claude-sonnet-5", "the caller's params must never be mutated");

  // The ledger records what was really billed, not what the code asked for.
  await drain();
  const { events } = await readLedger();
  assert.deepEqual(
    events.map((e) => e.model),
    ["claude-sonnet-5", "claude-haiku-4-5"],
  );
});

test("an override touches only the service, route and model it was accepted for", async () => {
  useTempStore();
  writeOverrides([override()]);
  const raw = recordingClient();
  const svc = wrap(raw, { service: "svc" });
  const other = wrap(raw, { service: "other-svc" });

  await withRoute("summarise", () => svc.messages.create({ model: "claude-sonnet-5" }));
  await svc.messages.create({ model: "claude-sonnet-5" }); // no route at all
  await withRoute("classify", () => svc.messages.create({ model: "claude-opus-5" }));
  await withRoute("classify", () => other.messages.create({ model: "claude-sonnet-5" }));

  assert.deepEqual(raw.sent, [
    "claude-sonnet-5",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-sonnet-5",
  ]);
});

test("undo reverts the next request the same way accepting applied it", async () => {
  useTempStore();
  writeOverrides([override(), override({ rule: "other-rule", route: "tag" })]);
  const raw = recordingClient();
  const client = wrap(raw, { service: "svc" });

  await withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" }));
  const removed = removeOverrides("model-fit");
  await withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" }));

  assert.equal(removed.length, 1);
  assert.deepEqual(raw.sent, ["claude-haiku-4-5", "claude-sonnet-5"]);
  assert.deepEqual(
    readOverrides().map((o) => o.rule),
    ["other-rule"],
    "only the named rule's overrides are removed",
  );
});

test("a model the provider rejects falls back to the original request, once", async () => {
  useTempStore();
  writeOverrides([override({ project: "fallback-svc" })]);
  const raw = recordingClient({ reject: (p) => p.model === "claude-haiku-4-5" });
  const client = wrap(raw, { service: "fallback-svc" });

  const res = await withRoute("classify", () =>
    client.messages.create({ model: "claude-sonnet-5" }),
  );
  await withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" }));

  assert.equal(res.model, "claude-sonnet-5", "the caller gets a normal response");
  // Tried once, refused, and never tried again in this process.
  assert.deepEqual(raw.sent, ["claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-5"]);
});

test("errors that are not about the model propagate without a retry", async () => {
  useTempStore();
  writeOverrides([override({ project: "limited-svc" })]);
  const sent = [];
  const client = wrap(
    {
      messages: {
        async create(params) {
          sent.push(params.model);
          const err = new Error("rate limited");
          err.status = 429;
          throw err;
        },
      },
    },
    { service: "limited-svc" },
  );

  await assert.rejects(
    () => withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" })),
    (err) => err.status === 429,
  );
  assert.deepEqual(sent, ["claude-haiku-4-5"], "a retry would double the bill for a 429");
});

test("overrides: false sends every request exactly as written", async () => {
  useTempStore();
  writeOverrides([override()]);
  const raw = recordingClient();
  const client = wrap(raw, { service: "svc", overrides: false });

  await withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" }));
  assert.deepEqual(raw.sent, ["claude-sonnet-5"]);
});

test("a corrupt overrides file changes nothing", async () => {
  const dir = useTempStore();
  fs.writeFileSync(path.join(dir, "overrides.json"), "{ not json");
  const raw = recordingClient();
  const client = wrap(raw, { service: "svc" });

  await withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" }));
  assert.deepEqual(raw.sent, ["claude-sonnet-5"]);
});

// ---------------------------------------------------------------- the SDK rewriter

test("the SDK rewriter writes one override per SDK slice and ignores agent traffic", () => {
  useTempStore();
  const f = finding();
  const outcome = accept(f, {
    rewriters: [sdkOverrideRewriter()],
    traffic: {
      slices: [
        slice(),
        slice({ source: "claude-code", project: "/Users/x/repo", route: undefined }),
      ],
      shareBySource: { sdk: 1, "claude-code": 1 },
    },
  });

  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.via, "sdk wrapper");
  assert.match(outcome.detail, /svc\/classify: Sonnet 5 -> Haiku 4\.5/);
  assert.match(outcome.detail, /next request, no restart/);
  assert.match(outcome.detail, /optimaizr undo model-fit/);
  assert.deepEqual(
    readOverrides().map((o) => [o.project, o.route, o.from, o.to]),
    [["svc", "classify", "claude-sonnet-5", "claude-haiku-4-5"]],
  );
});

test("each provider's traffic moves to its own provider's model, or not at all", () => {
  useTempStore();
  const f = finding({
    targetFor: (m) => (m.startsWith("gpt") ? "gpt-5-nano" : "claude-haiku-4-5"),
  });
  accept(f, {
    rewriters: [sdkOverrideRewriter()],
    traffic: {
      slices: [slice(), slice({ model: "gpt-5", route: "tag" })],
      shareBySource: { sdk: 1 },
    },
  });

  assert.deepEqual(
    readOverrides().map((o) => [o.from, o.to]),
    [
      ["claude-sonnet-5", "claude-haiku-4-5"],
      ["gpt-5", "gpt-5-nano"],
    ],
  );
});

test("accepting the same slot again replaces its override instead of stacking", () => {
  useTempStore();
  writeOverrides([override({ to: "claude-opus-5" }), override({ route: "tag" })]);
  accept(finding(), {
    rewriters: [sdkOverrideRewriter()],
    traffic: { slices: [slice()], shareBySource: { sdk: 1 } },
  });
  assert.deepEqual(
    readOverrides().map((o) => [o.route, o.to]),
    [
      ["tag", "claude-haiku-4-5"],
      ["classify", "claude-haiku-4-5"],
    ],
  );
});

test("a dry run writes no override", () => {
  useTempStore();
  const outcome = accept(finding(), {
    rewriters: [sdkOverrideRewriter()],
    traffic: { slices: [slice()], shareBySource: { sdk: 1 } },
    dryRun: true,
  });
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(readOverrides(), []);
});

// ---------------------------------------------------------------- routing between rewriters

test("a finding over SDK traffic never touches Claude Code's settings", () => {
  useTempStore();
  const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-")), "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ model: "opus" }));

  const outcome = accept(finding(), {
    rewriters: [sdkOverrideRewriter(), claudeSettingsRewriter({ settingsPath: settings })],
    traffic: { slices: [slice()], shareBySource: { sdk: 1 } },
  });

  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.via, "sdk wrapper");
  assert.equal(outcome.also, undefined);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).model, "opus");
});

test("mixed traffic applies each rewriter to its own slice and reports both", () => {
  useTempStore();
  const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-")), "settings.json");

  const outcome = accept(finding(), {
    rewriters: [sdkOverrideRewriter(), claudeSettingsRewriter({ settingsPath: settings })],
    traffic: {
      slices: [slice(), slice({ source: "claude-code", project: "/repo", route: undefined })],
      shareBySource: { sdk: 1, "claude-code": 0.9 },
    },
  });

  assert.equal(outcome.kind, "applied");
  assert.equal(outcome.via, "sdk wrapper");
  assert.deepEqual(
    outcome.also.map((r) => [r.via, r.applied]),
    [["claude-code settings", true]],
  );
  assert.match(outcome.now, /\/model haiku/);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).model, "haiku");
});

test("Codex traffic is recorded, with the /model step that switches it now", () => {
  useTempStore();
  const outcome = accept(finding({ to: "gpt-5-nano" }), {
    rewriters: [sdkOverrideRewriter(), claudeSettingsRewriter({ settingsPath: "/nonexistent" })],
    traffic: {
      slices: [slice({ source: "codex", project: "/repo", route: undefined, model: "gpt-5" })],
      shareBySource: { codex: 1 },
    },
  });

  assert.equal(outcome.kind, "queued");
  assert.match(outcome.reason, /Codex reads its model when a session starts/);
  assert.match(outcome.now, /\/model in Codex/);
  assert.equal(outcome.next, "optimaizr verify model-fit");
});

// ---------------------------------------------------------------- end to end

test("Y on a live finding moves the wrapped app's next call to the cheaper model", async () => {
  useTempStore();

  // Real transcript-shaped traffic, relabelled as one SDK service and route,
  // so the live analyzer's own traffic breakdown drives the rewriter.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-e2e-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: `2026-09-19T10:${String(i).padStart(2, "0")}:00.000Z`,
        sessionId: "s",
        cwd: "/Users/someone/project",
        message: {
          id: `msg_${i}`,
          model: "claude-sonnet-5",
          usage: {
            input_tokens: 4,
            output_tokens: 300,
            cache_read_input_tokens: 50_000,
            cache_creation_input_tokens: 1_000,
          },
          content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } }],
          stop_reason: "end_turn",
        },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, "s.jsonl"), lines.join("\n") + "\n");
  const data = await ingestClaudeCode({ root });

  const analyzer = createLiveAnalyzer({ minIntervalMs: 0 });
  const recs = [];
  for (const e of data.events) {
    recs.push(...analyzer.push({ ...e, source: "sdk", project: "svc", route: "classify" }));
  }
  recs.push(...analyzer.flush());
  const rec = recs.find((r) => r.finding.rule === "model-fit");
  assert.ok(rec, "fixture must produce a model-fit recommendation");
  assert.deepEqual(
    rec.traffic.slices.map((s) => [s.source, s.project, s.route, s.model]),
    [["sdk", "svc", "classify", "claude-sonnet-5"]],
  );

  const outcome = accept(rec.finding, {
    rewriters: [sdkOverrideRewriter()],
    traffic: rec.traffic,
  });
  assert.equal(outcome.kind, "applied");

  const raw = recordingClient();
  const client = wrap(raw, { service: "svc" });
  await withRoute("classify", () => client.messages.create({ model: "claude-sonnet-5" }));
  assert.deepEqual(raw.sent, [rec.finding.candidate.to]);
  assert.notEqual(raw.sent[0], "claude-sonnet-5");
});
