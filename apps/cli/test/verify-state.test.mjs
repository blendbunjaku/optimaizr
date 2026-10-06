import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  acceptRisk,
  findWaste,
  ingestClaudeCode,
  readVerification,
  recordVerification,
  resolveVerification,
  setVerificationStore,
  simulate,
  stateForVerdict,
  toRecommendations,
  verificationModeOf,
} from "@optimaizr/core";
import { fileVerificationStore } from "@optimaizr/local";
import "@optimaizr/local";

const execFileAsync = promisify(execFile);

/**
 * Verification state: the contract between `verify` and `apply`.
 *
 * These exist because the two commands used to answer "does this need
 * verifying?" from different fields — `verify` from `candidate`, `apply` from
 * `risk`. For `oversized-input`, which changes output but has no mechanical
 * rewrite to replay, they disagreed: `verify` reported it safe to apply, `apply`
 * refused it as unverified, and the recommendation could never be acted on.
 *
 * So the invariant under test is not any one message. It is that both commands
 * resolve through one function, and that the answer is persisted rather than
 * re-derived.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-vstate-"));
  process.env.OPTIMAIZR_DIR = dir;
  setVerificationStore(fileVerificationStore());
  return dir;
}

function writeFixture(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-vsfx-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "session.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

const call = ({ id, ts, session, usage, content, stopReason = "end_turn" }) => ({
  type: "assistant",
  timestamp: ts,
  sessionId: session,
  cwd: "/Users/someone/project",
  message: { id, model: "claude-sonnet-5", stop_reason: stopReason, usage, content },
});

const bash = (i) => [
  { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } },
];

/**
 * Traffic that produces an `oversized-input` finding: a low median context, and
 * a top decile of large-context calls whose output is short enough to classify
 * as mechanical.
 */
async function oversizedInputDataset() {
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push(
      call({
        id: `small${i}`,
        ts: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
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
        ts: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T11:00:00.000Z`,
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
  return ingestClaudeCode({ root: writeFixture(records) });
}

/**
 * Traffic that produces a `repeat-tool-calls` finding: the same large file read
 * over and over in one session. Pure waste removal, so nothing to verify.
 *
 * The tool *results* matter — the rule prices the re-billed content, so the
 * paired `tool_result` records are what give it something to cost.
 */
function repeatReadsRecords() {
  const records = [];
  for (let i = 0; i < 30; i++) {
    const ts = `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`;
    records.push(
      call({
        id: `r${i}`,
        ts,
        session: "s-reads",
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 60_000,
          cache_creation_input_tokens: 500,
        },
        content: [
          {
            type: "tool_use",
            id: `t${i}`,
            name: "Read",
            input: { file_path: "/Users/someone/project/src/index.ts" },
          },
        ],
      }),
      {
        type: "user",
        timestamp: ts,
        sessionId: "s-reads",
        message: {
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(40_000) }],
        },
      },
    );
  }
  return records;
}

async function repeatReadsDataset() {
  return ingestClaudeCode({ root: writeFixture(repeatReadsRecords()) });
}

/** Traffic that produces a `model-fit` finding — the replay-verifiable kind. */
async function modelFitDataset() {
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push(
      call({
        id: `m${i}`,
        ts: `2026-09-0${(i % 9) + 1}T10:00:00.000Z`,
        session: "session-a",
        usage: {
          input_tokens: 4,
          output_tokens: 300,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 1_000,
        },
        content: bash(i),
      }),
    );
  }
  return ingestClaudeCode({ root: writeFixture(records) });
}

/* ------------------------------------------------------------------ *
 * The mode is derived once, and cannot contradict itself
 * ------------------------------------------------------------------ */

test("every rule's verification mode agrees with what verify can actually do", async () => {
  useTempStore();
  // Two datasets, so the rules that need large contexts and the rules that need
  // a cheap-model-eligible profile both fire.
  const findings = [
    ...findWaste(await oversizedInputDataset()),
    ...findWaste(await modelFitDataset()),
    ...findWaste(await repeatReadsDataset()),
  ];
  assert.ok(findings.length > 0, "fixtures must produce findings");

  for (const f of findings) {
    const mode = verificationModeOf(f);
    assert.equal(mode, f.verification, `${f.rule}: build() and the resolver must agree`);

    // This is the contradiction that made oversized-input un-appliable: a
    // finding whose gate says "prove it" while offering nothing to prove it
    // with, and no third state to say so.
    if (mode === "replay") {
      assert.ok(f.candidate, `${f.rule}: replay mode must carry a candidate to replay`);
      assert.equal(f.risk, "needs-verification", `${f.rule}: replay implies a quality gate`);
    }
    if (mode === "not-required") {
      assert.equal(f.risk, "safe", `${f.rule}: nothing to verify implies nothing can change`);
    }
    if (mode === "manual") {
      assert.equal(f.risk, "needs-verification", `${f.rule}: manual implies a quality gate`);
      assert.ok(!f.candidate, `${f.rule}: manual means there is no rewrite to replay`);
    }

    // Whatever the mode, resolving must never leave a behaviour-changing
    // finding appliable on no evidence at all.
    const resolved = resolveVerification(f, null);
    if (f.risk === "needs-verification") {
      assert.equal(resolved.canApply, false, `${f.rule}: must not apply with no evidence`);
      assert.ok(resolved.guidance, `${f.rule}: a refusal must say what to do instead`);
    } else {
      assert.equal(resolved.canApply, true, `${f.rule}: waste removal needs no permission`);
    }
  }
});

test("oversized-input is no longer both safe and unverified at once", async () => {
  useTempStore();
  const finding = findWaste(await oversizedInputDataset()).find(
    (f) => f.rule === "oversized-input",
  );
  assert.ok(finding, "expected an oversized-input finding");

  // The rule genuinely changes output, so it must not be reported as safe...
  assert.equal(verificationModeOf(finding), "manual");
  assert.notEqual(
    resolveVerification(finding, null).state,
    "not_required",
    "a finding that changes output must never read as not_required",
  );
  // ...and it must not be a dead end either.
  assert.equal(resolveVerification(finding, null).canApply, false);
  assert.ok(resolveVerification(finding, null).guidance.includes("--accept-risk"));
});

/* ------------------------------------------------------------------ *
 * The four states
 * ------------------------------------------------------------------ */

test("verification required and passed: apply is permitted", async () => {
  useTempStore();
  const finding = findWaste(await modelFitDataset()).find((f) => f.rule === "model-fit");
  assert.ok(finding);
  assert.equal(verificationModeOf(finding), "replay");

  recordVerification({
    rule: "model-fit",
    at: "2026-09-10T00:00:00.000Z",
    state: stateForVerdict("PASS"),
    mode: "replay",
    verdict: "PASS",
    samples: 24,
  });

  const resolved = resolveVerification(finding, readVerification("model-fit"));
  assert.equal(resolved.state, "passed");
  assert.equal(resolved.canApply, true);
  assert.match(resolved.headline, /PASS/);
});

test("verification required and failed: apply is refused, and says why", async () => {
  useTempStore();
  const finding = findWaste(await modelFitDataset()).find((f) => f.rule === "model-fit");

  recordVerification({
    rule: "model-fit",
    at: "2026-09-10T00:00:00.000Z",
    state: stateForVerdict("FAIL"),
    mode: "replay",
    verdict: "FAIL",
    samples: 24,
  });

  const resolved = resolveVerification(finding, readVerification("model-fit"));
  assert.equal(resolved.state, "failed");
  assert.equal(resolved.canApply, false);
  // A failure must not be reported as "not yet verified": the user paid to
  // learn something, and what they learned was that the saving is not free.
  assert.match(resolved.guidance, /not free/);
});

test("an inconclusive replay does not become a pass", async () => {
  useTempStore();
  const finding = findWaste(await modelFitDataset()).find((f) => f.rule === "model-fit");

  recordVerification({
    rule: "model-fit",
    at: "2026-09-10T00:00:00.000Z",
    state: stateForVerdict("INCONCLUSIVE"),
    mode: "replay",
    verdict: "INCONCLUSIVE",
    samples: 3,
  });

  const resolved = resolveVerification(finding, readVerification("model-fit"));
  assert.equal(resolved.state, "inconclusive");
  assert.equal(resolved.canApply, false);
});

test("verification not required: the state says so without a replay", async () => {
  useTempStore();
  const finding = findWaste(await repeatReadsDataset()).find((f) => f.rule === "repeat-tool-calls");
  assert.ok(finding, "expected a repeat-tool-calls finding");
  assert.equal(finding.risk, "safe");
  assert.equal(verificationModeOf(finding), "not-required");

  // Resolves with no record at all: there is nothing a replay could add.
  const resolved = resolveVerification(finding, null);
  assert.equal(resolved.state, "not_required");
  assert.equal(resolved.canApply, true);
  assert.equal(resolved.guidance, null, "nothing to ask the user to do");
});

test("apply after not_required proceeds, with or without a stored record", async () => {
  useTempStore();
  const finding = findWaste(await repeatReadsDataset()).find((f) => f.rule === "repeat-tool-calls");
  assert.ok(finding, "expected a repeat-tool-calls finding");

  assert.equal(resolveVerification(finding, null).canApply, true);

  // `verify` records the state; apply must reach the same conclusion either way,
  // and must not be made *less* permissive by the record existing.
  recordVerification({
    rule: "repeat-tool-calls",
    at: new Date().toISOString(),
    state: "not_required",
    mode: "not-required",
  });
  const resolved = resolveVerification(finding, readVerification("repeat-tool-calls"));
  assert.equal(resolved.state, "not_required");
  assert.equal(resolved.canApply, true);
});

test("apply without verification is refused when verification is required", async () => {
  useTempStore();
  const finding = findWaste(await modelFitDataset()).find((f) => f.rule === "model-fit");

  const resolved = resolveVerification(finding, readVerification("model-fit"));
  assert.equal(readVerification("model-fit"), null, "nothing verified yet");
  assert.equal(resolved.state, "unverified");
  assert.equal(resolved.canApply, false);
  assert.match(resolved.guidance, /quality bar/);
});

test("a manual finding becomes appliable only once the risk is accepted", async () => {
  useTempStore();
  const finding = findWaste(await oversizedInputDataset()).find(
    (f) => f.rule === "oversized-input",
  );

  assert.equal(resolveVerification(finding, readVerification("oversized-input")).canApply, false);

  acceptRisk("oversized-input");

  const after = resolveVerification(finding, readVerification("oversized-input"));
  assert.equal(after.state, "passed");
  assert.equal(after.canApply, true);
  // The distinction has to survive into the message: this was a human's call,
  // not a replay result.
  assert.match(after.headline, /not by replay/);
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

test("verification state persists across runs and is machine-readable", async () => {
  const dir = useTempStore();
  recordVerification({
    rule: "model-fit",
    at: "2026-09-10T00:00:00.000Z",
    state: "passed",
    mode: "replay",
    verdict: "PASS",
    samples: 24,
    monthlySaving: 12.5,
  });

  // On disk as plain JSON keyed by rule, so another tool can read the gate.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "verifications.json"), "utf8"));
  assert.equal(onDisk["model-fit"].state, "passed");
  assert.equal(onDisk["model-fit"].mode, "replay");
  assert.equal(onDisk["model-fit"].monthlySaving, 12.5);

  // A fresh store over the same directory reads it back.
  setVerificationStore(fileVerificationStore());
  assert.equal(readVerification("model-fit").state, "passed");
});

test("a later replay attempt does not withdraw an earlier risk acceptance", () => {
  useTempStore();
  acceptRisk("oversized-output");
  recordVerification({
    rule: "oversized-output",
    at: new Date().toISOString(),
    state: "inconclusive",
    mode: "manual",
    verdict: "INCONCLUSIVE",
  });
  assert.ok(
    readVerification("oversized-output").acceptedRiskAt,
    "the user's decision is theirs to withdraw, not a replay's",
  );
});

test("state written by the pre-state jsonl log is migrated, not thrown away", () => {
  const dir = useTempStore();
  // Exactly the shape the old CLI appended: a raw verdict and no state.
  fs.writeFileSync(
    path.join(dir, "verifications.jsonl"),
    [
      JSON.stringify({ rule: "model-fit", at: "2026-09-01T00:00:00.000Z", verdict: "FAIL" }),
      JSON.stringify({
        rule: "model-fit",
        at: "2026-09-02T00:00:00.000Z",
        verdict: "PASS",
        samples: 20,
      }),
    ].join("\n") + "\n",
  );

  setVerificationStore(fileVerificationStore());
  const record = readVerification("model-fit");
  assert.equal(record.state, "passed", "last entry wins, as the old reader did");
  assert.equal(record.mode, "replay");
  assert.equal(record.samples, 20);
});

test("an unreadable store fails closed rather than waving an apply through", async () => {
  const dir = useTempStore();
  fs.writeFileSync(path.join(dir, "verifications.json"), "{ not json");
  setVerificationStore(fileVerificationStore());

  const finding = findWaste(await modelFitDataset()).find((f) => f.rule === "model-fit");
  assert.equal(readVerification("model-fit"), null);
  assert.equal(resolveVerification(finding, readVerification("model-fit")).canApply, false);
});

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

test("a finding with no mechanical candidate still simulates over its own calls", async () => {
  useTempStore();
  const data = await oversizedInputDataset();
  const findings = findWaste(data);
  const finding = findings.find((f) => f.rule === "oversized-input");
  const rec = toRecommendations(findings, data.events.length).find(
    (r) => r.id === "oversized-input",
  );

  const sim = simulate(rec, finding, data.events, data.window.days);

  // The bug: matchedCalls came from `candidate.matches`, which does not exist
  // for this rule, so the simulation reported 0 matching requests directly
  // above a real dollar figure derived from all of them.
  assert.ok(finding.affected.calls > 0);
  assert.equal(sim.matchedCalls, finding.affected.calls, "must count the finding's own calls");
  assert.equal(sim.stale, false);
  assert.ok(sim.shifts.length > 0, "per-model movement must be reported");
  assert.ok(
    Math.abs(sim.shifts.reduce((s, sh) => s + sh.from, 0) - finding.savings.currentUsd) < 1e-9,
    "per-model current costs must sum to the finding's current cost",
  );
  assert.equal(
    sim.shifts.reduce((s, sh) => s + sh.calls, 0),
    finding.affected.calls,
  );
  // No replay can settle this rule, so the caveat must not send the user to one.
  assert.equal(sim.verification, "manual");
  assert.ok(!sim.caveat.includes("optimaizr verify"));
});

test("simulating over zero matching requests is reported as such, not as a saving", async () => {
  useTempStore();
  const data = await oversizedInputDataset();
  const findings = findWaste(data);
  const finding = findings.find((f) => f.rule === "oversized-input");
  const rec = toRecommendations(findings, data.events.length).find(
    (r) => r.id === "oversized-input",
  );

  // Events from a window the finding was not computed over.
  const sim = simulate(rec, finding, [], data.window.days);

  assert.equal(sim.matchedCalls, 0);
  assert.equal(sim.stale, true, "a projection with no traffic under it is not a result");
  assert.deepEqual(sim.shifts, []);
  assert.match(sim.caveat, /None of the requests supplied/);
  // The figures still come through — they are the finding's, and the caveat now
  // says exactly that rather than letting them read as freshly derived.
  assert.ok(sim.monthlySaving > 0);
});

test("every recommendation can be simulated; only replayable ones offer verify", async () => {
  useTempStore();
  const data = await oversizedInputDataset();
  const findings = findWaste(data);
  const recs = toRecommendations(findings, data.events.length);
  assert.ok(recs.length > 0);

  for (const rec of recs) {
    const finding = findings.find((f) => f.rule === rec.rule);
    assert.ok(
      rec.actions.includes("simulate"),
      `${rec.rule}: simulation is arithmetic on recorded tokens, always available`,
    );
    assert.equal(
      rec.actions.includes("verify"),
      verificationModeOf(finding) === "replay",
      `${rec.rule}: verify is offered exactly when a replay can settle it`,
    );
    assert.equal(rec.verification, verificationModeOf(finding));
  }
});

/* ------------------------------------------------------------------ *
 * The built CLI — the two commands that used to disagree
 * ------------------------------------------------------------------ */

const CLI = path.join(new URL("..", import.meta.url).pathname, "dist/cli.js");
const HAS_CLI = fs.existsSync(CLI);

/** Run the real CLI against a fixture home and transcript root. */
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

test(
  "the built CLI's verify and apply agree about oversized-input",
  { skip: HAS_CLI ? false : "dist/cli.js is not built" },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-cli-"));
    const records = [];
    for (let i = 0; i < 40; i++) {
      records.push(
        call({
          id: `small${i}`,
          ts: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
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
          ts: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T11:00:00.000Z`,
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
    // The transcript reader looks under ~/.claude/projects.
    const projects = path.join(home, ".claude", "projects");
    fs.mkdirSync(path.join(projects, "-Users-someone-project"), { recursive: true });
    fs.writeFileSync(
      path.join(projects, "-Users-someone-project", "session.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
    };

    const verify = await runCli(["verify", "oversized-input"], env);
    // The original bug, in the exact words it shipped with.
    assert.ok(
      !verify.stdout.includes("safe to apply directly"),
      `verify must not call a behaviour-changing fix safe:\n${verify.stdout}`,
    );
    assert.match(verify.stdout, /manual verification required/);

    const blocked = await runCli(["apply", "oversized-input"], env);
    assert.equal(blocked.code, 1, "apply must still refuse without a sign-off");
    assert.match(blocked.stdout, /unverified/);
    // It must no longer send the user to a verify that cannot settle anything
    // without also telling them the route that can.
    assert.match(blocked.stdout, /--accept-risk/);

    const accepted = await runCli(["apply", "oversized-input", "--accept-risk"], env);
    assert.equal(accepted.code, 0, `apply --accept-risk must proceed:\n${accepted.stdout}`);
    assert.match(accepted.stdout, /passed/);
    assert.match(accepted.stdout, /The change/);

    // Recorded, so the next run does not ask again.
    const state = JSON.parse(
      fs.readFileSync(path.join(env.OPTIMAIZR_DIR, "verifications.json"), "utf8"),
    );
    assert.equal(state["oversized-input"].mode, "manual");
    assert.ok(state["oversized-input"].acceptedRiskAt);

    const again = await runCli(["apply", "oversized-input"], env);
    assert.equal(again.code, 0, "an accepted risk persists across runs");
  },
);

test(
  "the built CLI applies a not_required finding without asking to verify",
  { skip: HAS_CLI ? false : "dist/cli.js is not built" },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-cli2-"));
    // Repeated identical reads in one session: pure waste, nothing to verify.
    const records = repeatReadsRecords();
    const projects = path.join(home, ".claude", "projects");
    fs.mkdirSync(path.join(projects, "-Users-someone-project"), { recursive: true });
    fs.writeFileSync(
      path.join(projects, "-Users-someone-project", "session.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
    };

    const verify = await runCli(["verify", "repeat-tool-calls"], env);
    assert.match(verify.stdout, /not_required/);

    const apply = await runCli(["apply", "repeat-tool-calls"], env);
    assert.equal(apply.code, 0, `a safe fix applies straight away:\n${apply.stdout}`);
    assert.match(apply.stdout, /not_required/);
    assert.ok(
      !apply.stdout.includes("Not verified"),
      "waste removal must never be reported as unverified",
    );
  },
);
