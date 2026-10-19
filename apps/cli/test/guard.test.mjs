import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  guardSaved,
  handoffNote,
  renderGuardCatch,
  savedText,
  transcriptFacts,
  weekCompare,
  weekText,
} from "@optimaizr/core";
import {
  applyGuard,
  guardApplied,
  guardHook,
  readReceipts,
  saveWeekLine,
  tailReceipts,
  undoGuard,
} from "@optimaizr/local";
import { bash, edit, load, START, transcript } from "./fixtures/transcripts.mjs";

/**
 * 0.12: guard, the Claude Code hooks that hold a costly step once and let it
 * through when it comes again. Installed next to someone's own hooks, never
 * over them.
 */

const MIN = 60_000;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `optimaizr-${name}-`));
const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const lines = (recs) => recs.map((r) => JSON.stringify(r));

function write(dir, name, recs) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines(recs).join("\n") + "\n");
  return file;
}

/** A long Claude Code conversation on Opus with a 1-hour cache: about 151K. */
function longConversation(session, extra = []) {
  const script = [{ prompt: "build the parser" }, { out: 300, ctx: 0, write: 150_000, hour: true }];
  for (let i = 0; i < 3; i++) {
    script.push({
      tools: [edit(`/w/src/p${i}.ts`)],
      out: 300,
      ctx: 150_000,
      write: 1_000,
      hour: true,
    });
  }
  return [...transcript(session, script), ...extra];
}

const reply = (session, text, at = START + 5 * MIN) => ({
  type: "assistant",
  timestamp: new Date(at).toISOString(),
  sessionId: session,
  message: { id: `${session}-r`, content: [{ type: "text", text }] },
});

test("the transcript says what failed, what changed and where the work stands", () => {
  const recs = transcript("s", [
    { prompt: "fix the tests" },
    { tools: [bash("npm test", { error: true })] },
    { tools: [bash("npm test", { error: true })] },
    { prompt: "[Request interrupted by user]" },
    { prompt: "<system-reminder>not typed</system-reminder>" },
  ]);
  let f = transcriptFacts(lines(recs));
  assert.equal(f.failing.get("npm test"), 2);
  assert.equal(f.lastPrompt, "fix the tests", "added text is not the person's prompt");

  // A change that works ends the streak, and its file is noted once.
  const more = transcript("s", [
    { tools: [edit("/w/a.ts")] },
    { tools: [bash("npm test", { error: true })] },
    { tools: [edit("/w/b.ts")] },
    { tools: [edit("/w/a.ts")] },
  ]);
  f = transcriptFacts(lines([...recs, ...more]));
  assert.equal(f.failing.size, 0);
  assert.deepEqual(f.edited, ["/w/b.ts", "/w/a.ts"]);

  // A hold is not the command failing again.
  const held = {
    type: "user",
    sessionId: "s",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: recs.find((r) => r.type === "assistant").message.content[0].id,
          content: "optimAIzr held this retry: ...",
          is_error: true,
        },
      ],
    },
  };
  assert.equal(transcriptFacts(lines([...recs, held])).failing.get("npm test"), 2);

  // Claude Code's own record of the last prompt wins; a subagent's lines don't count.
  const side = { ...reply("s", "from a subagent"), isSidechain: true };
  f = transcriptFacts(
    lines([
      ...recs,
      reply("s", "Fixed the import."),
      side,
      { type: "last-prompt", lastPrompt: "and the lint?", sessionId: "s" },
      { type: "attachment", entrypoint: "claude-vscode", sessionId: "s" },
    ]),
  );
  assert.equal(f.lastPrompt, "and the lint?");
  assert.equal(f.lastReply, "Fixed the import.");
  assert.equal(f.entrypoint, "claude-vscode");
});

test("the handoff note is the last ask, the files changed, open todos and the last reply", () => {
  const todos = {
    type: "assistant",
    sessionId: "s",
    message: {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "write the parser", status: "completed" },
              { content: "add tests", status: "in_progress" },
            ],
          },
        },
      ],
    },
  };
  const recs = [
    ...longConversation("s"),
    todos,
    reply("s", "The parser   handles\nnested lists now."),
  ];
  const note = handoffNote(transcriptFacts(lines(recs)), "/w");
  assert.equal(
    note,
    [
      "Asked last: build the parser",
      "Changed: src/p0.ts, src/p1.ts, src/p2.ts",
      "Still open: add tests",
      "Last reply: The parser handles nested lists now.",
    ].join("\n"),
  );
  assert.equal(handoffNote(transcriptFacts([])), null);
});

test("the note says what was tried and dropped: failed runs, edits turned down or undone", () => {
  const recs = transcript("s", [
    { prompt: "make the e2e pass" },
    { tools: [bash("npm run e2e", { error: true })] },
    { tools: [bash("npm run e2e", { error: true })] },
    { tools: [bash("grep -rn nothing src", { error: true })] },
    { tools: [bash("npm run build", { error: true })] },
    { tools: [bash("npm run build")] },
    { tools: [edit("/w/src/a.ts", "x")] },
    {
      tools: [
        { name: "Edit", input: { file_path: "/w/src/a.ts", old_string: "x!", new_string: "x" } },
      ],
    },
  ]);
  const refused = [
    {
      type: "assistant",
      sessionId: "s",
      message: {
        content: [
          { type: "tool_use", id: "no1", name: "Write", input: { file_path: "/w/src/b.ts" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: "s",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "no1",
            is_error: true,
            content: "The user doesn't want to proceed with this tool use.",
          },
        ],
      },
    },
  ];
  const f = transcriptFacts(lines([...recs, ...refused]));
  assert.deepEqual(f.dropped, [
    { kind: "failed", command: "npm run e2e", times: 2 },
    { kind: "undone", file: "/w/src/a.ts" },
    { kind: "declined", file: "/w/src/b.ts" },
  ]);
  assert.match(
    handoffNote(f, "/w"),
    /\nDropped: npm run e2e \(failed 2 times\); a change to src\/a\.ts, undone; an edit to src\/b\.ts, turned down$/,
  );
});

test("guard on sets its hooks next to someone's own, and off takes out only its own", () => {
  const dir = tmp("guard-install");
  const opts = { claudeSettings: path.join(dir, "settings.json"), dir: path.join(dir, "guard") };
  const own = { matcher: "Bash", hooks: [{ type: "command", command: "~/my-check.sh" }] };
  fs.writeFileSync(
    opts.claudeSettings,
    JSON.stringify({ model: "opus", hooks: { PreToolUse: [own] } }),
  );

  const cmd = '"/usr/local/bin/node" "/lib/node_modules/optimaizr/dist/cli.js" guard hook';
  const r = applyGuard(cmd, opts);
  assert.ok(r.ok && r.changed);
  const s = JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8"));
  assert.equal(s.model, "opus");
  assert.deepEqual(s.hooks.PreToolUse[0], own, "their hook stays first and unchanged");
  assert.deepEqual(s.hooks.PreToolUse[1], {
    matcher: "Read|Bash",
    hooks: [{ type: "command", command: cmd, timeout: 10 }],
  });
  assert.deepEqual(Object.keys(s.hooks).sort(), [
    "PreToolUse",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  assert.equal(s.hooks.SessionStart[0].matcher, "clear");
  assert.equal(s.hooks.SessionEnd[0].matcher, "clear");
  assert.ok(guardApplied(opts));
  assert.equal(applyGuard(cmd, opts).changed, false, "a second on changes nothing");

  // A reinstall from another path moves the command, without adding a second one.
  const moved = '"/opt/node" "/opt/lib/node_modules/optimaizr/dist/cli.js" guard hook';
  assert.ok(applyGuard(moved, opts).changed);
  const after = JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8"));
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop[0].hooks[0].command, moved);

  assert.ok(undoGuard(opts).ok);
  assert.deepEqual(JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8")), {
    model: "opus",
    hooks: { PreToolUse: [own] },
  });
  assert.equal(undoGuard(opts), null);
  assert.equal(guardApplied(opts), false);

  // Through npx, or with every hook turned off, nothing is written.
  assert.match(applyGuard(null, opts).detail, /npm i -g optimaizr/);
  fs.writeFileSync(opts.claudeSettings, JSON.stringify({ disableAllHooks: true }));
  assert.equal(applyGuard(cmd, opts).ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8")), {
    disableAllHooks: true,
  });
});

test("a message to an expired cache is held once, and the next conversation starts from the note", () => {
  const dir = tmp("guard-cold");
  const opts = { dir: path.join(dir, "guard") };
  const file = write(dir, "s1", longConversation("s1", [reply("s1", "Parser done; tests next.")]));
  const prompt = {
    hook_event_name: "UserPromptSubmit",
    session_id: "s1",
    transcript_path: file,
    cwd: "/w",
  };
  const later = START + 3 * 60 * MIN;

  // Still warm: nothing to hold.
  assert.equal(guardHook(prompt, { ...opts, now: START + 30 * MIN }), null);

  const held = guardHook(prompt, { ...opts, now: later });
  assert.equal(held.decision, "block");
  assert.match(held.reason, /held this message once/);
  assert.match(held.reason, /idle 2h 58m/);
  assert.match(held.reason, /writes all 151K tokens again: about \$1\.2\d on Opus 5\.5/);
  assert.match(held.reason, /copy it from Original prompt below\. Send it again to go ahead/);
  assert.match(held.reason, /On Sonnet 5\.5 the same rewrite is about \$0\.6\d: \/model sonnet/);

  // The same conversation does not read its own note; its /clear does, once.
  const start = (session, source = "clear") => ({
    hook_event_name: "SessionStart",
    session_id: session,
    source,
    cwd: "/w",
  });
  const end = { hook_event_name: "SessionEnd", session_id: "s1", reason: "clear", cwd: "/w" };
  assert.equal(guardHook(start("s1"), { ...opts, now: later + MIN }), null);
  assert.equal(guardHook(end, { ...opts, now: later + MIN }), null);
  const fresh = guardHook(start("s2"), { ...opts, now: later + MIN });
  const context = fresh.hookSpecificOutput.additionalContext;
  assert.match(context, /started with a \/clear of the one before it/);
  assert.match(context, /it had been idle 2h 58m and its cache had expired/);
  assert.match(context, /the work being picked up here, as it stood 2h 58m ago/);
  assert.match(
    context,
    /Asked last: build the parser\nChanged: src\/p0\.ts, src\/p1\.ts, src\/p2\.ts\nLast reply: Parser done; tests next\./,
  );
  assert.equal(guardHook(start("s3"), { ...opts, now: later + 2 * MIN }), null);

  // Sent again, it goes through.
  assert.equal(guardHook(prompt, { ...opts, now: later + 3 * MIN }), null);
  assert.deepEqual(
    readReceipts(0, opts).map((r) => r.kind),
    ["cold-hold", "handoff-used", "cold-sent"],
  );
});

test("the note goes to a /clear of the held conversation, not another one in the folder", () => {
  const dir = tmp("guard-clear");
  const opts = { dir: path.join(dir, "guard") };
  const later = START + 3 * 60 * MIN;
  const held = write(dir, "s1", longConversation("s1"));
  const prompt = {
    hook_event_name: "UserPromptSubmit",
    session_id: "s1",
    transcript_path: held,
    cwd: "/w",
  };
  assert.ok(guardHook(prompt, { ...opts, now: later }));
  const start = (session, source = "clear") => ({
    hook_event_name: "SessionStart",
    session_id: session,
    source,
    cwd: "/w",
  });
  // A /clear ends the old conversation first, then starts the new one.
  const end = (session, reason = "clear") => ({
    hook_event_name: "SessionEnd",
    session_id: session,
    reason,
    cwd: "/w",
  });
  const at = { ...opts, now: later + MIN };

  // Another conversation in the folder is cleared: it starts on its own.
  assert.equal(guardHook(end("s2"), at), null);
  assert.equal(guardHook(start("s3"), at), null);
  assert.equal(guardHook(start("s4", "startup"), at), null);
  // The held one closed without a /clear marks nothing either.
  assert.equal(guardHook(end("s1", "prompt_input_exit"), at), null);
  assert.equal(guardHook(start("s3"), at), null);
  assert.equal(fs.readdirSync(path.join(opts.dir, "handoffs")).length, 1, "kept for s1");

  guardHook(end("s1"), { ...opts, now: later + 2 * MIN });
  const fresh = guardHook(start("s5"), { ...opts, now: later + 2 * MIN });
  assert.match(fresh.hookSpecificOutput.additionalContext, /Asked last: build the parser/);
  assert.deepEqual(
    readReceipts(0, opts).map((r) => [r.kind, r.session]),
    [
      ["cold-hold", "s1"],
      ["handoff-used", "s5"],
    ],
  );
});

test("a cold hold leaves headless runs, small rewrites and stale notes alone", () => {
  const dir = tmp("guard-cold-skip");
  const opts = { dir: path.join(dir, "guard") };
  const later = START + 3 * 60 * MIN;
  const input = (file, session) => ({
    hook_event_name: "UserPromptSubmit",
    session_id: session,
    transcript_path: file,
    cwd: "/w",
  });

  const sdk = write(dir, "sdk", [
    ...longConversation("sdk"),
    { type: "attachment", entrypoint: "sdk-cli", sessionId: "sdk" },
  ]);
  assert.equal(
    guardHook(input(sdk, "sdk"), { ...opts, now: later }),
    null,
    "nobody is there to send it again",
  );

  const small = write(
    dir,
    "small",
    transcript("small", [{ prompt: "hi" }, { out: 100, ctx: 0, write: 40_000, hour: true }]),
  );
  assert.equal(guardHook(input(small, "small"), { ...opts, now: later }), null);

  // A note nobody picked up in 30 minutes is dropped, not read.
  const file = write(dir, "s1", longConversation("s1"));
  assert.ok(guardHook(input(file, "s1"), { ...opts, now: later }));
  const start = { hook_event_name: "SessionStart", session_id: "s9", source: "clear", cwd: "/w" };
  assert.equal(guardHook(start, { ...opts, now: later + 31 * MIN }), null);
  assert.deepEqual(fs.readdirSync(path.join(opts.dir, "handoffs")), []);
});

test("a whole big file is held once per conversation; a range, a small file or an image is not", () => {
  const dir = tmp("guard-read");
  const opts = { dir: path.join(dir, "guard") };
  const big = path.join(dir, "big.ts");
  fs.writeFileSync(big, `${"x".repeat(49)}\n`.repeat(2_000));
  const long = path.join(dir, "long.log");
  // Claude Code stops after 2000 lines, and those are under the line.
  fs.writeFileSync(long, `${"y".repeat(29)}\n`.repeat(5_000));
  const small = path.join(dir, "small.ts");
  fs.writeFileSync(small, "const a = 1;\n");
  const png = path.join(dir, "shot.png");
  fs.writeFileSync(png, Buffer.alloc(200_000));

  const readOf = (input, session = "s1") => ({
    hook_event_name: "PreToolUse",
    session_id: session,
    cwd: dir,
    tool_name: "Read",
    tool_input: input,
  });
  const out = guardHook(readOf({ file_path: big }), opts);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /big\.ts is 98KB, and a whole read sends about 25K tokens of it/,
  );
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /read it again and it will go through/,
  );
  assert.equal(guardHook(readOf({ file_path: big }), opts), null, "read again, it goes through");
  // A lockfile past 2000 lines: its real size, and what a whole read sends of it.
  const lock = path.join(dir, "package-lock.json");
  fs.writeFileSync(lock, `${"z".repeat(32)}\n`.repeat(5_000));
  assert.match(
    guardHook(readOf({ file_path: lock }), opts).hookSpecificOutput.permissionDecisionReason,
    /package-lock\.json is 161KB, and a whole read sends about 17K tokens of it/,
  );
  assert.ok(
    guardHook(readOf({ file_path: "big.ts" }, "s2"), opts),
    "another conversation, held again",
  );

  assert.equal(guardHook(readOf({ file_path: big, limit: 200 }, "s3"), opts), null);
  assert.equal(guardHook(readOf({ file_path: long }), opts), null);
  assert.equal(guardHook(readOf({ file_path: small }), opts), null);
  assert.equal(guardHook(readOf({ file_path: png }), opts), null);
  assert.equal(guardHook(readOf({ file_path: path.join(dir, "missing.ts") }), opts), null);
});

test("a command that failed twice with nothing changed is held once per streak", () => {
  const dir = tmp("guard-retry");
  const opts = { dir: path.join(dir, "guard") };
  const fails = [
    { prompt: "run the tests" },
    { tools: [bash("npm test", { error: true })] },
    { tools: [bash("npm test", { error: true })] },
  ];
  const file = write(dir, "s1", transcript("s1", fails));
  const bashOf = (command, extra = {}) => ({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    transcript_path: file,
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  });

  assert.equal(guardHook(bashOf("npm run lint"), opts), null, "another command runs");
  const out = guardHook(bashOf("  npm test "), opts);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /held this retry/);
  assert.equal(guardHook(bashOf("npm test"), opts), null, "run again, it goes through");
  assert.equal(
    guardHook(bashOf("npm test", { agent_id: "a1" }), { dir: path.join(dir, "other") }),
    null,
  );

  // A change that worked, then two more failures: a new streak, held again.
  write(dir, "s1", transcript("s1", [...fails, { tools: [edit("/w/a.ts")] }, ...fails.slice(1)]));
  assert.ok(guardHook(bashOf("npm test"), opts));
  assert.deepEqual(
    readReceipts(0, opts).map((r) => [r.kind, r.detail]),
    [
      ["retry", "npm test"],
      ["retry-sent", "npm test"],
      ["retry", "npm test"],
    ],
  );
});

test("near the compaction point the end of a turn says so, once per conversation", () => {
  const dir = tmp("guard-stop");
  const opts = { dir: path.join(dir, "guard") };
  const file = write(dir, "s1", longConversation("s1"));
  const stop = { hook_event_name: "Stop", session_id: "s1", transcript_path: file };

  assert.equal(guardHook(stop, { ...opts, compactAt: 400_000 }), null, "far from it");
  const out = guardHook(stop, { ...opts, compactAt: 200_000 });
  assert.equal(
    out.systemMessage,
    "optimAIzr: this conversation is at 151K and compacts at 200K. If this task is done, /compact now (or /clear), so it does not compact in the middle of the next one.",
  );
  assert.equal(guardHook(stop, { ...opts, compactAt: 200_000 }), null);
  assert.equal(guardHook({ hook_event_name: "Notification" }, opts), null);
});

test("only holds that stuck count as saved", () => {
  const at = (m) => new Date(START + m * MIN).toISOString();
  const r = (m, kind, extra = {}) => ({ at: at(m), session: "s1", kind, ...extra });
  const saved = guardSaved([
    // Sent again anyway: the hold did nothing.
    r(1, "cold-hold", { usd: 2 }),
    r(2, "cold-sent", { usd: 2 }),
    // Started fresh from the note instead.
    r(3, "cold-hold", { session: "s2", usd: 3 }),
    // Read whole after all, then another file held and left.
    r(4, "big-read", { detail: "/w/a.ts", usd: 0.4 }),
    r(5, "big-read-sent", { detail: "/w/a.ts" }),
    r(6, "big-read", { detail: "/w/b.ts", usd: 0.5 }),
    // A retry held twice: run again the first time, not the second.
    r(7, "retry", { detail: "npm test" }),
    r(8, "retry-sent", { detail: "npm test" }),
    r(9, "retry", { detail: "npm test" }),
    r(10, "compact-nudge"),
  ]);
  assert.deepEqual(saved, { catches: 3, usd: 3.5 });
  assert.equal(savedText(saved), "3 catches, $3.50 not spent");
  assert.equal(savedText({ catches: 1, usd: 0 }), "1 catch");
  assert.equal(savedText({ catches: 0, usd: 0 }), null);
});

test("a whole read or a retry that goes through the second time says so once", () => {
  const dir = tmp("guard-sent");
  const opts = { dir: path.join(dir, "guard") };
  const big = path.join(dir, "big.ts");
  fs.writeFileSync(big, `${"x".repeat(49)}\n`.repeat(2_000));
  const readOf = { hook_event_name: "PreToolUse", session_id: "s1", cwd: dir, tool_name: "Read" };
  for (let i = 0; i < 3; i++) guardHook({ ...readOf, tool_input: { file_path: big } }, opts);
  assert.deepEqual(
    readReceipts(0, opts).map((x) => x.kind),
    ["big-read", "big-read-sent"],
  );
  assert.deepEqual(guardSaved(readReceipts(0, opts)), { catches: 0, usd: 0 });
});

test("the week line: the last 7 days against the 7 before", async () => {
  const later = START + 2 * 86_400_000;
  const data = await load({
    s1: transcript("s1", [
      { prompt: "build it" },
      { out: 300, ctx: 0, write: 150_000 },
      { out: 300, ctx: 150_000, write: 1_000 },
      { prompt: "carry on", gap: 30 },
      { out: 300, ctx: 0, write: 152_000 },
    ]),
  });
  const w = weekCompare(data.events, later);
  assert.equal(w.cold, 1);
  assert.equal(w.rereadShareBefore, null, "nothing the week before");
  assert.ok(w.rereadShare > 0 && w.rereadShare < 1);
  assert.equal(weekCompare(data.events, later + 8 * 86_400_000), null, "a quiet week");
  assert.equal(
    weekText({ rereadShare: 0.28, rereadShareBefore: 0.56, cold: 1, coldBefore: 5, spendUsd: 9 }),
    "re-reading 28% of spend (was 56%), 1 return to a cold cache (was 5)",
  );
});

test("the first end of a turn in a week works the line out, and a later one shows it once", () => {
  const dir = tmp("guard-week");
  const opts = { dir: path.join(dir, "guard"), compactAt: 400_000, now: Date.now() };
  const file = write(dir, "s1", longConversation("s1"));
  const stop = { hook_event_name: "Stop", session_id: "s1", transcript_path: file };
  let runs = 0;
  const weekRun = () => runs++;

  assert.equal(guardHook(stop, { ...opts, weekRun }), null, "nothing worked out yet");
  assert.equal(guardHook(stop, { ...opts, weekRun }), null);
  assert.equal(runs, 1, "worked out once a week, in the background");

  saveWeekLine("re-reading 28% of spend (was 56%), 2 returns to a cold cache (was 5)", opts);
  fs.appendFileSync(
    path.join(opts.dir, "receipts.jsonl"),
    `${JSON.stringify({ at: new Date(opts.now).toISOString(), session: "s0", kind: "cold-hold", usd: 1.2 })}\n`,
  );
  assert.equal(
    guardHook(stop, { ...opts, weekRun }).systemMessage,
    "optimAIzr, your last 7 days: re-reading 28% of spend (was 56%), 2 returns to a cold cache (was 5). Guard: 1 catch, $1.20 not spent.",
  );
  assert.equal(guardHook(stop, { ...opts, weekRun }), null, "once a week");

  const sdk = write(dir, "sdk", [
    ...longConversation("sdk"),
    { type: "attachment", entrypoint: "sdk-cli", sessionId: "sdk" },
  ]);
  const fresh = { ...opts, dir: path.join(dir, "other"), weekRun };
  assert.equal(guardHook({ ...stop, session_id: "sdk", transcript_path: sdk }, fresh), null);
  assert.equal(runs, 1, "a headless run starts nothing");
});

test("live picks up what guard did from now on, and says it in a line", () => {
  const dir = tmp("guard-tail");
  const opts = { dir: path.join(dir, "guard") };
  const tail = tailReceipts(opts);
  assert.deepEqual(tail.poll(), []);

  const file = write(
    dir,
    "s1",
    transcript("s1", [
      { tools: [bash("make", { error: true })] },
      { tools: [bash("make", { error: true })] },
    ]),
  );
  guardHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      transcript_path: file,
      tool_name: "Bash",
      tool_input: { command: "make" },
    },
    opts,
  );
  const got = tail.poll();
  assert.equal(got.length, 1);
  assert.deepEqual(tail.poll(), [], "each once");
  assert.match(
    strip(renderGuardCatch(got[0])),
    /Guard held a retry\n\s+make failed twice with nothing changed, so it was not run a third time/,
  );
  // With a title the line names the conversation, so two at once stay apart.
  assert.match(
    strip(renderGuardCatch(got[0], { title: (id) => (id === "s1" ? "Fix the build" : undefined) })),
    /Guard held a retry {2}Fix the build\n/,
  );

  const cold = {
    at: new Date(START).toISOString(),
    session: "s",
    kind: "cold-hold",
    usd: 3.24,
    tokens: 405_000,
  };
  assert.match(
    strip(renderGuardCatch(cold)),
    /Guard held a message\n\s+Its cache had expired, so sending it writes 405\.0K again: \$3\.24 at stake\./,
  );
});

test("`optimaizr guard hook` answers Claude Code in JSON, and says nothing on bad input", () => {
  const dir = tmp("guard-cli");
  const env = { ...process.env, OPTIMAIZR_DIR: dir, OPTIMAIZR_NO_UPDATE_CHECK: "1" };
  const big = path.join(dir, "big.ts");
  fs.writeFileSync(big, "x".repeat(100_000));
  const run = (input) =>
    execFileSync(process.execPath, [CLI, "guard", "hook"], { input, env, encoding: "utf8" });

  const input = {
    hook_event_name: "PreToolUse",
    session_id: "s",
    cwd: dir,
    tool_name: "Read",
    tool_input: { file_path: big },
  };
  const out = JSON.parse(run(JSON.stringify(input)));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run(JSON.stringify(input)), "");
  assert.equal(run("not json"), "");
  assert.equal(run(""), "");
});

test("`optimaizr guard` alone says it is off and what it would hold", () => {
  const dir = tmp("guard-status");
  const env = {
    ...process.env,
    OPTIMAIZR_DIR: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    OPTIMAIZR_NO_UPDATE_CHECK: "1",
  };
  const out = strip(execFileSync(process.execPath, [CLI, "guard"], { env, encoding: "utf8" }));
  assert.match(out, /Guard\s+off/);
  assert.match(
    out,
    /Cold cache\s+a message to a conversation idle past its cache, when the rewrite is \$0\.50 or more/,
  );
  assert.match(out, /Last 7 days\s+nothing held/);
  assert.match(out, /optimaizr guard on turns it on/);
});
