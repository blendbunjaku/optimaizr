import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyCompaction,
  applyGuard,
  applyStatusline,
  guardApplied,
  guardHook,
  guardHooks,
  readReceipts,
  settingsManaged,
  shownCommand,
  undoGuard,
  writeFileAtomic,
} from "@optimaizr/local";
import { bash, transcript } from "./fixtures/transcripts.mjs";

/**
 * 0.13.1: what optimAIzr writes outside its own folder, and what guard keeps on
 * disk. Settings are written in one step or not at all, someone who keeps them
 * by hand is shown the change instead, and a held command is kept as a hash.
 */

const DAY = 86_400_000;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
const CMD = '"/usr/local/bin/node" "/lib/node_modules/optimaizr/dist/cli.js" guard hook';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `optimaizr-${name}-`));
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Run `fn` with optimAIzr's own folder set to `dir`, as a config file there needs. */
function withHome(dir, fn) {
  const before = process.env.OPTIMAIZR_DIR;
  process.env.OPTIMAIZR_DIR = dir;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.OPTIMAIZR_DIR;
    else process.env.OPTIMAIZR_DIR = before;
  }
}

test("a file is written whole: no temp file left, and its mode kept", () => {
  const dir = tmp("atomic");
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "old", { mode: 0o600 });
  writeFileAtomic(file, "new\n");
  assert.equal(fs.readFileSync(file, "utf8"), "new\n");
  assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A folder that is not there yet is made.
  const deep = path.join(dir, "a", "b.json");
  writeFileAtomic(deep, "{}\n");
  assert.equal(fs.readFileSync(deep, "utf8"), "{}\n");
});

test(
  "a symlinked settings file stays a symlink, and the file it points at is the one changed",
  { skip: process.platform === "win32" },
  () => {
    const dir = tmp("symlink");
    const real = path.join(dir, "dotfiles", "claude-settings.json");
    const link = path.join(dir, "claude", "settings.json");
    fs.mkdirSync(path.dirname(real));
    fs.mkdirSync(path.dirname(link));
    fs.writeFileSync(real, JSON.stringify({ model: "opus" }));
    fs.symlinkSync(real, link);

    const r = applyGuard(CMD, { claudeSettings: link, dir: path.join(dir, "guard") });
    assert.ok(r.ok && r.changed);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(read(real).model, "opus");
    assert.equal(read(real).hooks.Stop[0].hooks[0].command, CMD);
    assert.deepEqual(fs.readdirSync(path.dirname(real)), ["claude-settings.json"]);
  },
);

test(
  "a settings file that can't be written is left as it was, and guard says why",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  () => {
    const dir = tmp("readonly");
    const locked = path.join(dir, "claude");
    fs.mkdirSync(locked);
    const file = path.join(locked, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ model: "opus" }));
    fs.chmodSync(locked, 0o555);
    try {
      const opts = { claudeSettings: file, dir: path.join(dir, "guard") };
      const r = applyGuard(CMD, opts);
      assert.equal(r.ok, false);
      assert.match(r.detail, /could not write .*settings\.json/);
      assert.deepEqual(read(file), { model: "opus" });
      // Nothing claims guard is on.
      assert.equal(fs.existsSync(path.join(dir, "guard", "installed.json")), false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  },
);

test("guard print is the hooks guard on would set, and writes nothing", () => {
  const dir = tmp("print");
  const opts = { claudeSettings: path.join(dir, "settings.json"), dir: path.join(dir, "guard") };
  applyGuard(CMD, opts);
  assert.deepEqual(guardHooks(CMD), read(opts.claudeSettings).hooks);

  const home = tmp("print-cli");
  const env = {
    ...process.env,
    OPTIMAIZR_DIR: home,
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    OPTIMAIZR_NO_UPDATE_CHECK: "1",
  };
  const out = JSON.parse(
    execFileSync(process.execPath, [CLI, "guard", "print"], { env, encoding: "utf8" }),
  );
  assert.deepEqual(Object.keys(out.hooks), [
    "UserPromptSubmit",
    "PreToolUse",
    "SessionStart",
    "SessionEnd",
    "Stop",
  ]);
  const command = out.hooks.PreToolUse[0].hooks[0].command;
  assert.equal(out.hooks.PreToolUse[0].matcher, "Read|Bash");
  // Full paths to this node and this cli.js, so it runs whatever the shell's PATH says.
  assert.match(command, /^".+" ".+cli\.js" guard hook$/);
  assert.ok(command.includes(process.execPath.replaceAll("\\", "/")));
  assert.equal(fs.existsSync(path.join(home, "claude", "settings.json")), false);
});

test("with manageSettings false nothing writes Claude Code's or Codex's settings", () => {
  const dir = tmp("hands-off");
  const claude = path.join(dir, "settings.json");
  const codex = path.join(dir, "config.toml");
  fs.writeFileSync(claude, JSON.stringify({ model: "opus" }));
  fs.writeFileSync(codex, 'model = "gpt-5"\n');
  assert.equal(settingsManaged(path.join(dir, "config.json")), true, "on unless said otherwise");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ manageSettings: false }));
  assert.equal(settingsManaged(path.join(dir, "config.json")), false);

  withHome(dir, () => {
    const g = applyGuard(CMD, { claudeSettings: claude, dir: path.join(dir, "guard") });
    assert.equal(g.ok, false);
    assert.match(g.detail, /manageSettings is false/);
    assert.match(g.detail, /optimaizr guard print/);

    const s = applyStatusline('"node" "/x/optimaizr/cli.js" statusline', {
      claudeSettings: claude,
      record: path.join(dir, "statusline.json"),
    });
    assert.equal(s.ok, false);
    assert.match(s.detail, /"statusLine": \{"type":"command"/);

    const c = applyCompaction(["claude-code", "codex"], {
      claudeSettings: claude,
      codexConfig: codex,
      ledger: path.join(dir, "compaction.json"),
      journal: path.join(dir, "changes.jsonl"),
    });
    assert.deepEqual(
      c.map((r) => r.ok),
      [false, false],
    );
    assert.match(c[0].detail, /"env": \{ "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000" \}/);
    assert.match(c[1].detail, /model_auto_compact_token_limit = 200000/);
    // Nothing is on record as applied, so results never measures a change not made.
    assert.equal(fs.existsSync(path.join(dir, "changes.jsonl")), false);
  });
  assert.deepEqual(read(claude), { model: "opus" });
  assert.equal(fs.readFileSync(codex, "utf8"), 'model = "gpt-5"\n');
});

test("with manageSettings false, hooks someone added by hand count as on and are not taken out", () => {
  const dir = tmp("hands-off-on");
  const claude = path.join(dir, "settings.json");
  const opts = { claudeSettings: claude, dir: path.join(dir, "guard") };
  fs.writeFileSync(claude, JSON.stringify({ hooks: guardHooks(CMD) }));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ manageSettings: false }));
  withHome(dir, () => {
    assert.equal(guardApplied(opts), true);
    const on = applyGuard(CMD, opts);
    assert.ok(on.ok && !on.changed, "already there: nothing to print");
    const off = undoGuard(opts);
    assert.equal(off.ok, false);
    assert.match(off.detail, /out of .*settings\.json yourself/);
  });
  assert.deepEqual(read(claude).hooks, guardHooks(CMD));
});

test("`optimaizr guard on` with manageSettings false prints the hooks instead", () => {
  const home = tmp("hands-off-cli");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ manageSettings: false }));
  const env = {
    ...process.env,
    OPTIMAIZR_DIR: home,
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
    OPTIMAIZR_NO_UPDATE_CHECK: "1",
  };
  const r = spawnSync(process.execPath, [CLI, "guard", "on"], { env, encoding: "utf8" });
  assert.equal(JSON.parse(r.stdout).hooks.Stop[0].hooks[0].timeout, 10);
  assert.equal(fs.existsSync(path.join(home, "claude", "settings.json")), false);
});

test("a held command is kept as a hash, and its receipt hides what looks like a secret", () => {
  const dir = tmp("marks");
  const opts = { dir: path.join(dir, "guard") };
  const secret = 'PGPASSWORD=hunter2 psql -h db -c "select 1"';
  const fails = [
    { prompt: "check the db" },
    { tools: [bash(secret, { error: true })] },
    { tools: [bash(secret, { error: true })] },
  ];
  const file = path.join(dir, "s1.jsonl");
  fs.writeFileSync(
    file,
    transcript("s1", fails)
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    transcript_path: file,
    tool_name: "Bash",
    tool_input: { command: secret },
  };
  assert.ok(guardHook(input, opts), "held");
  assert.equal(guardHook(input, opts), null, "the same command is known again by its hash");

  const marks = fs.readFileSync(path.join(opts.dir, "marks.json"), "utf8");
  assert.doesNotMatch(marks, /hunter2|psql|PGPASSWORD/);
  assert.match(marks, /retry\|s1\|[^|]+\|[0-9a-f]{16}"/);
  const receipts = fs.readFileSync(path.join(opts.dir, "receipts.jsonl"), "utf8");
  assert.doesNotMatch(receipts, /hunter2/);
  assert.deepEqual(
    readReceipts(0, opts).map((r) => [r.kind, r.detail]),
    [
      ["retry", 'PGPASSWORD=*** psql -h db -c "select 1"'],
      ["retry-sent", 'PGPASSWORD=*** psql -h db -c "select 1"'],
    ],
  );
});

test("what a receipt shows of a command: its start, secrets starred out", () => {
  assert.equal(shownCommand("npm test"), "npm test");
  assert.equal(
    shownCommand('curl -H "Authorization: Bearer sk-abc123def456ghi" https://api.example.com'),
    'curl -H "Authorization: Bearer ***" https://api.example.com',
  );
  assert.equal(shownCommand("API_KEY='a b c' ./run.sh"), "API_KEY=*** ./run.sh");
  assert.equal(shownCommand("mysql --password s3cret -u me"), "mysql --password *** -u me");
  assert.equal(
    shownCommand("git push https://me:ghp_abcdef123456@github.com/me/repo.git"),
    "git push https://me:***@github.com/me/repo.git",
  );
  const long = shownCommand(`echo ${"x".repeat(200)}`);
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("..."));
});

test("marks written before 0.13.1 with the command in them are dropped at the next mark", () => {
  const dir = tmp("marks-old");
  const opts = { dir: path.join(dir, "guard") };
  fs.mkdirSync(opts.dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(opts.dir, "marks.json"),
    JSON.stringify({
      "retry|s0|start|PGPASSWORD=hunter2 psql": now - 1000,
      "retry|s0|start|PGPASSWORD=hunter2 psql|sent": now - 900,
      "read|s0|/w/big.log": now - 1000,
      "week|2026-11-09": now - 1000,
    }),
  );
  const big = path.join(dir, "big.ts");
  fs.writeFileSync(big, "x".repeat(100_000));
  const read1 = {
    hook_event_name: "PreToolUse",
    session_id: "s1",
    cwd: dir,
    tool_name: "Read",
    tool_input: { file_path: big },
  };
  assert.ok(guardHook(read1, { ...opts, now }));
  const marks = read(path.join(opts.dir, "marks.json"));
  assert.deepEqual(Object.keys(marks).sort(), [
    "read|s0|/w/big.log",
    `read|s1|${big}`,
    "week|2026-11-09",
  ]);
});

test("receipts older than 30 days and notes nobody read are dropped as hooks come in", () => {
  const dir = tmp("retention");
  const opts = { dir: path.join(dir, "guard") };
  const notes = path.join(opts.dir, "handoffs");
  fs.mkdirSync(notes, { recursive: true });
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const receipts = path.join(opts.dir, "receipts.jsonl");
  const rows = [
    { at: at(45 * DAY), session: "a", kind: "retry", detail: "old" },
    { at: at(31 * DAY), session: "a", kind: "cold-hold", usd: 2 },
    { at: at(29 * DAY), session: "b", kind: "big-read", detail: "/w/x.log" },
    { at: at(DAY), session: "c", kind: "handoff-used", detail: "b" },
  ];
  fs.writeFileSync(receipts, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const stale = path.join(notes, "-w-old.json");
  const fresh = path.join(notes, "-w-new.json");
  fs.writeFileSync(stale, JSON.stringify({ version: 2, text: "the last prompt" }));
  fs.writeFileSync(fresh, JSON.stringify({ version: 2, text: "the last prompt" }));
  const old = new Date(now - 31 * 60_000);
  fs.utimesSync(stale, old, old);

  // A tool call leaves it all alone: those come many times a minute.
  guardHook({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Grep" }, opts);
  assert.equal(readReceipts(0, opts).length, 4);
  assert.ok(fs.existsSync(stale));

  // The end of any turn tidies, whatever else it has to say.
  guardHook({ hook_event_name: "Stop", session_id: "s" }, { ...opts, now });
  assert.deepEqual(
    readReceipts(0, opts).map((r) => r.session),
    ["b", "c"],
  );
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(fresh));
  assert.deepEqual(
    fs.readdirSync(opts.dir).sort(),
    ["handoffs", "receipts.jsonl"],
    "no temp file left behind",
  );

  // Nothing old enough: the file is not rewritten.
  const before = fs.statSync(receipts).mtimeMs;
  guardHook({ hook_event_name: "Stop", session_id: "s" }, { ...opts, now });
  assert.equal(fs.statSync(receipts).mtimeMs, before);
});

test("guard off takes its unread notes with it", () => {
  const dir = tmp("off-notes");
  const opts = { claudeSettings: path.join(dir, "settings.json"), dir: path.join(dir, "guard") };
  applyGuard(CMD, opts);
  const notes = path.join(opts.dir, "handoffs");
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, "-w-app.json"), JSON.stringify({ version: 2, text: "x" }));
  const r = undoGuard(opts);
  assert.ok(r.ok);
  assert.equal(fs.existsSync(notes), false);
});
