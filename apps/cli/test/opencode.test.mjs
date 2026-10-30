import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildTasks,
  cachesOnItsOwn,
  coldResumes,
  conversations,
  costOf,
  createCacheWatch,
  createContextWatch,
  ingest,
  ingestOpencode,
  loadSqlite,
  mapOpencodeRows,
  OPENCODE_READ_FAILED,
  OPENCODE_SQLITE_WARNING,
  OPENCODE_V2_WARNING,
  opencodeDbPath,
  readOpencodeRows,
  toolSignatureOf,
  toolTargetOf,
} from "@optimaizr/core";
import "@optimaizr/local";

const T0 = Date.parse("2026-10-10T12:00:00.000Z");

/** Rows as opencode stores them: JSON in `data`, times in ms. */
function rows({ sessions = [], messages = [], parts = [] }) {
  return { sessions, messages, parts };
}
const session = (over = {}) => ({
  id: "ses_a",
  parent_id: null,
  directory: "/home/someone/project",
  title: "Fix the parser",
  model: JSON.stringify({ id: "claude-sonnet-5", providerID: "anthropic", variant: "high" }),
  ...over,
});
const message = (id, data, at = T0, sid = "ses_a") => ({
  id,
  session_id: sid,
  time_created: at,
  data: JSON.stringify({ role: "assistant", parentID: "msg_user1", ...data }),
});
const step = (id, mid, tokens, at = T0 + 1000, reason = "stop") => ({
  id,
  message_id: mid,
  session_id: "ses_a",
  time_created: at,
  data: JSON.stringify({ type: "step-finish", reason, tokens, cost: 999 }),
});
const tool = (id, mid, name, input, status = "completed", outputChars = 120, at = T0 + 500) => ({
  id,
  message_id: mid,
  session_id: "ses_a",
  time_created: at,
  data: JSON.stringify({
    type: "tool",
    tool: name,
    callID: `call_${id}`,
    state: { status, input },
  }),
  output_chars: outputChars,
});
const TOKENS = { input: 1000, output: 200, reasoning: 50, cache: { read: 40_000, write: 3000 } };

test("the empty-history notice lists all three coding agents", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-notice-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "scan", "--source", "sdk"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        OPTIMAIZR_DIR: dir,
        OPTIMAIZR_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to analyse yet/);
  assert.match(
    result.stdout,
    /optimAIzr reads Claude Code \(~\/\.claude\/projects\), Codex \(~\/\.codex\/sessions\) and opencode \(~\/\.local\/share\/opencode\)\./,
  );
});

test("the empty-history notice says why an opencode database wasn't read", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-notice-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const xdg = path.join(dir, ".local", "share");
  fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
  // Unreadable on every Node: too old for node:sqlite, or not a database.
  fs.writeFileSync(path.join(xdg, "opencode", "opencode.db"), "not sqlite");
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "scan"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        XDG_DATA_HOME: xdg,
        CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
        CODEX_HOME: path.join(dir, ".codex"),
        OPTIMAIZR_DIR: path.join(dir, ".optimaizr"),
        OPTIMAIZR_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to analyse yet/);
  assert.match(
    result.stdout,
    /warning: opencode history skipped: it (?:needs Node 22\.13 or later|couldn't be read \(opencode\.db: )/,
  );
});

test("a step-finish becomes one call with opencode's counts", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", { modelID: "claude-sonnet-5", variant: "max" })],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  );
  assert.equal(out.events.length, 1);
  const e = out.events[0];
  assert.equal(e.id, "ses_a#prt_1");
  assert.equal(e.source, "opencode");
  assert.equal(e.model, "claude-sonnet-5");
  assert.equal(e.provider, "anthropic");
  assert.equal(e.effort, "max");
  assert.equal(e.project, "/home/someone/project");
  assert.equal(e.turnId, "ses_a:msg_user1");
  assert.equal(e.ts, new Date(T0 + 1000).toISOString());
  assert.equal(e.stopReason, "end_turn");
  assert.deepEqual(
    [
      e.inputTokens,
      e.outputTokens,
      e.thinkingTokens,
      e.cacheReadTokens,
      e.cacheWrite5mTokens,
      e.cacheWrite1hTokens,
    ],
    [1000, 250, 50, 40_000, 3000, 0],
  );
  assert.equal(e.isSubagent, undefined);
  assert.deepEqual(out.titles, { ses_a: "Fix the parser" });
});

test("anthropic cost matches the same call priced directly", () => {
  const [e] = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", { modelID: "claude-sonnet-5" })],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  ).events;
  const direct = costOf(
    {
      input_tokens: 1000,
      output_tokens: 250,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 3000,
    },
    "claude-sonnet-5",
    { at: e.ts },
  );
  assert.ok(e.cost.total > 0);
  assert.equal(e.cost.total, direct.total);
});

test("an OpenAI model's cache reads and writes are not subtracted twice", () => {
  const [e] = mapOpencodeRows(
    rows({
      sessions: [session({ model: null })],
      messages: [message("msg_1", { modelID: "gpt-5.4", providerID: "openai" })],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  ).events;
  const direct = costOf(
    {
      input_tokens: 44_000,
      input_tokens_details: { cached_tokens: 40_000, cache_write_tokens: 3000 },
      output_tokens: 250,
      output_tokens_details: { reasoning_tokens: 50 },
    },
    "gpt-5.4",
    { at: e.ts },
  );
  assert.equal(e.inputTokens, 1000);
  assert.ok(e.cost.total > 0);
  assert.equal(e.cost.total, direct.total);
});

test("model and effort fall back to the session's selection", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", {})],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  );
  assert.equal(out.events[0].model, "claude-sonnet-5");
  assert.equal(out.events[0].effort, "high");
  assert.deepEqual(out.warnings, []);
});

test("no model anywhere is named unknown, with a warning, and keeps opencode's cost", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session({ model: null })],
      messages: [message("msg_1", {})],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  );
  assert.equal(out.events[0].model, "unknown");
  assert.equal(out.events[0].effort, null);
  assert.equal(out.events[0].cost.unpriced, false);
  assert.equal(out.events[0].cost.stated, true);
  assert.equal(out.events[0].cost.total, 999);
  assert.ok(out.warnings.some((w) => w.includes("no model")));
});

test("tools attach to the step that called them", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", { modelID: "claude-sonnet-5" })],
      parts: [
        tool("prt_1", "msg_1", "read", { filePath: "/a.ts" }, "completed", 120, T0 + 100),
        tool("prt_2", "msg_1", "bash", { command: "false" }, "error", 9, T0 + 200),
        step("prt_3", "msg_1", TOKENS, T0 + 300, "tool-calls"),
        step("prt_4", "msg_1", TOKENS, T0 + 400),
      ],
    }),
  );
  const [first, second] = out.events;
  assert.deepEqual(
    first.tools.map((t) => [t.name, t.signature, t.resultChars, t.isError]),
    [
      ["Read", "Read:/a.ts", 120, undefined],
      ["Bash", "Bash:false", 9, true],
    ],
  );
  assert.equal(first.stopReason, "tool_use");
  assert.deepEqual(second.tools, []);
});

test("canonical tool names, read slices and edit targets use Claude's helpers", () => {
  const names = [
    "read",
    "write",
    "edit",
    "multiedit",
    "bash",
    "grep",
    "glob",
    "list",
    "todowrite",
    "todoread",
    "task",
    "webfetch",
    "websearch",
    "apply_patch",
    "patch",
    "custom",
  ];
  const canonical = [
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Bash",
    "Grep",
    "Glob",
    "LS",
    "TodoWrite",
    "TodoWrite",
    "Task",
    "WebFetch",
    "WebSearch",
    "apply_patch",
    "apply_patch",
    "custom",
  ];
  const input = {
    filePath: "/a.ts",
    offset: 2,
    limit: 10,
    command: "  git   status ",
    pattern: "foo",
    path: "/p",
    url: "https://example.com",
  };
  const translated = {
    offset: 2,
    limit: 10,
    command: "  git   status ",
    pattern: "foo",
    path: "/p",
    url: "https://example.com",
    file_path: "/a.ts",
  };
  const [e] = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", {})],
      parts: [
        ...names.map((name, i) =>
          tool(`prt_${i}`, "msg_1", name, input, "completed", 120, T0 + 500 + i),
        ),
        step("prt_end", "msg_1", TOKENS),
      ],
    }),
  ).events;
  assert.deepEqual(
    e.tools.map((t) => t.name),
    canonical,
  );
  for (const [i, t] of e.tools.entries()) {
    assert.equal(t.signature, toolSignatureOf(canonical[i], translated));
    assert.equal(t.target, toolTargetOf(translated));
  }
  assert.equal(e.tools[0].signature, "Read:/a.ts#2:10");
});

test("a completed read turn is a done lookup, not multi-step", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", {})],
      parts: [
        tool("prt_1", "msg_1", "read", { filePath: "/a.ts" }),
        step("prt_2", "msg_1", TOKENS),
      ],
    }),
  );
  const [task] = buildTasks(out.events);
  assert.equal(task.done, true);
  assert.equal(task.kind, "lookup");
});

test("stop reasons are canonical, with unknown reasons passed through", () => {
  const reasons = ["tool-calls", "stop", "length", "other"];
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", {})],
      parts: reasons.map((reason, i) => step(`prt_${i}`, "msg_1", TOKENS, T0 + i, reason)),
    }),
  );
  assert.deepEqual(
    out.events.map((e) => e.stopReason),
    ["tool_use", "end_turn", "max_tokens", "other"],
  );
});

test("a subagent session is flagged even when its parent row is absent", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session({ parent_id: "ses_parent" })],
      messages: [message("msg_1", {})],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  );
  assert.equal(out.events[0].isSubagent, true);
});

test("subagents join the root conversation while retaining their own event and turn ids", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [
        session({ id: "ses_child", parent_id: "ses_middle", directory: null }),
        session({ id: "ses_middle", parent_id: "ses_a" }),
        session(),
      ],
      messages: [message("msg_1", {}), message("msg_child", {}, T0 + 2000, "ses_child")],
      parts: [
        step("prt_1", "msg_1", TOKENS),
        { ...step("prt_child", "msg_child", TOKENS, T0 + 3000), session_id: "ses_child" },
      ],
    }),
  );
  assert.deepEqual(
    out.events.map((e) => e.sessionId),
    ["ses_a", "ses_a"],
  );
  const child = out.events[1];
  assert.equal(child.isSubagent, true);
  assert.equal(child.id, "ses_child#prt_child");
  assert.equal(child.turnId, "ses_child:msg_user1");
  assert.equal(child.project, "/home/someone/project");
  const convos = conversations(out);
  assert.equal(convos.length, 1);
  assert.equal(convos[0].sessionId, "ses_a");
  assert.equal(convos[0].source, "opencode");
  assert.equal(convos[0].costUsd, out.events[0].cost.total + child.cost.total);
  assert.equal(convos[0].subagentUsd, child.cost.total);
});

test("a summary records full previous context and moves later calls to the next epoch", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [
        message("msg_1", {}, T0),
        message("msg_2", { summary: true }, T0 + 10_000),
        message("msg_3", {}, T0 + 20_000),
      ],
      parts: [
        step("prt_1", "msg_1", TOKENS, T0 + 1000, "tool-calls"),
        step("prt_2", "msg_2", TOKENS, T0 + 11_000),
        step("prt_3", "msg_3", TOKENS, T0 + 21_000),
      ],
    }),
  );
  assert.deepEqual(
    out.events.map((e) => e.contextEpoch),
    [undefined, undefined, 1],
  );
  assert.equal(out.compactions.length, 1);
  assert.deepEqual(out.compactions[0], {
    source: "opencode",
    ts: new Date(T0 + 10_000).toISOString(),
    sessionId: "ses_a",
    project: "/home/someone/project",
    trigger: "unknown",
    preTokens: 44_000,
    midTask: true,
  });
});

test("days and project filter calls", () => {
  const now = Date.now();
  const out = mapOpencodeRows(
    rows({
      sessions: [session(), session({ id: "ses_b", directory: "/elsewhere" })],
      messages: [
        message("msg_old", {}, now - 10 * 86_400_000),
        message("msg_new", {}, now - 1000),
        message("msg_b", {}, now - 1000, "ses_b"),
      ],
      parts: [
        step("prt_old", "msg_old", TOKENS, now - 10 * 86_400_000),
        step("prt_new", "msg_new", TOKENS, now - 500),
        { ...step("prt_b", "msg_b", TOKENS, now - 500), session_id: "ses_b" },
      ],
    }),
    { days: 3, project: "PROJECT" },
  );
  assert.deepEqual(
    out.events.map((e) => e.id),
    ["ses_a#prt_new"],
  );
});

test("unparseable messages and parts are skipped with one warning", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [{ ...message("msg_bad", {}), data: "{oops" }, message("msg_1", {})],
      parts: [
        { ...step("prt_bad", "msg_1", TOKENS), data: "{oops" },
        step("prt_1", "msg_1", TOKENS),
      ],
    }),
  );
  assert.equal(out.events.length, 1);
  assert.deepEqual(out.warnings, ["opencode: skipped 2 unparseable row(s)"]);
});

test("invalid message and part timestamps are skipped without losing valid calls", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [
        message("msg_nan", {}, NaN),
        message("msg_huge", { summary: true }, 1e30),
        message("msg_1", {}),
      ],
      parts: [
        step("prt_nan_message", "msg_nan", TOKENS),
        step("prt_huge_message", "msg_huge", TOKENS),
        step("prt_nan", "msg_1", TOKENS, NaN),
        step("prt_huge", "msg_1", TOKENS, 1e30),
        step("prt_1", "msg_1", TOKENS),
      ],
    }),
  );
  assert.deepEqual(
    out.events.map((e) => e.id),
    ["ses_a#prt_1"],
  );
  assert.deepEqual(out.warnings, ["opencode: skipped 4 unparseable row(s)"]);
});

test("an uncatalogued model takes opencode's own cost, and $0 stays unpriced", () => {
  const free = {
    ...step("prt_2", "msg_2", TOKENS, T0 + 3000),
    data: JSON.stringify({ type: "step-finish", reason: "stop", tokens: TOKENS, cost: 0 }),
  };
  const out = mapOpencodeRows(
    rows({
      sessions: [session({ model: null })],
      messages: [
        message("msg_1", { modelID: "gpt-6.1-sol", providerID: "openai" }),
        message("msg_2", { modelID: "qwen3-coder-plus", providerID: "alibaba" }, T0 + 2000),
      ],
      parts: [step("prt_1", "msg_1", TOKENS), free],
    }),
  );
  const [stated, unpriced] = out.events;
  assert.equal(stated.provider, "openai");
  assert.equal(stated.cost.unpriced, false);
  assert.equal(stated.cost.stated, true);
  assert.equal(stated.cost.total, 999);
  // The split follows the token mix and adds back up to the stated figure.
  const parts =
    stated.cost.input + stated.cost.output + stated.cost.cacheRead + stated.cost.cacheWrite;
  assert.ok(Math.abs(parts - 999) < 1e-9);
  assert.ok(stated.cost.cacheRead > stated.cost.input);
  // A subscription records 0: that is no price, not a free call.
  assert.equal(unpriced.cost.unpriced, true);
  assert.equal(unpriced.cost.total, 0);
  assert.deepEqual(out.warnings, []);
});

test("a model with a card here ignores opencode's cost and uses the card", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session({ model: null })],
      messages: [message("msg_1", { modelID: "glm-4.6", providerID: "zai" })],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  );
  const e = out.events[0];
  assert.equal(e.provider, "zai");
  assert.equal(e.cost.stated, undefined);
  // 1000 in at $0.60, 250 out at $2.20, 40K reads at $0.11, 3K writes billed as input.
  const want = (1000 * 0.6 + 250 * 2.2 + 40_000 * 0.11 + 3000 * 0.6) / 1e6;
  assert.equal(e.cost.total.toFixed(8), want.toFixed(8));
});

test("the catalogue provider wins and unrecognised provider ids stay unknown", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [
        message("msg_1", { modelID: "claude-sonnet-5", providerID: "openai" }),
        message("msg_2", { modelID: "custom-model", providerID: "not-a-provider" }, T0 + 2000),
      ],
      parts: [step("prt_1", "msg_1", TOKENS), step("prt_2", "msg_2", TOKENS, T0 + 3000)],
    }),
  );
  assert.deepEqual(
    out.events.map((e) => e.provider),
    ["anthropic", "unknown"],
  );
});

test("OpenAI opencode cold returns match identical Codex calls", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [
        message("msg_1", { modelID: "gpt-5.4" }),
        message("msg_2", { modelID: "gpt-5.4" }, T0 + 600_000),
      ],
      parts: [
        step("prt_1", "msg_1", { ...TOKENS, cache: { read: 60_000, write: 0 } }),
        step(
          "prt_2",
          "msg_2",
          { ...TOKENS, input: 70_000, cache: { read: 0, write: 0 } },
          T0 + 601_000,
        ),
      ],
    }),
  );
  const cold = coldResumes(out.events);
  const codex = coldResumes(out.events.map((e) => ({ ...e, source: "codex" })));
  const metrics = (list) =>
    list.map(({ gapMinutes, ttlMinutes, rewriteTokens, rewriteUsd, warmUsd }) => ({
      gapMinutes,
      ttlMinutes,
      rewriteTokens,
      rewriteUsd,
      warmUsd,
    }));
  assert.equal(cold.length, 1);
  assert.deepEqual(metrics(cold), metrics(codex));
  assert.equal(cachesOnItsOwn({ ...out.events[0], provider: "anthropic" }), false);
  assert.equal(cachesOnItsOwn({ ...out.events[0], provider: "google" }), true);
  assert.equal(cachesOnItsOwn({ ...out.events[0], source: "sdk" }), false);
});

test("a parent_id cycle neither hangs nor drops calls", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session({ parent_id: "ses_b" }), session({ id: "ses_b", parent_id: "ses_a" })],
      messages: [message("msg_1", {})],
      parts: [step("prt_1", "msg_1", TOKENS)],
    }),
  );
  assert.equal(out.events.length, 1);
});

test("a compaction after a finished reply is not mid-task", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", {}, T0), message("msg_2", { summary: true }, T0 + 10_000)],
      parts: [
        step("prt_1", "msg_1", TOKENS, T0 + 1000, "stop"),
        step("prt_2", "msg_2", TOKENS, T0 + 11_000),
      ],
    }),
  );
  assert.equal(out.compactions.length, 1);
  assert.equal(out.compactions[0].midTask, false);
});

const sqlite = await loadSqlite();
const noSqlite = sqlite ? false : "node:sqlite needs Node 22.13+";

/** opencode's tables and indexes, with WAL so a writer can stay open. */
function opencodeDb(t, fill) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-"));
  const file = path.join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(file);
  let closed = false;
  function close() {
    db.close();
    closed = true;
  }
  t.after(() => {
    if (!closed) close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
      slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL,
      model text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE INDEX part_session_idx ON part (session_id);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
  `);
  fill?.(db);
  return { file, db, close };
}

function insertSession(db, id, at, over = {}) {
  db.prepare(
    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated) VALUES (?, 'p', ?, 's', ?, ?, '1.19.0', ?, ?, ?)",
  ).run(
    id,
    over.parent ?? null,
    over.directory ?? "/home/someone/project",
    over.title ?? "A session",
    JSON.stringify({ id: "claude-sonnet-5", providerID: "anthropic", variant: "high" }),
    at,
    at,
  );
}

function insertCall(db, sid, n, at, data = {}) {
  const mid = `msg_${sid}_${n}`;
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    mid,
    sid,
    at,
    at,
    JSON.stringify({ role: "assistant", parentID: "msg_u", modelID: "claude-sonnet-5", ...data }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    `prt_${sid}_${n}a`,
    mid,
    sid,
    at,
    at,
    JSON.stringify({
      type: "tool",
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: { filePath: "/a" },
        output: "x".repeat(321),
        metadata: { large: "discard" },
      },
    }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    `prt_${sid}_${n}b`,
    mid,
    sid,
    at + 1,
    at + 1,
    JSON.stringify({ type: "step-finish", reason: "stop", tokens: TOKENS, cost: 0 }),
  );
  db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(at + 1, sid);
}

test(
  "ingestOpencode reads calls, titles, window and tool output size",
  { skip: noSqlite },
  async (t) => {
    const { file, close } = opencodeDb(t, (db) => {
      insertSession(db, "ses_a", T0, { title: "Fix the parser" });
      insertCall(db, "ses_a", 1, T0 + 1000);
    });
    close();
    const data = await ingestOpencode({ db: file });
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].tools[0].resultChars, 321);
    assert.deepEqual(data.titles, { ses_a: "Fix the parser" });
    assert.deepEqual(data.sources, [file]);
    assert.deepEqual(data.warnings, []);
    assert.deepEqual(data.window, { from: data.events[0].ts, to: data.events[0].ts, days: 1 });
  },
);

test(
  "reads committed calls while a WAL writer holds an uncommitted write",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = opencodeDb(t, (db) => insertSession(db, "ses_a", T0));
    insertCall(db, "ses_a", 1, T0 + 1000);
    db.exec("BEGIN IMMEDIATE");
    insertCall(db, "ses_a", 2, T0 + 2000);
    try {
      const data = await ingestOpencode({ db: file });
      assert.deepEqual(
        data.events.map((e) => e.id),
        ["ses_a#prt_ses_a_1b"],
      );
      assert.deepEqual(data.warnings, []);
    } finally {
      db.exec("ROLLBACK");
    }
  },
);

test(
  "days bounds sessions but keeps their history for compactions",
  { skip: noSqlite },
  async (t) => {
    const now = Date.now();
    const old = now - 20 * 86_400_000;
    const { file } = opencodeDb(t, (db) => {
      insertSession(db, "ses_old", old);
      insertCall(db, "ses_old", 1, old);
      insertSession(db, "ses_new", old);
      insertCall(db, "ses_new", 1, old);
      insertCall(db, "ses_new", 2, now - 4000, { summary: true });
      insertCall(db, "ses_new", 3, now - 2000);
    });
    const data = await ingestOpencode({ db: file, days: 7, project: "PROJECT" });
    assert.deepEqual(
      data.events.map((e) => e.id),
      ["ses_new#prt_ses_new_2b", "ses_new#prt_ses_new_3b"],
    );
    assert.equal(data.events[1].contextEpoch, 1);
    assert.equal(data.compactions[0].preTokens, 44_000);
    assert.equal((await ingestOpencode({ db: file, project: "elsewhere" })).events.length, 0);
  },
);

test(
  "readOpencodeRows retains old ancestors and accepts explicit session ids",
  { skip: noSqlite },
  (t) => {
    const { db } = opencodeDb(t, (db) => {
      insertSession(db, "ses_root", T0);
      insertCall(db, "ses_root", 1, T0);
      insertSession(db, "ses_child", T0 + 2000, { parent: "ses_root", directory: "" });
      insertCall(db, "ses_child", 1, T0 + 2000);
    });
    for (const opts of [{ since: T0 + 1000 }, { sessionIds: ["ses_child"], since: 1e15 }]) {
      const read = readOpencodeRows(db, opts);
      assert.equal(read.sessions.length, 2);
      assert.deepEqual(
        read.messages.map((m) => m.session_id),
        ["ses_child"],
      );
      assert.equal(mapOpencodeRows(read).events[0].sessionId, "ses_root");
      assert.equal(mapOpencodeRows(read).events[0].project, "/home/someone/project");
      const state = JSON.parse(read.parts[0].data).state;
      assert.equal(state.output, undefined);
      assert.equal(state.metadata, undefined);
      assert.equal(read.parts[0].output_chars, 321);
    }
    assert.equal(readOpencodeRows(db, { sessionIds: [] }).messages.length, 0);
  },
);

test(
  "malformed SQL rows join the mapper's warning and are scoped to selected sessions",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = opencodeDb(t, (db) => {
      const old = Date.now() - 20 * 86_400_000;
      insertSession(db, "ses_old", old);
      insertCall(db, "ses_old", 1, old);
      insertSession(db, "ses_a", Date.now() - 5000);
      insertCall(db, "ses_a", 1, Date.now() - 4000);
    });
    db.prepare("UPDATE part SET data = ? WHERE id = ?").run("{oops", "prt_ses_a_1a");
    db.prepare("UPDATE message SET data = ? WHERE session_id = ?").run("{oops", "ses_old");
    const one = await ingestOpencode({ db: file, days: 7 });
    assert.equal(one.events.length, 1);
    assert.deepEqual(one.warnings, ["opencode: skipped 1 unparseable row(s)"]);
    db.prepare("UPDATE message SET time_created = ? WHERE session_id = ?").run(1e30, "ses_a");
    assert.deepEqual((await ingestOpencode({ db: file, days: 7 })).warnings, [
      "opencode: skipped 2 unparseable row(s)",
    ]);
    assert.deepEqual((await ingestOpencode({ db: file })).warnings, [
      "opencode: skipped 3 unparseable row(s)",
    ]);
  },
);

test("reader chunks ids and uses opencode's message and part indexes", { skip: noSqlite }, (t) => {
  const { db } = opencodeDb(t, (db) => {
    for (let i = 0; i < 501; i++) {
      insertSession(db, `ses_${i}`, T0);
      insertCall(db, `ses_${i}`, 1, T0);
    }
  });
  const queries = [];
  const read = readOpencodeRows({
    prepare(sql) {
      return {
        all(...params) {
          queries.push({ sql, params });
          return db.prepare(sql).all(...params);
        },
      };
    },
    close() {},
  });
  assert.equal(read.messages.length, 501);
  assert.equal(read.parts.length, 1002);
  for (const [table, index] of [
    ["part", "part_session_idx"],
    ["message", "message_session_time_created_id_idx"],
  ]) {
    const selected = queries.filter(
      ({ sql }) => sql.includes(`FROM ${table} `) && !sql.includes("count(*)"),
    );
    assert.equal(selected.length, 2);
    for (const { sql, params } of selected) {
      assert.ok(params.length <= 500);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((r) => r.detail)
        .join("\n");
      assert.ok(plan.includes(index), plan);
      assert.doesNotMatch(plan, /SCAN (?:p|m)\b/);
    }
  }
});

test("mapper errors become an ingestion warning", { skip: noSqlite }, async (t) => {
  const { file } = opencodeDb(t, (db) => {
    insertSession(db, "ses_a", T0);
    insertCall(db, "ses_a", 1, T0);
  });
  const data = await ingestOpencode({
    db: file,
    project: {
      toLowerCase() {
        throw new Error("mapper failed");
      },
    },
  });
  assert.equal(data.events.length, 0);
  assert.deepEqual(data.warnings, [`${OPENCODE_READ_FAILED} (opencode.db: mapper failed)`]);
});

test("reader keeps more parts than one call can take as arguments", () => {
  // 500 busy sessions can return 120k parts in one chunk; push(...parts) overflowed.
  const parts = Array.from({ length: 200_000 }, (_, i) => ({ id: `prt_${i}` }));
  const read = readOpencodeRows(
    {
      prepare(sql) {
        return {
          all() {
            if (sql.includes("count(*)")) return [{ bad: 0 }];
            if (sql.includes("FROM part")) return parts;
            if (sql.includes("FROM session")) return [{ id: "ses_a" }];
            return [];
          },
        };
      },
      close() {},
    },
    { sessionIds: ["ses_a"] },
  );
  assert.equal(read.parts.length, parts.length);
});

test("a missing database warns before checking SQLite availability", async () => {
  const data = await ingestOpencode({
    db: path.join(process.cwd(), ".no-such-opencode-dir", "opencode.db"),
  });
  assert.equal(data.events.length, 0);
  assert.ok(data.warnings[0].startsWith("No opencode history found at"));
});

test("no opencode at the default path adds no note", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-none-"));
  const was = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  t.after(() => {
    if (was === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = was;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const data = await ingestOpencode();
  assert.equal(data.events.length, 0);
  assert.deepEqual(data.warnings, []);
});

/** The profile over one Claude Code call, beside the opencode database `write` leaves. */
function profileBeside(t, write) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projects = path.join(dir, ".claude", "projects", "-home-someone-project");
  fs.mkdirSync(projects, { recursive: true });
  const call = {
    type: "assistant",
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    sessionId: "s1",
    cwd: "/home/someone/project",
    message: {
      id: "m1",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5000 },
    },
  };
  fs.writeFileSync(path.join(projects, "s1.jsonl"), JSON.stringify(call) + "\n");
  const xdg = path.join(dir, ".local", "share");
  fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
  write(path.join(xdg, "opencode", "opencode.db"));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        XDG_DATA_HOME: xdg,
        CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
        CODEX_HOME: path.join(dir, ".codex"),
        OPTIMAIZR_DIR: path.join(dir, ".optimaizr"),
        OPTIMAIZR_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /nothing to analyse yet/);
  return result.stdout;
}

test("the profile says when opencode history was left out", (t) => {
  // Left out on every Node: too old for node:sqlite, or only opencode 2.0 history.
  const stdout = profileBeside(t, (file) => {
    if (sqlite) {
      const db = new sqlite.DatabaseSync(file);
      db.exec(
        "CREATE TABLE session_v2 (id text PRIMARY KEY); INSERT INTO session_v2 VALUES ('v2');",
      );
      db.close();
    } else {
      fs.writeFileSync(file, "not sqlite");
    }
  });
  assert.ok(
    stdout.includes(`note: ${sqlite ? OPENCODE_V2_WARNING : OPENCODE_SQLITE_WARNING}`),
    stdout,
  );
});

test("the profile says when opencode history failed to read", { skip: noSqlite }, (t) => {
  // A 1.x database the reader's queries fail on.
  const stdout = profileBeside(t, (file) => {
    const db = new sqlite.DatabaseSync(file);
    db.exec("CREATE TABLE session (id text PRIMARY KEY)");
    db.close();
  });
  assert.ok(stdout.includes(`note: ${OPENCODE_READ_FAILED} (opencode.db: `), stdout);
});

test("an existing non-database file warns, including when SQLite is unavailable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "opencode.db");
  fs.writeFileSync(file, "not sqlite");
  const data = await ingestOpencode({ db: file });
  assert.equal(data.events.length, 0);
  assert.equal(data.warnings.length, 1);
  if (!sqlite)
    assert.equal(
      data.warnings[0],
      `opencode history skipped: it needs Node 22.13 or later, and this is Node ${process.versions.node} (nvm install 22, or update Node)`,
    );
});

test("a database with an incompatible schema warns", { skip: noSqlite }, async (t) => {
  const { file, db } = opencodeDb(t, (db) => insertSession(db, "ses_a", T0));
  db.exec("DROP TABLE part");
  const data = await ingestOpencode({ db: file });
  assert.equal(data.events.length, 0);
  assert.equal(data.warnings.length, 1);
});

test(
  "an opencode 2.0 database warns instead of failing on the 1.x tables",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = opencodeDb(t);
    db.exec("DROP TABLE part; DROP TABLE message; DROP TABLE session;");
    db.exec(
      "CREATE TABLE session_v2 (id text PRIMARY KEY); INSERT INTO session_v2 VALUES ('ses_v2');",
    );
    const data = await ingestOpencode({ db: file });
    assert.equal(data.events.length, 0);
    assert.deepEqual(data.warnings, [OPENCODE_V2_WARNING]);
  },
);

test(
  "a database with 1.x and 2.0 history reads 1.x and warns about 2.0",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = opencodeDb(t, (db) => {
      insertSession(db, "ses_a", T0);
      insertCall(db, "ses_a", 1, T0 + 1000);
    });
    db.exec("CREATE TABLE session_v2 (id text PRIMARY KEY)");
    assert.deepEqual((await ingestOpencode({ db: file })).warnings, []);
    db.exec("INSERT INTO session_v2 VALUES ('ses_v2')");
    const data = await ingestOpencode({ db: file });
    assert.equal(data.events.length, 1);
    assert.deepEqual(data.warnings, [OPENCODE_V2_WARNING]);
  },
);

test("loadSqlite suppresses only its SQLite ExperimentalWarning", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { loadSqlite } from '@optimaizr/core';
    const before = process.emitWarning;
    const first = loadSqlite();
    if (first !== loadSqlite()) throw new Error('loader is not cached');
    await first;
    if (process.emitWarning !== before) throw new Error('warning hook not restored');
    process.emitWarning('unrelated warning');
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /ExperimentalWarning/);
  assert.match(child.stderr, /unrelated warning/);
});

test("the database lives under XDG_DATA_HOME when set", () => {
  const before = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = " /tmp/xdg ";
    assert.equal(opencodeDbPath(), path.join(path.resolve("/tmp/xdg"), "opencode", "opencode.db"));
    process.env.XDG_DATA_HOME = "~/data";
    assert.equal(opencodeDbPath(), path.join(os.homedir(), "data", "opencode", "opencode.db"));
    process.env.XDG_DATA_HOME = " ";
    assert.equal(
      opencodeDbPath(),
      path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    );
    delete process.env.XDG_DATA_HOME;
    assert.equal(
      opencodeDbPath(),
      path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"),
    );
  } finally {
    if (before === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = before;
  }
});

test(
  "a pinned transcripts root never reads the opencode database",
  { skip: noSqlite },
  async (t) => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "xdg-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "empty-root-"));
    t.after(() => {
      fs.rmSync(xdg, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(xdg, "opencode"));
    const { file, close } = opencodeDb(t, (db) => {
      insertSession(db, "ses_a", Date.now() - 5000);
      insertCall(db, "ses_a", 1, Date.now() - 4000);
    });
    close();
    fs.renameSync(file, path.join(xdg, "opencode", "opencode.db"));
    const before = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = xdg;
      const pinned = await ingest([{ kind: "local-transcripts", root }]);
      assert.equal(pinned.events.filter((e) => e.source === "opencode").length, 0);
      const all = await ingest([{ kind: "local-transcripts" }]);
      assert.equal(all.events.filter((e) => e.source === "opencode").length, 1);
    } finally {
      if (before === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = before;
    }
  },
);

test("opencode calls are conversations, and cache-watch follows them", () => {
  // Over COLD_MIN_CONTEXT (50K), with a cache write, so the conversation counts as warm.
  const big = { ...TOKENS, cache: { read: 60_000, write: 3000 } };
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", { modelID: "claude-sonnet-5" })],
      parts: [step("prt_1", "msg_1", big)],
    }),
  );
  assert.deepEqual(
    conversations(out).map((c) => [c.sessionId, c.source, c.title]),
    [["ses_a", "opencode", "Fix the parser"]],
  );
  const e = out.events[0];
  const at = Date.parse(e.ts) + 1000;
  const watch = createCacheWatch();
  watch.push(e);
  assert.equal(watch.warm(at).length, 1, "an opencode conversation is followed");
  const sdk = createCacheWatch();
  sdk.push({ ...e, source: "sdk" });
  assert.equal(sdk.warm(at).length, 0, "the same call from an app is not");
});

test("context-watch follows opencode context growth in main conversations only", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session()],
      messages: [message("msg_1", {})],
      parts: [
        step("prt_1", "msg_1", TOKENS),
        step("prt_2", "msg_1", { ...TOKENS, input: 100_000 }, T0 + 2000),
      ],
    }),
  );
  const watch = createContextWatch({ long: 100_000 });
  assert.deepEqual(watch.push(out.events[0]), []);
  assert.deepEqual(
    watch.push(out.events[1]).map((n) => [n.kind, n.contextTokens, n.added]),
    [
      ["jump", 143_000, 99_000],
      ["long", 143_000, undefined],
    ],
  );
  for (const over of [{ source: "sdk" }, { isSubagent: true }]) {
    const excluded = createContextWatch({ long: 100_000 });
    for (const e of out.events) assert.deepEqual(excluded.push({ ...e, ...over }), []);
  }
});

test("a subagent's compaction moves its epoch but isn't counted", () => {
  const out = mapOpencodeRows(
    rows({
      sessions: [session({ parent_id: "ses_parent" })],
      messages: [
        message("msg_1", {}, T0),
        message("msg_2", { summary: true }, T0 + 10_000),
        message("msg_3", {}, T0 + 20_000),
      ],
      parts: [
        step("prt_1", "msg_1", TOKENS, T0 + 1000),
        step("prt_2", "msg_2", TOKENS, T0 + 11_000),
        step("prt_3", "msg_3", TOKENS, T0 + 21_000),
      ],
    }),
  );
  assert.deepEqual(out.compactions, []);
  assert.equal(out.events[2].contextEpoch, 1);
});
