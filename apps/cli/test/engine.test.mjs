import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingestClaudeCode } from "@optimaizr/core";
import { findWaste, RULE_COUNT } from "@optimaizr/core";
import { classify } from "@optimaizr/core";
import { buildDrillTree, drillTo } from "@optimaizr/core";
import { toRecommendations, simulate } from "@optimaizr/core";
import { registerModels, resetModels } from "@optimaizr/core";
import { ingest, listAdapters, listProviders } from "@optimaizr/core";
import "@optimaizr/local";

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-engine-"));
  process.env.OPTIMAIZR_DIR = dir;
  return dir;
}

function writeFixture(records, name = "session-a") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-eng-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

const BASE_USAGE = {
  input_tokens: 4,
  output_tokens: 300,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 1_000,
};

function assistant({
  id,
  content,
  usage = BASE_USAGE,
  ts,
  session = "session-a",
  model = "claude-sonnet-5",
}) {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: session,
    cwd: "/Users/someone/project",
    message: { id, model, usage, content, stop_reason: "end_turn" },
  };
}

const bash = (i) => [
  { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } },
];

/* ------------------------------------------------------------------ *
 * Workload classification
 * ------------------------------------------------------------------ */

test("classification reads call shape, and says so by being shape-only", () => {
  const base = { thinkingTokens: 0, outputTokens: 100, tools: [] };
  assert.equal(classify({ ...base, thinkingTokens: 800 }), "reasoning");
  assert.equal(classify({ ...base, tools: [{}, {}] }), "tool-orchestration");
  assert.equal(classify({ ...base, outputTokens: 2000 }), "generation");
  assert.equal(classify(base), "mechanical");
  // Reasoning wins over output size — the expensive signal takes precedence.
  assert.equal(classify({ ...base, thinkingTokens: 900, outputTokens: 5000 }), "reasoning");
});

/* ------------------------------------------------------------------ *
 * Evidence classes
 * ------------------------------------------------------------------ */

test("every finding declares how its number was derived", async () => {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push(
      assistant({
        id: `m${i}`,
        ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
        content: bash(i),
      }),
    );
  }
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const findings = findWaste(data);
  assert.ok(findings.length > 0);

  for (const f of findings) {
    const kind = f.savings.evidence.kind;
    assert.ok(
      ["measured", "inferred", "estimated"].includes(kind),
      `${f.rule} must declare an evidence class, got ${kind}`,
    );
    assert.ok(f.savings.evidence.basis.length > 15, `${f.rule} must explain its basis`);
  }
});

test("a model swap is never labelled measured, because it assumes behaviour", async () => {
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(
      assistant({
        id: `m${i}`,
        ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
        content: bash(i),
      }),
    );
  }
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const swap = findWaste(data).find((f) => f.rule === "model-fit");
  assert.ok(swap);
  assert.equal(swap.savings.evidence.kind, "estimated");
});

/* ------------------------------------------------------------------ *
 * New detectors
 * ------------------------------------------------------------------ */

test("spend concentration is found, and claims no savings", async () => {
  const records = [];
  // Two very expensive sessions, plus a long tail of cheap ones.
  for (let i = 0; i < 30; i++) {
    records.push(
      assistant({
        id: `big${i}`,
        session: i < 15 ? "whale-1" : "whale-2",
        ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
        usage: { ...BASE_USAGE, cache_read_input_tokens: 400_000 },
        content: bash(i),
      }),
    );
  }
  for (let i = 0; i < 40; i++) {
    records.push(
      assistant({
        id: `small${i}`,
        session: `tail-${i}`,
        ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T11:00:00.000Z`,
        usage: { input_tokens: 10, output_tokens: 5 },
        content: bash(i),
      }),
    );
  }

  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const finding = findWaste(data).find((f) => f.rule === "spend-concentration");

  assert.ok(finding, "expected a concentration finding");
  assert.equal(finding.advisory, true, "concentration is a targeting signal, not waste");
  assert.equal(finding.savings.windowUsd, 0, "it must not claim recoverable savings");
  assert.equal(finding.savings.evidence.kind, "measured");
});

test("an unexplained cost spike is flagged; one explained by volume is not", async () => {
  const steady = [];
  for (let day = 1; day <= 8; day++) {
    for (let i = 0; i < 10; i++) {
      steady.push(
        assistant({
          id: `s${day}-${i}`,
          ts: `2026-09-0${day}T10:0${i}:00.000Z`,
          usage: { input_tokens: 100, output_tokens: 100 },
          content: bash(i),
        }),
      );
    }
  }

  // Same call count, far more expensive per call — volume cannot explain it.
  const spike = [...steady];
  for (let i = 0; i < 10; i++) {
    spike.push(
      assistant({
        id: `spike-${i}`,
        ts: `2026-09-09T10:0${i}:00.000Z`,
        usage: { input_tokens: 500_000, output_tokens: 20_000 },
        content: bash(i),
      }),
    );
  }
  const spikeData = await ingestClaudeCode({ root: writeFixture(spike) });
  const flagged = findWaste(spikeData).find((f) => f.rule === "cost-spike");
  assert.ok(flagged, "a per-call cost explosion must be surfaced");
  assert.equal(flagged.advisory, true, "a spike may be legitimate, so it claims no savings");
  assert.equal(flagged.savings.evidence.kind, "inferred");

  // Same per-call cost, many more calls — volume explains it, so stay quiet.
  const busy = [...steady];
  for (let i = 0; i < 120; i++) {
    busy.push(
      assistant({
        id: `busy-${i}`,
        ts: `2026-09-09T10:00:00.000Z`,
        usage: { input_tokens: 100, output_tokens: 100 },
        content: bash(i),
      }),
    );
  }
  const busyData = await ingestClaudeCode({ root: writeFixture(busy) });
  const quiet = findWaste(busyData).find((f) => f.rule === "cost-spike");
  assert.equal(quiet, undefined, "a busy day is not an anomaly");
});

test("oversized outputs are detected and priced at the output rate", async () => {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push(
      assistant({
        id: `m${i}`,
        ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
        usage: { input_tokens: 100, output_tokens: i < 35 ? 200 : 40_000 },
        content: [{ type: "text", text: "x" }],
      }),
    );
  }
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const finding = findWaste(data).find((f) => f.rule === "oversized-output");

  assert.ok(finding, "expected an oversized-output finding");
  assert.equal(finding.savings.evidence.kind, "measured");
  assert.ok(finding.savings.windowUsd > 0);
});

test("a truncated response is called out as truncated", async () => {
  const records = [];
  for (let i = 0; i < 40; i++) {
    const r = assistant({
      id: `m${i}`,
      ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
      usage: { input_tokens: 100, output_tokens: i < 35 ? 200 : 40_000 },
      content: [{ type: "text", text: "x" }],
    });
    if (i >= 35) r.message.stop_reason = "max_tokens";
    records.push(r);
  }
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const finding = findWaste(data).find((f) => f.rule === "oversized-output");
  assert.ok(finding.detail.includes("max_tokens"), "truncation must be surfaced, it is pure waste");
});

/* ------------------------------------------------------------------ *
 * Drill-down
 * ------------------------------------------------------------------ */

test("the drill tree reconciles with total spend at every level", async () => {
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(
      assistant({
        id: `m${i}`,
        ts: `2026-09-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
        model: i % 2 === 0 ? "claude-sonnet-5" : "claude-opus-5",
        content: bash(i),
      }),
    );
  }
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const tree = buildDrillTree(data);

  const sumOf = (nodes) => nodes.reduce((s, n) => s + n.costUsd, 0);
  assert.ok(Math.abs(sumOf(tree.children) - tree.totalUsd) < 1e-9, "providers sum to total");

  for (const provider of tree.children) {
    assert.ok(
      Math.abs(sumOf(provider.children) - provider.costUsd) < 1e-9,
      "models sum to their provider",
    );
    for (const model of provider.children) {
      assert.ok(
        Math.abs(sumOf(model.children) - model.costUsd) < 1e-9,
        "projects sum to their model",
      );
    }
  }

  // Shares are of the parent, so each level's shares sum to 1.
  const shareSum = tree.children.reduce((s, n) => s + n.shareOfParent, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test("drilling to a path narrows to that subtree", async () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(
      assistant({ id: `m${i}`, ts: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`, content: bash(i) }),
    );
  }
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const tree = buildDrillTree(data);

  const node = drillTo(tree, ["anthropic", "claude-sonnet-5"]);
  assert.ok(node);
  assert.equal(node.level, "model");
  assert.ok(node.costUsd > 0 && node.costUsd <= tree.totalUsd);

  assert.equal(drillTo(tree, ["anthropic", "no-such-model"]), null);
});

/* ------------------------------------------------------------------ *
 * Recommendations
 * ------------------------------------------------------------------ */

test("advisories never become recommendations", async (t) => {
  // The only advisory rule is pricing-change, which needs a model whose rate
  // actually moved. Sonnet 5's announced September 2026 increase was
  // cancelled, so no shipped model has two rate cards; a fixture supplies one.
  registerModels([
    {
      id: "test-raised-model",
      label: "Raised",
      provider: "anthropic",
      tier: "balanced",
      rates: [
        {
          from: "2026-02-05",
          until: "2026-08-31",
          inputPerM: 2,
          outputPerM: 10,
          label: "introductory pricing",
        },
        { from: "2026-09-01", inputPerM: 3, outputPerM: 15 },
      ],
      contextTokens: 200_000,
      maxOutputTokens: 8_192,
      capabilities: ["tools", "caching"],
      bestFor: "test fixture",
    },
  ]);
  t.after(resetModels);

  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(
      assistant({
        id: `p${i}`,
        model: "test-raised-model",
        ts: `2026-08-${String((i % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
        content: bash(i),
      }),
    );
  }
  useTempStore();
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const findings = findWaste(data);
  const recs = toRecommendations(findings, data.events.length);

  assert.ok(
    findings.some((f) => f.advisory),
    "fixture should produce an advisory",
  );
  assert.ok(
    !recs.some((r) => findings.find((f) => f.rule === r.rule)?.advisory),
    "an advisory has nothing to accept, so it is not a recommendation",
  );
  for (const r of recs) {
    assert.ok(r.action.length > 0);
    assert.ok(r.rationale.endsWith("."), "rationale reads as a sentence");
    assert.equal(r.status, "new");
    assert.ok(r.actions.includes("view-affected"));
  }
});

test("a behavioural recommendation offers verify; a safe one does not", async () => {
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(
      assistant({ id: `m${i}`, ts: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`, content: bash(i) }),
    );
  }
  useTempStore();
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const recs = toRecommendations(findWaste(data), data.events.length);

  const swap = recs.find((r) => r.id === "model-fit");
  assert.ok(swap);
  assert.ok(swap.actions.includes("verify"), "a model swap must be verifiable before applying");
  assert.ok(swap.action.startsWith("Switch eligible requests"));
});

/* ------------------------------------------------------------------ *
 * Simulation — regression for a real bug
 * ------------------------------------------------------------------ */

test("simulation operates on exactly the calls the finding counted", async () => {
  // Mix calls that fit the cheaper model's context with calls that do not.
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(
      assistant({
        id: `fits${i}`,
        ts: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`,
        usage: { ...BASE_USAGE, cache_read_input_tokens: 50_000 },
        content: bash(i),
      }),
    );
  }
  for (let i = 0; i < 20; i++) {
    records.push(
      assistant({
        id: `toobig${i}`,
        ts: `2026-09-0${(i % 9) + 1}T11:00:00.000Z`,
        // Beyond Haiku's 200K window, so model-fit must exclude these.
        usage: { ...BASE_USAGE, cache_read_input_tokens: 500_000 },
        content: bash(i),
      }),
    );
  }

  useTempStore();
  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const findings = findWaste(data);
  const finding = findings.find((f) => f.rule === "model-fit");
  assert.ok(finding, "expected model-fit");

  const rec = toRecommendations(findings, data.events.length).find((r) => r.id === "model-fit");
  const sim = simulate(rec, finding, data.events, data.window.days);

  // The bug: the candidate predicate was looser than the rule's eligibility,
  // so simulate counted calls the finding had excluded and the money diverged.
  assert.equal(
    sim.matchedCalls,
    finding.affected.calls,
    "simulate must match the finding's own call count",
  );
  assert.ok(
    Math.abs(sim.shifts.reduce((s, sh) => s + sh.from, 0) - finding.savings.currentUsd) < 1e-9,
    "per-model current costs must sum to the finding's current cost",
  );
  assert.ok(
    Math.abs(sim.shifts.reduce((s, sh) => s + sh.to, 0) - finding.savings.optimizedUsd) < 1e-9,
    "per-model optimised costs must sum to the finding's optimised cost",
  );
  assert.ok(sim.caveat.includes("verify"), "a behavioural simulation must point at verification");
});

/* ------------------------------------------------------------------ *
 * Provider registry
 * ------------------------------------------------------------------ */

test("adapters are registered and readable through the registry", async () => {
  const providers = listProviders();
  assert.ok(providers.some((p) => p.id === "anthropic"));
  assert.ok(providers[0].cachePolicy.read === 0.1);

  const adapters = listAdapters();
  assert.ok(adapters.length >= 3, "transcripts, ledger and file import");
  assert.ok(adapters.every((a) => typeof a.canRead === "function"));
});

test("ingest merges adapters and never throws on a bad source", async () => {
  useTempStore();
  const records = [
    assistant({ id: "m1", ts: "2026-09-01T10:00:00.000Z", content: bash(1) }),
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "c1",
      timestamp: "2026-09-01T10:01:00.000Z",
      sessionId: "session-a",
      compactMetadata: { trigger: "manual", preTokens: 90_000, durationMs: 30_000 },
    },
  ];
  const root = writeFixture(records);

  const data = await ingest([
    { kind: "local-transcripts", root },
    { kind: "file", path: "/definitely/not/a/real/file.csv" },
  ]);

  assert.equal(data.events.length, 1, "the good source still produced events");
  assert.deepEqual(
    data.compactions.map((c) => [c.trigger, c.preTokens, c.durationMs, c.midTask]),
    [["manual", 90_000, 30_000, false]],
  );
  assert.ok(
    data.failures.some((w) => w.includes("Usage export")),
    "the bad source produced a failure, not a crash",
  );
});

test("the rule registry is non-empty and every rule is wired in", () => {
  assert.ok(RULE_COUNT >= 12, `expected the full detector set, got ${RULE_COUNT}`);
});
