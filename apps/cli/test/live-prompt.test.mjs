import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingestClaudeCode, createLiveAnalyzer } from "@optimaizr/core";
import { createLivePrompt, claudeSettingsRewriter, sdkOverrideRewriter } from "optimaizr";

const USAGE = {
  input_tokens: 4,
  output_tokens: 300,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 1_000,
};

function fixture(n = 60) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-prompt-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  const records = [];
  for (let i = 0; i < n; i++) {
    const mm = String(i % 60).padStart(2, "0");
    records.push({
      type: "assistant",
      timestamp: `2026-09-19T10:${mm}:00.000Z`,
      sessionId: "session-a",
      cwd: "/Users/someone/project",
      message: {
        id: `msg_${i}`,
        model: "claude-sonnet-5",
        usage: USAGE,
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }],
        stop_reason: "end_turn",
      },
    });
  }
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

/** A real model-fit recommendation, confident enough to be worth a prompt. */
async function recommendation() {
  const data = await ingestClaudeCode({ root: fixture() });
  const analyzer = createLiveAnalyzer({ minIntervalMs: 0 });
  const recs = [];
  for (const e of data.events) recs.push(...analyzer.push(e));
  recs.push(...analyzer.flush());

  const confident = recs.find(
    (r) => r.finding.rule === "model-fit" && r.finding.savings.confidence !== "low",
  );
  assert.ok(confident, "fixture must produce a confident model-fit recommendation");
  return { confident, provisional: recs.find((r) => r.finding.savings.confidence === "low") };
}

function harness(keys, over = {}) {
  const written = [];
  const queue = [...keys];
  const prompt = createLivePrompt({
    interactive: true,
    jevEnabled: false,
    dryRun: false,
    render: () => "PRINTED-NOT-PROMPTED",
    onExit: () => written.push("EXITED"),
    io: {
      read: async () => queue.shift() ?? "n",
      write: (line) => written.push(line),
    },
    ...over,
  });
  return { prompt, written, out: () => written.join("\n") };
}

test("the card shows the current and suggested models and the observed cost", async () => {
  const { confident } = await recommendation();
  const h = harness(["n"]);
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /optimAIzr/);
  assert.match(out, /This task looks suitable for a cheaper model\./);
  assert.match(out, /Current:\s+Sonnet 5/);
  assert.match(out, /Suggested:\s+Haiku 4\.5/);
  assert.match(out, /Observed cost:\s+\$/);
  assert.match(out, /\[Y\] Apply optimization/);
  assert.match(out, /\[N\] Continue/);
  assert.match(out, /\[D\] Why\?/);
});

test("Y does not claim to have applied anything when nothing can modify the request", async () => {
  const { confident } = await recommendation();
  const h = harness(["y"]);
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Not applied to that call/);
  assert.match(out, /no pre-request integration is installed/);
  assert.match(out, /Recorded\./);
  assert.match(out, /optimaizr verify model-fit/);
  // The word that would be a lie.
  assert.doesNotMatch(out, /Applied via/);
});

test("Y really applies when a pre-request integration exists", async () => {
  const { confident } = await recommendation();
  const calls = [];
  const rewriter = {
    kind: "test-rewriter",
    supports: (change) => change.kind === "swap-model",
    install: (change) => {
      calls.push(change);
      return { ok: true, detail: `future requests pinned to ${change.toModelId}` };
    },
  };

  const h = harness(["y"], { rewriter });
  h.prompt.offer(confident);
  await h.prompt.drain();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toModelId, "claude-haiku-4-5");
  const out = h.out();
  assert.match(out, /Applied via test-rewriter/);
  assert.match(out, /pinned to claude-haiku-4-5/);
  assert.doesNotMatch(out, /Not applied/);
});

test("a rewriter that fails is reported as a failure, not a success", async () => {
  const { confident } = await recommendation();
  const rewriter = {
    kind: "broken",
    supports: () => true,
    install: () => ({ ok: false, detail: "client already dispatched" }),
  };
  const h = harness(["y"], { rewriter });
  h.prompt.offer(confident);
  await h.prompt.drain();

  assert.match(h.out(), /Could not apply.*client already dispatched/s);
});

test("Y on Claude Code traffic says how to switch the session that is running", async () => {
  const { confident } = await recommendation();
  assert.deepEqual(
    [...new Set(confident.traffic.slices.map((s) => s.source))],
    ["claude-code"],
    "the recommendation knows where its traffic came from",
  );
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-")), "settings.json");
  process.env.OPTIMAIZR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-prompt-dir-"));

  const h = harness(["y"], {
    rewriters: [sdkOverrideRewriter(), claudeSettingsRewriter({ settingsPath })],
  });
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Applied.*via claude-code settings/);
  assert.match(out, /Now:.*type \/model haiku/);
  // Claude Code traffic must never become an SDK override.
  assert.doesNotMatch(out, /sdk wrapper/);
  assert.equal(fs.existsSync(path.join(process.env.OPTIMAIZR_DIR, "overrides.json")), false);
});

test("a declined change is recorded, not reported as a failure", async () => {
  const { confident } = await recommendation();
  const rewriter = {
    kind: "cautious",
    supports: () => true,
    install: () => ({ ok: false, declined: true, detail: "too little of the traffic" }),
  };
  const h = harness(["y"], { rewriter });
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Not applied.*too little of the traffic/s);
  assert.match(out, /Recorded\..*optimaizr verify model-fit/s);
  assert.doesNotMatch(out, /Could not apply/);
});

test("N dismisses without touching the request", async () => {
  const { confident } = await recommendation();
  const h = harness(["n"]);
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Continuing\./);
  assert.doesNotMatch(out, /Recorded\./);
  assert.doesNotMatch(out, /Applied/);
});

test("D explains, then returns to the same Y/N choice", async () => {
  const { confident } = await recommendation();
  const h = harness(["d", "n"]);
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Why optimAIzr flagged this/);
  assert.match(out, /Rule\s+model-fit/);
  assert.match(out, /Basis\s+estimated/);
  assert.match(out, /Confidence/);
  assert.match(out, /Not used\. This is a local rules-only detection\./);
  // Back to the choice, and the answer after it was honoured.
  assert.equal(h.written.filter((l) => l.includes("[Y/N/D]")).length, 2);
  assert.match(out, /Continuing\./);
});

test("D credits Jev when Jev actually judged the traffic", async () => {
  const { confident } = await recommendation();
  const judged = { ...confident, judged: { needsFrontierShare: 0.05, sampled: 26 } };
  const h = harness(["d", "n"], { jevEnabled: true });
  h.prompt.offer(judged);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Jev judged this traffic: 5%/);
  assert.match(out, /26 calls judged/);
  assert.match(out, /never prompts or outputs/);
});

test("with --jev on but no verdict, the explanation says so rather than implying one", async () => {
  const { confident } = await recommendation();
  const h = harness(["d", "n"], { jevEnabled: true });
  h.prompt.offer(confident);
  await h.prompt.drain();

  assert.match(h.out(), /Jev had no verdict for this traffic yet/);
});

test("the same rule and route is never raised twice", async () => {
  const { confident } = await recommendation();
  const h = harness(["n", "n", "n"]);
  h.prompt.offer(confident);
  h.prompt.offer(confident);
  h.prompt.offer({ ...confident, observedUsd: confident.observedUsd * 3 });
  await h.prompt.drain();

  const cards = h.written.filter((l) => l.includes("[Y] Apply optimization")).length;
  assert.equal(cards, 1, "a repeat of the same finding must not prompt again");
});

test("a provisional finding is printed, never prompted", async () => {
  const { provisional } = await recommendation();
  assert.ok(provisional, "fixture should produce a low-confidence recommendation first");

  const h = harness(["n"]);
  h.prompt.offer(provisional);
  await h.prompt.drain();

  assert.match(h.out(), /PRINTED-NOT-PROMPTED/);
  assert.doesNotMatch(h.out(), /\[Y\] Apply optimization/);
});

test("non-interactive prints and never blocks on a key", async () => {
  const { confident } = await recommendation();
  const h = harness([], { interactive: false });
  h.prompt.offer(confident);
  await h.prompt.drain();

  assert.match(h.out(), /PRINTED-NOT-PROMPTED/);
  assert.doesNotMatch(h.out(), /\[Y\/N\/D\]/);
});

test("--dry-run records nothing and says so", async () => {
  const { confident } = await recommendation();
  const h = harness(["y"], { dryRun: true });
  h.prompt.offer(confident);
  await h.prompt.drain();

  const out = h.out();
  assert.match(out, /Dry run: nothing was recorded\./);
  assert.doesNotMatch(out, /^\s*Recorded\./m);
});

test("an unrecognised key re-asks instead of guessing", async () => {
  const { confident } = await recommendation();
  const h = harness(["x", "n"]);
  h.prompt.offer(confident);
  await h.prompt.drain();

  assert.match(h.out(), /Press Y, N or D\./);
  assert.match(h.out(), /Continuing\./);
});

test("Ctrl-C inside a prompt exits rather than being read as an answer", async () => {
  const { confident } = await recommendation();
  const h = harness([""]);
  h.prompt.offer(confident);
  await h.prompt.drain();

  assert.ok(h.written.includes("EXITED"));
  assert.doesNotMatch(h.out(), /Recorded\./);
  assert.doesNotMatch(h.out(), /Continuing\./);
});

test("prompts are answered one at a time, never interleaved", async () => {
  const { confident } = await recommendation();
  const other = {
    ...confident,
    finding: { ...confident.finding, rule: "error-loops" },
    trigger: { ...confident.trigger, route: "other" },
  };

  const h = harness(["n", "n"]);
  h.prompt.offer(confident);
  h.prompt.offer(other); // queued while the first is open
  await h.prompt.drain();

  const cards = h.written.filter((l) => l.includes("[Y] Apply optimization"));
  assert.equal(cards.length, 2);
  // The second card must come after the first is resolved.
  const firstDone = h.written.findIndex((l) => l.includes("Continuing."));
  const secondCard = h.written.lastIndexOf(cards[1]);
  assert.ok(firstDone < secondCard, "the second prompt opened before the first was answered");
});

test("a finding Jev withheld is reported, never offered as a choice", async () => {
  const { confident } = await recommendation();
  const held = {
    ...confident,
    withheld: { by: "jev", needsFrontierShare: 0.82, sampled: 26 },
  };

  const h = harness([]); // no keys queued: prompting would hang the test
  h.prompt.offer(held);
  await h.prompt.drain();

  assert.match(h.out(), /PRINTED-NOT-PROMPTED/);
  assert.doesNotMatch(h.out(), /\[Y\] Apply optimization/);
  assert.doesNotMatch(h.out(), /\[Y\/N\/D\]/);
});
