import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PIECES,
  checkKindOf,
  checkOutcomeOf,
  checkRunOf,
  judgedPieces,
  tallyPieces,
  workPieces,
} from "@optimaizr/core";
import { bash, codexRollout, edit, load, loadCodex, transcript } from "./fixtures/transcripts.mjs";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const MIN = 60_000;
const iso = (t) => new Date(t).toISOString();

/**
 * One call in `session`, `minute` minutes in, part of prompt `turn` that was
 * sent at `turnAt` minutes. Costs $1 unless `cost` says otherwise.
 */
let n = 0;
function call(session, minute, tools = [], opts = {}) {
  const { turn = 0, turnAt = minute, cost = 1, source = "claude-code", sub = false } = opts;
  return {
    id: `e${n++}`,
    source,
    provider: "anthropic",
    ts: iso(T0 + minute * MIN),
    endTs: iso(T0 + minute * MIN + 10_000),
    model: "claude-opus-5-5",
    sessionId: session,
    project: "/w",
    turnId: `${session}:${turn}`,
    turnStartedAt: iso(T0 + turnAt * MIN),
    inputTokens: 10,
    outputTokens: 200,
    thinkingTokens: 0,
    cacheReadTokens: 20_000,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    tools,
    cost: { total: cost },
    ...(sub ? { isSubagent: true } : {}),
  };
}

const run = (command, kind, outcome) => ({
  name: "Bash",
  signature: `Bash:${command}`,
  check: { kind, outcome },
});
const change = (file) => ({ name: "Edit", signature: `Edit:${file}` });
const look = (file) => ({ name: "Read", signature: `Read:${file}` });

test("check kind: the command's runner and script name say what it checks", () => {
  assert.equal(checkKindOf("npm test"), "test");
  assert.equal(checkKindOf("npm run test -- --watch=false"), "test");
  assert.equal(checkKindOf("timeout 120 npx vitest run src"), "test");
  assert.equal(checkKindOf("node --test test/*.test.mjs"), "test");
  assert.equal(checkKindOf("npx tsc --noEmit"), "typecheck");
  assert.equal(checkKindOf("pnpm -w typecheck"), "typecheck");
  assert.equal(checkKindOf("npm -w apps/cli run build"), "build");
  assert.equal(checkKindOf("npm run build"), "build");
  assert.equal(checkKindOf("npx eslint ."), "lint");
  assert.equal(checkKindOf("npx prettier --check ."), "lint");
  // Tests decide most when one line runs several.
  assert.equal(checkKindOf("npm run build && npm test 2>&1 | tail -5"), "test");
  assert.equal(checkKindOf("npx prettier --write ."), null);
  assert.equal(checkKindOf("git status && ls"), null);
  assert.equal(checkKindOf("cat > notes.md <<'EOF'\nrun pytest later\nEOF"), null);
});

test("check outcome: the runner's summary line decides, not the exit code", () => {
  const test = { kind: "test" };
  assert.equal(checkOutcomeOf("ℹ tests 44\nℹ pass 44\nℹ fail 0", test), "pass");
  assert.equal(checkOutcomeOf("ℹ tests 44\nℹ pass 42\nℹ fail 2", test), "fail");
  assert.equal(checkOutcomeOf(" Tests  2 failed | 40 passed (42)", test), "fail");
  assert.equal(checkOutcomeOf("====== 12 passed in 0.4s ======", test), "pass");
  assert.equal(checkOutcomeOf("--- FAIL: TestParse (0.00s)\nFAIL", test), "fail");
  assert.equal(checkOutcomeOf("src/a.ts(3,1): error TS2322: no", { kind: "typecheck" }), "fail");
  assert.equal(checkOutcomeOf("Process exited with code 1\nboom", test), "fail");
  // An `&& echo` after the check, and a check's code on a line of its own.
  assert.equal(checkOutcomeOf("TSC_OK", { kind: "typecheck" }), "pass");
  assert.equal(checkOutcomeOf("tsc:0\nlint:1", { kind: "typecheck" }), "fail");
  assert.equal(checkOutcomeOf("build 0", { kind: "build" }), "pass");
  // "tests 44" is a count, not an exit code.
  assert.equal(checkOutcomeOf("tests 44", test), "unknown");
});

test("check outcome: silence passes a typecheck but says nothing about tests", () => {
  assert.equal(checkOutcomeOf("", { kind: "typecheck" }), "pass");
  assert.equal(checkOutcomeOf("Shell cwd was reset to /w\n", { kind: "lint" }), "pass");
  assert.equal(checkOutcomeOf("", { kind: "test" }), "unknown");
  assert.equal(checkOutcomeOf("some grep-filtered line", { kind: "test" }), "unknown");
  assert.equal(checkOutcomeOf("", { kind: "test", isError: true }), "fail");
});

test("check run: a command the user turned down never ran", () => {
  assert.equal(checkRunOf("test", "The user doesn't want to proceed with this tool use."), null);
  assert.equal(checkRunOf("test", "[Request interrupted by user for tool use]"), null);
  assert.deepEqual(checkRunOf("test", "ℹ pass 3\nℹ fail 0"), { kind: "test", outcome: "pass" });
});

test("ingest: Claude Code keeps the check's outcome, not what it printed", async () => {
  const { events } = await load({
    s1: transcript("s1", [
      { prompt: "fix it" },
      {
        tools: [
          { ...bash("npm test 2>&1 | tail -3"), text: "ℹ tests 3\nℹ pass 2\nℹ fail 1" },
          { ...bash("ls src") },
          { ...bash("npx tsc --noEmit"), text: "The user doesn't want to proceed." },
        ],
      },
      { tools: [edit("/w/src/a.ts")] },
      { tools: [{ ...bash("npm test"), text: "ℹ tests 3\nℹ pass 3\nℹ fail 0" }] },
      { out: 100 },
    ]),
  });
  const tools = events.flatMap((e) => e.tools);
  const checks = tools.filter((t) => t.check).map((t) => t.check);
  assert.deepEqual(checks, [
    { kind: "test", outcome: "fail" },
    { kind: "test", outcome: "pass" },
  ]);
  assert.ok(!JSON.stringify(events).includes("ℹ pass"), "the output itself is dropped");

  const [piece] = workPieces(events);
  assert.equal(piece.outcome, "passed");
  assert.equal(piece.fixLoops, 1);
  assert.equal(piece.edits, 1);
});

test("ingest: Codex reads its checks from the command output", async () => {
  const { events } = await loadCodex({
    a: codexRollout("a", [
      { prompt: "fix it" },
      { cmd: "npm test", output: "Process exited with code 1\n 1 failed, 4 passed" },
      { cmd: "cargo build", output: "Process exited with code 0\n    Finished `dev` profile" },
      { out: 100 },
    ]),
  });
  const checks = events
    .flatMap((e) => e.tools)
    .filter((t) => t.check)
    .map((t) => t.check);
  assert.deepEqual(checks, [
    { kind: "test", outcome: "fail" },
    { kind: "build", outcome: "pass" },
  ]);
});

test("pieces: a fail, a fix and a pass is one fix loop, priced from the call after the fail", () => {
  const events = [
    call("s", 0, [look("a.ts")]),
    call("s", 1, [run("npm test", "test", "fail")]),
    call("s", 2, [change("a.ts")], { cost: 2 }),
    call("s", 3, [run("npm test", "test", "pass")], { cost: 3 }),
    call("s", 4, []),
  ];
  const [p] = workPieces(events);
  assert.equal(p.outcome, "passed");
  assert.equal(p.checks, 2);
  assert.equal(p.fixLoops, 1);
  assert.equal(p.fixUsd, 5);
  assert.equal(p.costUsd, 8);
});

test("pieces: running a check again with no change in between is not a fix loop", () => {
  const events = [
    call("s", 0, [run("npm test", "test", "fail")]),
    call("s", 1, [look("a.ts")]),
    call("s", 2, [run("npm test", "test", "pass")]),
  ];
  const [p] = workPieces(events);
  assert.equal(p.outcome, "passed");
  assert.equal(p.fixLoops, 0);
  assert.equal(p.fixUsd, 0);
});

test("pieces: lint never decides, the last readable test, build or typecheck does", () => {
  const [lintLast] = workPieces([
    call("a", 0, [run("npm test", "test", "pass")]),
    call("a", 1, [run("npx eslint .", "lint", "fail")]),
  ]);
  assert.equal(lintLast.outcome, "passed");

  const [unreadableLast] = workPieces([
    call("b", 0, [run("npm run build", "build", "fail")]),
    call("b", 1, [run("npm test | grep x", "test", "unknown")]),
  ]);
  assert.equal(unreadableLast.outcome, "failed");

  const [unknown] = workPieces([call("c", 0, [run("npm test | grep x", "test", "unknown")])]);
  assert.equal(unknown.outcome, "unknown");

  const [unchecked] = workPieces([
    call("d", 0, [change("a.ts")]),
    call("d", 1, [run("npx eslint .", "lint", "pass")]),
  ]);
  assert.equal(unchecked.outcome, "unchecked");
  assert.equal(unchecked.checks, 0);
});

test("pieces: a prompt 2 hours after the last reply starts a new piece", () => {
  const events = [
    call("s", 0, [run("npm test", "test", "pass")], { turn: 0, turnAt: 0 }),
    call("s", 1, [], { turn: 0, turnAt: 0 }),
    // 90 minutes later: the same piece.
    call("s", 91, [change("a.ts")], { turn: 1, turnAt: 91 }),
    // A subagent started by that prompt, placed by its own time.
    call("s", 92, [run("npm test", "test", "fail")], { turn: 1, turnAt: 91, sub: true }),
    // Back the next morning: a new piece.
    call("s", 600, [look("b.ts")], { turn: 2, turnAt: 600 }),
    call("s", 601, [], { turn: 2, turnAt: 600, cost: 4 }),
  ];
  const pieces = workPieces(events);
  assert.equal(pieces.length, 2);
  assert.deepEqual(
    pieces.map((p) => [p.part, p.prompts, p.calls, p.outcome, p.costUsd]),
    [
      [0, 2, 4, "failed", 4],
      [1, 1, 2, "unchecked", 5],
    ],
  );
});

test("pieces: opencode is left out, its tool output isn't kept", () => {
  const events = [
    call("o", 0, [run("npm test", "test", "pass")], { source: "opencode" }),
    call("c", 0, [run("npm test", "test", "pass")]),
  ];
  assert.deepEqual(
    workPieces(events).map((p) => p.sessionId),
    ["c"],
  );
});

test("tally: the cost of a finished piece is a median, and only from enough of them", () => {
  const passed = (s, cost) => call(s, 0, [run("npm test", "test", "pass")], { cost });
  const few = tallyPieces(workPieces([passed("a", 1), passed("b", 2), passed("c", 3)]));
  assert.equal(few.passed, 3);
  assert.equal(few.finishedUsd, null);

  const costs = [4, 1, 9, 2, 3, 100];
  const events = costs.map((c, i) => passed(`p${i}`, c));
  events.push(call("f", 0, [run("npm test", "test", "fail")], { cost: 7 }));
  events.push(call("u", 0, [change("a.ts")], { cost: 5 }));
  const t = tallyPieces(workPieces(events));
  assert.equal(t.pieces, 8);
  assert.equal(t.passed, 6);
  assert.equal(t.failed, 1);
  assert.equal(t.unchecked, 1);
  assert.ok(t.passed >= MIN_PIECES);
  assert.equal(t.finishedUsd, 4);
  assert.equal(judgedPieces(t), 7);
  assert.equal(t.costUsd, 131);
});
