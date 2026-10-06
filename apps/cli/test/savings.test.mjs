import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingestClaudeCode } from "@optimaizr/core";
import {
  analyze,
  findWaste,
  recoverableMonthly,
  recoverableAnnual,
  recoverableWindow,
  savingsOverlap,
  CONFIDENCE_RANK,
} from "@optimaizr/core";
import { registerModels, resetModels } from "@optimaizr/core";
import { summarize } from "@optimaizr/core";

const USAGE = {
  input_tokens: 4,
  output_tokens: 300,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 1_000,
};

function writeFixture(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-savings-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

function assistant({ id, content, usage = USAGE, ts, model = "claude-sonnet-5" }) {
  return {
    type: "assistant",
    timestamp: ts,
    sessionId: "session-a",
    cwd: "/Users/someone/project",
    message: { id, model, usage, content, stop_reason: "end_turn" },
  };
}

/** Mechanical traffic: no reasoning, short output, one tool. */
function mechanicalFixture(n = 40) {
  const records = [];
  for (let i = 0; i < n; i++) {
    const day = String((i % 20) + 1).padStart(2, "0");
    records.push(
      assistant({
        id: `msg_${i}`,
        ts: `2026-09-${day}T10:00:00.000Z`,
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }],
      }),
    );
  }
  return writeFixture(records);
}

test("every finding carries the full economics, not just a delta", async () => {
  const data = await ingestClaudeCode({ root: mechanicalFixture() });
  const findings = findWaste(data);
  assert.ok(findings.length > 0, "expected at least one finding");

  for (const f of findings) {
    assert.ok(typeof f.category === "string" && f.category.length > 0, "category");
    assert.ok(f.savings.currentUsd >= 0, "currentUsd");
    assert.ok(f.savings.optimizedUsd >= 0, "optimizedUsd");
    assert.ok(f.savings.monthlyUsd >= 0, "monthlyUsd");
    assert.ok(f.savings.annualUsd >= 0, "annualUsd");
    assert.ok(
      ["low", "medium", "high"].includes(f.savings.confidence),
      `confidence is an ordinal level, got ${JSON.stringify(f.savings.confidence)}`,
    );
    assert.ok(f.savings.confidenceBasis.length > 10, "confidence is explained");
    assert.ok(f.savings.windowDays > 0, "the projection states the window it came from");
    assert.ok(["none", "low", "medium", "high"].includes(f.impact), "impact");
    assert.ok(f.savings.assumptions.length > 0, "assumptions are stated");
    assert.ok(f.savings.calculation.length > 20, "calculation is shown");
    assert.ok(f.affected.calls > 0, "affected calls");
    assert.ok(f.affected.share >= 0 && f.affected.share <= 1, "affected share");
  }
});

test("optimized cost plus waste equals current cost", async () => {
  const data = await ingestClaudeCode({ root: mechanicalFixture() });
  for (const f of findWaste(data)) {
    if (f.advisory) continue;
    assert.ok(
      Math.abs(f.savings.currentUsd - f.savings.optimizedUsd - f.savings.windowUsd) < 1e-9,
      `${f.rule}: current - optimized should equal wasted`,
    );
  }
});

test("annual is twelve months of the monthly figure", async () => {
  const data = await ingestClaudeCode({ root: mechanicalFixture() });
  for (const f of findWaste(data)) {
    const ratio = f.savings.annualUsd / f.savings.monthlyUsd;
    // 365/30, not 12 - the projection is per-day, so state it exactly.
    assert.ok(Math.abs(ratio - 365 / 30) < 1e-6, `${f.rule}: annual/monthly was ${ratio}`);
  }
});

test("a behavioural change is less confident than a mechanical one", async () => {
  const records = [];
  // Mechanical calls (model-fit: behavioural) plus duplicate reads (safe).
  // 60 rather than 30 so both clear the sample floor and the only thing
  // separating them is whether the fix changes how the model responds.
  for (let i = 0; i < 60; i++) {
    records.push(
      assistant({
        id: `m${i}`,
        ts: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`,
        content: [
          { type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: "/same.ts" } },
        ],
      }),
      {
        type: "user",
        timestamp: `2026-09-0${(i % 9) + 1}T10:00:01.000Z`,
        sessionId: "session-a",
        message: {
          content: [{ type: "tool_result", tool_use_id: `r${i}`, content: "x".repeat(20_000) }],
        },
      },
    );
  }

  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const findings = findWaste(data);
  const repeats = findings.find((f) => f.rule === "repeat-tool-calls");
  const swap = findings.find((f) => f.rule === "model-fit");

  assert.ok(repeats, "expected repeat-tool-calls");
  assert.ok(swap, "expected model-fit");
  assert.ok(
    CONFIDENCE_RANK[repeats.savings.confidence] > CONFIDENCE_RANK[swap.savings.confidence],
    `deleting a duplicate is more certain than swapping a model, got ${repeats.savings.confidence} vs ${swap.savings.confidence}`,
  );
  assert.equal(repeats.impact, "none");
  assert.equal(repeats.risk, "safe");
  assert.equal(swap.risk, "needs-verification");
});

test("advisories are excluded from recoverable savings", async (t) => {
  // The pricing advisory needs a model whose rate actually changed. This used
  // to lean on Sonnet 5's announced September 2026 increase, which Anthropic
  // cancelled — so no shipped model has two cards any more, and the rule
  // correctly never fires on the real catalogue. A fixture model supplies the
  // rate change the rule exists to detect.
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
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `ls ${i}` } }],
      }),
    );
  }

  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const findings = findWaste(data);
  const advisory = findings.find((f) => f.advisory);

  assert.ok(advisory, "expected a pricing advisory");
  assert.equal(advisory.rule, "pricing-change");
  assert.equal(advisory.savings.windowUsd, 0, "an advisory is not waste");

  // Clear waste and likely savings together: everything recoverable.
  const recoverable = recoverableMonthly(findings, ["fix", "try"]);
  const all = findings.reduce((s, f) => s + f.savings.monthlyUsd, 0);
  assert.ok(advisory.savings.monthlyUsd > 0, "the advisory still carries a real figure");
  assert.ok(recoverable < all, "the advisory must not inflate recoverable savings");

  // Recoverable is the non-advisory findings de-overlapped, so it is at most
  // total minus advisories - and exactly that when nothing overlaps.
  const overlap = savingsOverlap(findings);
  assert.ok(
    all - recoverable >= advisory.savings.monthlyUsd - 1e-9,
    "every advisory dollar is excluded",
  );
  assert.ok(
    overlap.contended.every((c) => !c.rules.includes("pricing-change")),
    "an advisory never contends for a call: it claims nothing",
  );
  assert.ok(recoverableAnnual(findings, ["fix", "try"]) > recoverable, "annual exceeds monthly");
});

test("findings are ranked by money, largest first", async () => {
  const data = await ingestClaudeCode({ root: mechanicalFixture(60) });
  const findings = findWaste(data);
  for (let i = 1; i < findings.length; i++) {
    assert.ok(
      findings[i - 1].savings.monthlyUsd >= findings[i].savings.monthlyUsd,
      "findings must be ordered by monthly value",
    );
  }
});

test("model-fit never recommends a model the traffic would not fit in", async () => {
  // 500K tokens of context exceeds Haiku's 200K window.
  const huge = { ...USAGE, cache_read_input_tokens: 500_000 };
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(
      assistant({
        id: `h${i}`,
        ts: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`,
        usage: huge,
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } }],
      }),
    );
  }

  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const swap = findWaste(data).find((f) => f.rule === "model-fit");
  assert.equal(swap, undefined, "calls too large for the target model must not be recommended");
});

test("an empty dataset produces no findings rather than fabricated ones", async () => {
  const data = { events: [], window: { from: "", to: "", days: 0 }, sources: [], warnings: [] };
  assert.deepEqual(findWaste(data), []);
  assert.equal(recoverableMonthly([]), 0);
});

test("summary reports provider, averages and top calls", async () => {
  const data = await ingestClaudeCode({ root: mechanicalFixture(20) });
  const s = summarize(data);

  assert.equal(s.byProvider[0].key, "anthropic");
  assert.ok(s.avgTokensPerCall > 0);
  assert.ok(s.avgCostPerCall > 0);
  assert.equal(s.topByCost.length, 10);
  assert.ok(s.topByCost[0].costUsd >= s.topByCost[1].costUsd, "top calls sorted by cost");
  assert.ok(s.topByTokens[0].totalTokens >= s.topByTokens[1].totalTokens);
  assert.equal(
    s.totalTokens,
    s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens,
  );
});

/* ------------------------------------------------------------------ *
 * Overlapping findings must not inflate the headline
 * ------------------------------------------------------------------ */

/**
 * Traffic that trips two detectors at once: every call is mechanical (so
 * `model-fit` claims it) and re-reads the same file (so `repeat-tool-calls`
 * claims it too). Adding both headline figures bills the same calls twice.
 */
function contendedFixture(n = 60) {
  const records = [];
  for (let i = 0; i < n; i++) {
    const day = `2026-09-${String((i % 20) + 1).padStart(2, "0")}`;
    records.push(
      assistant({
        id: `m${i}`,
        ts: `${day}T10:00:00.000Z`,
        content: [
          { type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: "/same.ts" } },
        ],
      }),
      {
        type: "user",
        timestamp: `${day}T10:00:01.000Z`,
        sessionId: "session-a",
        message: {
          content: [{ type: "tool_result", tool_use_id: `r${i}`, content: "x".repeat(20_000) }],
        },
      },
    );
  }
  return writeFixture(records);
}

test("overlapping findings do not inflate the headline savings", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  const findings = findWaste(data);

  const repeats = findings.find((f) => f.rule === "repeat-tool-calls");
  const swap = findings.find((f) => f.rule === "model-fit");
  assert.ok(repeats && swap, "the fixture must trip both detectors to be a test of overlap");

  // The two detectors genuinely claim the same calls.
  const shared = [...repeats.claimByEvent.keys()].filter((id) => swap.claimByEvent.has(id));
  assert.ok(shared.length > 0, "expected the detectors to contend for the same calls");

  const naive = findings.filter((f) => !f.advisory).reduce((s, f) => s + f.savings.monthlyUsd, 0);
  const headline = recoverableMonthly(findings);

  assert.ok(headline < naive, "the headline must be below the sum of the findings");
  assert.ok(headline > 0, "de-overlapping must not erase the saving");

  // And it is not below the largest single finding either: that money is real
  // whatever else claims those calls. Conservative, not defeatist.
  const largest = Math.max(...findings.filter((f) => !f.advisory).map((f) => f.savings.monthlyUsd));
  assert.ok(
    headline >= largest - 1e-9,
    `headline ${headline} must be at least the largest finding ${largest}`,
  );
});

test("a call claimed twice is counted once, at its larger claim", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  const findings = findWaste(data);
  const active = findings.filter((f) => !f.advisory && f.tier !== "test");

  // Recompute the invariant independently of the implementation: for every
  // call, the total may count only the biggest single claim on it.
  const best = new Map();
  for (const f of active) {
    for (const [id, usd] of f.claimByEvent) {
      if (usd > (best.get(id) ?? 0)) best.set(id, usd);
    }
  }
  const expected = [...best.values()].reduce((s, v) => s + v, 0);

  assert.ok(
    Math.abs(recoverableWindow(findings, ["fix", "try"]) - expected) < 1e-9,
    "the window total is the per-call maximum, summed",
  );
});

test("a finding's own claims add up to the figure it reports", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  for (const f of findWaste(data)) {
    if (f.claimByEvent.size === 0) continue;
    const claimed = [...f.claimByEvent.values()].reduce((s, v) => s + v, 0);
    assert.ok(
      Math.abs(claimed - f.savings.windowUsd) < 1e-9,
      `${f.rule}: apportioning must not create or destroy money (${claimed} vs ${f.savings.windowUsd})`,
    );
  }
});

test("the overlap adjustment can be explained, not just applied", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  const findings = findWaste(data);
  const overlap = savingsOverlap(findings);

  assert.ok(overlap.removedWindowUsd > 0, "this fixture overlaps, so something was removed");
  assert.ok(
    Math.abs(overlap.naiveWindowUsd - overlap.recoverableWindowUsd - overlap.removedWindowUsd) <
      1e-9,
    "the three figures must reconcile",
  );
  assert.ok(overlap.contended.length > 0, "the contending detectors are named");
  assert.deepEqual(
    overlap.contended[0].rules,
    ["model-fit", "repeat-tool-calls"],
    "the report says which detectors overlapped",
  );
  assert.ok(overlap.contended[0].calls > 0, "and on how many calls");
});

test("adding a detector can never raise the headline above the truth", async () => {
  // The property that matters as detectors are added: the headline is bounded
  // by the total spend it claims to be recovering from.
  const data = await ingestClaudeCode({ root: contendedFixture() });
  const findings = findWaste(data);
  const spend = data.events.reduce((s, e) => s + e.cost.total, 0);
  assert.ok(
    recoverableWindow(findings) <= spend + 1e-9,
    "recoverable savings cannot exceed the spend they come from",
  );
});

/* ------------------------------------------------------------------ *
 * Confidence carries no false precision
 * ------------------------------------------------------------------ */

test("confidence is an ordinal level, never a percentage", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  const findings = findWaste(data);
  assert.ok(findings.length > 0);

  for (const f of findings) {
    assert.equal(
      typeof f.savings.confidence,
      "string",
      `${f.rule}: confidence must not be numeric`,
    );
    assert.ok(["low", "medium", "high"].includes(f.savings.confidence), f.rule);
    // A basis that reads as a number would smuggle the precision back in.
    assert.doesNotMatch(
      f.savings.confidenceBasis,
      /\d+(\.\d+)?%/,
      `${f.rule}: the basis must not quote a percentage`,
    );
    // The level is justified, not merely asserted.
    assert.match(f.savings.confidenceBasis, /\b(low|medium|high) because\b/, f.rule);
  }
});

test("confidence falls when the evidence is thin", async () => {
  // Six duplicate reads: real, measured, and far too few to call a rate.
  const records = [];
  for (let i = 0; i < 6; i++) {
    const day = `2026-09-0${i + 1}`;
    records.push(
      assistant({
        id: `t${i}`,
        ts: `${day}T10:00:00.000Z`,
        content: [
          { type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: "/same.ts" } },
        ],
      }),
      {
        type: "user",
        timestamp: `${day}T10:00:01.000Z`,
        sessionId: "session-a",
        message: {
          content: [{ type: "tool_result", tool_use_id: `r${i}`, content: "x".repeat(40_000) }],
        },
      },
    );
  }

  const data = await ingestClaudeCode({ root: writeFixture(records) });
  const repeats = findWaste(data).find((f) => f.rule === "repeat-tool-calls");
  if (!repeats) return; // Below the money floor on this fixture; nothing to assert.
  assert.equal(repeats.savings.confidence, "low", "a handful of calls is not a rate");
  assert.match(repeats.savings.confidenceBasis, /too thin to average/);
});

/* ------------------------------------------------------------------ *
 * A broken detector is visible, and only breaks itself
 * ------------------------------------------------------------------ */

/** Make one field throw, standing in for a bug inside whichever rule reads it. */
function poison(event, field) {
  Object.defineProperty(event, field, {
    get() {
      throw new Error("simulated detector bug");
    },
    configurable: true,
  });
}

test("a broken detector is reported and does not crash the analysis", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  poison(data.events[0], "prefixHash");

  const { findings, errors } = analyze(data);

  assert.ok(errors.length > 0, "the failure must be reported, not swallowed");
  for (const e of errors) {
    assert.ok(typeof e.rule === "string" && e.rule.length > 0, "the failing detector is named");
    assert.match(e.message, /simulated detector bug/, "the reason survives");
  }

  // The detectors that did not touch the poisoned field still did their job.
  assert.ok(findings.length > 0, "one broken detector must not empty the report");
  assert.ok(
    findings.some((f) => f.rule === "model-fit"),
    "unaffected detectors still produce findings",
  );
  // And no error names a rule that also reported a finding.
  const failed = new Set(errors.map((e) => e.rule));
  for (const f of findings) {
    assert.ok(!failed.has(f.rule), `${f.rule} cannot both fail and report`);
  }
});

test("a detector failure never reads as a clean zero", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  poison(data.events[0], "prefixHash");

  // findWaste is the convenience path: the failure must still travel with it.
  const findings = findWaste(data);
  assert.ok(findings.length > 0);

  const { errors } = analyze(data);
  const broken = errors[0].rule;
  assert.ok(
    data.warnings.some((w) => w.includes(broken) && /failed and was skipped/.test(w)),
    `a host reading warnings must learn that "${broken}" is missing from the report`,
  );

  // Analysing twice must not stack the same warning.
  const before = data.warnings.length;
  findWaste(data);
  assert.equal(data.warnings.length, before, "warnings must not duplicate on re-analysis");
});

test("a clean run reports no errors", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture() });
  const { findings, errors } = analyze(data);
  assert.deepEqual(errors, [], "nothing should fail on well-formed traffic");
  assert.ok(findings.length > 0);
  assert.equal(data.warnings.length, 0, "and no detector warning is invented");
});

test("no finding claims to recover more than the traffic cost", async () => {
  // A single long session makes `repeat-tool-calls` compound its forward model
  // over many later calls, which once produced a saving larger than the whole
  // window's spend and an "after" cost below zero.
  const data = await ingestClaudeCode({ root: contendedFixture(60) });
  const findings = findWaste(data);
  assert.ok(findings.length > 0);

  for (const f of findings) {
    assert.ok(f.savings.optimizedUsd >= 0, `${f.rule}: an "after" cost cannot be negative`);
    const affectedSpend = [...f.claimByEvent.keys()].length
      ? data.events.filter((e) => f.affects(e)).reduce((s, e) => s + e.cost.total, 0)
      : 0;
    assert.ok(
      f.savings.windowUsd <= affectedSpend + 1e-9,
      `${f.rule}: claimed ${f.savings.windowUsd} against ${affectedSpend} of spend`,
    );
  }
});

test("a capped figure says that it was capped", async () => {
  const data = await ingestClaudeCode({ root: contendedFixture(60) });
  const repeats = findWaste(data).find((f) => f.rule === "repeat-tool-calls");
  assert.ok(repeats, "expected repeat-tool-calls on this fixture");

  // This fixture is exactly the case that trips the ceiling, so the finding
  // must disclose it rather than quietly presenting the reduced number.
  assert.ok(
    repeats.savings.assumptions.some((a) => /capped at what was actually spent/.test(a)),
    "the cap must be stated in the assumptions",
  );
});
