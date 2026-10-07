import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  coldResumes,
  createCacheWatch,
  findWaste,
  renderCacheExpiring,
  renderColdReturn,
  renderStatusline,
} from "@optimaizr/core";
import {
  applyStatusline,
  latestClaudeTranscript,
  statuslineApplied,
  statuslineCommand,
  transcriptCacheState,
  undoStatusline,
} from "@optimaizr/local";
import { emptyStatus, recordCall, renderStatus } from "optimaizr";
import { codexRollout, load, loadCodex, read, transcript } from "./fixtures/transcripts.mjs";

/**
 * 0.10: the cache as it happens. Codex returns to a cold cache, the countdown
 * and cold notice in `live`, and the line `optimaizr statusline` prints under
 * Claude Code's prompt, turned on and off with `optimaizr statusline on|off`.
 */

const MIN = 60_000;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `optimaizr-${name}-`));
const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const near = (a, b) => Math.abs(a - b) < 1e-9;

/** A long Claude Code conversation picked up once after `gap` minutes. */
function comeback({ gap = 90, size = 150_000 } = {}) {
  const script = [{ prompt: "build it" }, { out: 300, ctx: 0, write: size, hour: true }];
  for (let i = 0; i < 4; i++) {
    script.push({ tools: [read(`/w/a${i}.ts`)], out: 300, ctx: size, write: 2_000, hour: true });
  }
  script.push({ prompt: "carry on", gap });
  script.push({ out: 300, ctx: 0, write: size + 10_000, hour: true });
  script.push({ out: 300, ctx: size + 10_000, write: 1_000, hour: true });
  return script;
}

/** A long Codex conversation picked up `returns` times, the cache gone each time. */
function codexComeback({ returns = 1, gap = 20, size = 250_000 } = {}) {
  const script = [{ prompt: "go" }, { ctx: size, cached: 0 }, { ctx: size + 1_000 }];
  for (let r = 0; r < returns; r++) {
    script.push({ prompt: "back", gap });
    script.push({ ctx: size + 2_000, cached: 2_000 });
    script.push({ ctx: size + 3_000 });
  }
  return script;
}

/* ------------------------------------------------------------------ *
 * Codex returns to a cold cache
 * ------------------------------------------------------------------ */

test("a Codex return after an idle gap is priced as uncached input", async () => {
  const data = await loadCodex({ c1: codexRollout("c1", codexComeback()) });
  const cold = coldResumes(data.events);
  assert.equal(cold.length, 1);
  const c = cold[0];
  assert.equal(c.ttlMinutes, null, "OpenAI decides the lifetime itself");
  assert.equal(c.rewriteTokens, 250_000);
  // GPT-5.4: $2.50 a million uncached, $0.25 cached.
  assert.ok(near(c.rewriteUsd, 0.625));
  assert.ok(near(c.warmUsd, 0.0625));
  assert.match(strip(renderColdReturn(c)), /sent 250\.0K again uncached/);
});

test("a short pause in Codex is not a cold return", async () => {
  const data = await loadCodex({ c1: codexRollout("c1", codexComeback({ gap: 3 })) });
  assert.equal(coldResumes(data.events).length, 0);
});

test("the cold-resume rule says resent for Codex, not rewrote", async () => {
  const data = await loadCodex({ c1: codexRollout("c1", codexComeback({ returns: 3 })) });
  const finding = findWaste(data).find((f) => f.rule === "cold-resume");
  assert.ok(finding);
  assert.match(finding.title, /^3 returns to an expired cache resent/);
  assert.match(finding.why, /OpenAI keeps a conversation cached only while it is in use/);
  assert.match(finding.why, /0\.1x/);
  assert.match(finding.fix, /^Before you step away/);
  assert.doesNotMatch(finding.fix, /\/optimaizr handoff/, "the mod is Claude Code only");
});

/* ------------------------------------------------------------------ *
 * The cache watch behind `live` and the status line
 * ------------------------------------------------------------------ */

test("the watch finds the cold return as it arrives, and only that one", async () => {
  const data = await load({ s1: transcript("s1", comeback()) });
  const watch = createCacheWatch();
  const found = data.events.map((e) => watch.push(e)).filter(Boolean);
  assert.equal(found.length, 1);
  assert.equal(found[0].ttlMinutes, 60);
  assert.equal(found[0].rewriteTokens, 160_000);
  assert.deepEqual(found, coldResumes(data.events), "live and history agree");
});

test("the expiry warning comes once, in the last five minutes, priced at the 1-hour write", async () => {
  const data = await load({ s1: transcript("s1", comeback()) });
  const watch = createCacheWatch();
  for (const e of data.events) watch.push(e);
  const last = Date.parse(data.events.at(-1).ts);
  const s = watch.latest();
  assert.equal(s.expiresAt, last + 55 * MIN, "called a little early, at 55 of the 60 minutes");
  // 161,010 tokens of context: $8 a million to write again, $0.20 to read.
  assert.ok(near(s.rewriteUsd, (161_010 * 8) / 1e6));
  assert.ok(near(s.readUsd, (161_010 * 0.2) / 1e6));

  assert.deepEqual(watch.expiring(last + 40 * MIN), [], "15 minutes left is not yet");
  const soon = watch.expiring(last + 51 * MIN);
  assert.equal(soon.length, 1);
  assert.deepEqual(watch.expiring(last + 52 * MIN), [], "said once");
  assert.match(strip(renderCacheExpiring(soon[0], last + 51 * MIN)), /Cache expires in 4m/);
  assert.match(strip(renderCacheExpiring(soon[0], last + 51 * MIN)), /handoff note/);
  assert.deepEqual(watch.expiring(last + 56 * MIN), [], "nothing once it has gone");
});

test("warm lists long conversations soonest to expire first, and skips short and subagent ones", async () => {
  const a = await load({ a: transcript("a", comeback()) });
  const b = await load({ b: transcript("b", comeback({ gap: 120 })) });
  const small = await load({ s: transcript("s", comeback({ size: 20_000 })) });
  const watch = createCacheWatch();
  for (const e of [...a.events, ...b.events, ...small.events]) watch.push(e);
  watch.push({ ...a.events.at(-1), id: "side", sessionId: "side", isSubagent: true });

  const first = Date.parse(a.events.at(-1).ts);
  const warm = watch.warm(first + MIN);
  assert.deepEqual(
    warm.map((s) => s.event.sessionId),
    ["a", "b"],
  );
  assert.deepEqual(
    watch.warm(first + 56 * MIN).map((s) => s.event.sessionId),
    ["b"],
    "a has expired, b came back later",
  );
});

test("the live status line shows the warm cache", async () => {
  const data = await load({ s1: transcript("s1", comeback()) });
  const watch = createCacheWatch();
  const status = emptyStatus();
  status.cache = watch;
  for (const e of data.events) {
    watch.push(e);
    recordCall(status, e);
  }
  const last = Date.parse(data.events.at(-1).ts);
  assert.match(strip(renderStatus(status, last + 10 * MIN, 200)), /cache 161\.0K warm 45m/);
  assert.match(strip(renderStatus(status, last + 50 * MIN, 200)), /cache 161\.0K warm 5m/);
});

/* ------------------------------------------------------------------ *
 * optimaizr statusline
 * ------------------------------------------------------------------ */

const state = (over = {}) => ({
  event: { ts: new Date(0).toISOString() },
  context: 150_000,
  expiresAt: 60 * MIN,
  readUsd: 0.03,
  rewriteUsd: 1.2,
  ...over,
});

test("the status line: context, re-read cost and how long the cache stays warm", () => {
  const line = renderStatusline({
    state: state(),
    fiveHour: { usedPercent: 61.4, resetsAt: null },
    sevenDay: { usedPercent: 40, resetsAt: null },
    now: 18 * MIN,
    color: false,
  });
  assert.equal(
    line,
    "◉ optimAIzr · 150.0K context, $0.030/call to re-read · cache warm 42m · 5h 61%",
  );
});

test("the status line counts down, then says what the next message costs", () => {
  const soon = renderStatusline({ state: state(), now: 48 * MIN, color: false });
  assert.match(soon, /cache warm 12m, then \$1\.20 to write again/);
  assert.match(soon, /leaving\? handoff note, then \/clear/);

  const gone = renderStatusline({ state: state(), now: 61 * MIN, color: false });
  assert.match(gone, /cache expired, next message writes it all again \(\$1\.20\)/);
  assert.match(gone, /new task\? \/clear first/);
});

test("a short conversation gets no countdown, and the weekly meter shows only when high", () => {
  const short = renderStatusline({
    state: state({ context: 30_000 }),
    sevenDay: { usedPercent: 82, resetsAt: null },
    now: 48 * MIN,
    color: false,
  });
  assert.equal(short, "◉ optimAIzr · 30.0K context · week 82%");
  assert.equal(
    renderStatusline({ state: null, contextTokens: null, now: 0, color: false }),
    "◉ optimAIzr",
  );
});

test("the status line reads the cache state from the end of a real transcript", async () => {
  const dir = tmp("tail");
  const file = path.join(dir, "s1.jsonl");
  const recs = transcript("s1", comeback());
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const s = transcriptCacheState(file);
  assert.equal(s.context, 161_010);
  assert.equal(s.expiresAt, Date.parse(recs.at(-1).timestamp) + 55 * MIN);

  // Starting mid-file drops the cut line and still finds the last call.
  const tail = transcriptCacheState(file, 3_000);
  assert.equal(tail.event.ts, s.event.ts);
  assert.equal(transcriptCacheState(path.join(dir, "missing.jsonl")), null);
});

test("turning the status line on sets it, keeps someone's own, and off takes it out", () => {
  const dir = tmp("statusline");
  const opts = {
    claudeSettings: path.join(dir, "claude", "settings.json"),
    record: path.join(dir, "optimaizr", "statusline.json"),
  };
  fs.mkdirSync(path.dirname(opts.claudeSettings), { recursive: true });
  fs.writeFileSync(opts.claudeSettings, JSON.stringify({ model: "opus" }));

  const cmd = '"/usr/local/bin/node" "/lib/node_modules/optimaizr/dist/cli.js" statusline';
  const r = applyStatusline(cmd, opts);
  assert.ok(r.ok && r.changed);
  const settings = JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8"));
  assert.equal(settings.model, "opus", "the rest of the file is kept");
  assert.deepEqual(settings.statusLine, { type: "command", command: cmd, refreshInterval: 30 });
  assert.ok(statuslineApplied(opts));
  assert.equal(applyStatusline(cmd, opts).changed, false, "a second apply changes nothing");

  assert.ok(undoStatusline(opts).ok);
  assert.deepEqual(JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8")), { model: "opus" });
  assert.equal(undoStatusline(opts), null);

  const own = { statusLine: { type: "command", command: "~/my-line.sh" } };
  fs.writeFileSync(opts.claudeSettings, JSON.stringify(own));
  const kept = applyStatusline(cmd, opts);
  assert.equal(kept.ok, false);
  assert.match(kept.detail, /leaves it alone/);
  assert.deepEqual(JSON.parse(fs.readFileSync(opts.claudeSettings, "utf8")), own);
  assert.equal(undoStatusline(opts), null, "undo never touches someone else's line");
});

test("the command runs this node and script by full path, never through npx", () => {
  assert.equal(
    statuslineCommand("/opt/lib/node_modules/optimaizr/dist/cli.js", "/opt/bin/node"),
    '"/opt/bin/node" "/opt/lib/node_modules/optimaizr/dist/cli.js" statusline',
  );
  assert.equal(
    statuslineCommand("/Users/me/.npm/_npx/abc/node_modules/optimaizr/dist/cli.js", "/n"),
    null,
  );
  assert.equal(
    applyStatusline(null, { claudeSettings: path.join(tmp("npx"), "s.json") }).ok,
    false,
  );
});

test("the latest conversation is the transcript written to last", () => {
  const root = tmp("projects");
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "b"));
  fs.writeFileSync(path.join(root, "a", "old.jsonl"), "");
  fs.writeFileSync(path.join(root, "b", "new.jsonl"), "");
  fs.writeFileSync(path.join(root, "b", "notes.txt"), "");
  fs.utimesSync(path.join(root, "a", "old.jsonl"), new Date(1_000), new Date(1_000));
  assert.equal(latestClaudeTranscript(root), path.join(root, "b", "new.jsonl"));
  assert.equal(latestClaudeTranscript(path.join(root, "missing")), null);
});

/* ------------------------------------------------------------------ *
 * The commands, run as Claude Code and a person would
 * ------------------------------------------------------------------ */

const CLI = path.join(new URL("..", import.meta.url).pathname, "dist/cli.js");
const skip = fs.existsSync(CLI) ? false : "dist/cli.js is not built";

/** Run the built CLI in an empty home, with `stdin` piped in. */
function cli(home, args, stdin = "") {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      input: stdin,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
        NO_COLOR: "1",
      },
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout) };
  }
}

test("statusline on and off, from a pipe as well as a terminal", { skip }, () => {
  const home = tmp("cli");
  const settings = path.join(home, ".claude", "settings.json");
  const line = () => JSON.parse(fs.readFileSync(settings, "utf8")).statusLine;

  // Claude Code's Bash tool has no terminal either, so on must not wait for input.
  const on = cli(home, ["statusline", "on"]);
  assert.equal(on.status, 0);
  assert.match(on.stdout, /Applied/);
  assert.match(on.stdout, /optimaizr statusline off/);
  assert.match(line().command, /cli\.js" statusline$/);
  assert.match(cli(home, ["statusline", "on"]).stdout, /Already on/);

  assert.match(cli(home, ["statusline", "off"]).stdout, /Reverted/);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine, undefined);
  assert.match(cli(home, ["statusline", "off"]).stdout, /has not set/);

  // The names it had before still work.
  assert.match(cli(home, ["apply", "statusline"]).stdout, /Applied/);
  assert.match(cli(home, ["undo", "statusline"]).stdout, /Reverted/);

  const wrong = cli(home, ["statusline", "maybe"]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /optimaizr statusline on \| off/);
});

test("the line Claude Code runs reads the session from stdin", { skip }, () => {
  const home = tmp("cli");
  const file = path.join(home, "s1.jsonl");
  const recs = transcript("s1", comeback());
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const input = JSON.stringify({
    transcript_path: file,
    rate_limits: { five_hour: { used_percentage: 61, resets_at: 0 } },
  });
  const { stdout } = cli(home, ["statusline"], input);
  assert.match(stdout, /^◉ optimAIzr · 161\.0K context, \$0\.032\/call to re-read · /);
  assert.match(stdout, /5h 61%\n$/);
  assert.equal(cli(home, ["statusline"], "not json").stdout, "◉ optimAIzr\n");
});

test("sessions answers as JSON and as text", { skip }, async () => {
  const home = tmp("cli");
  const dir = path.join(home, ".claude", "projects", "-w");
  fs.mkdirSync(dir, { recursive: true });
  const recs = transcript("s1", comeback());
  fs.writeFileSync(
    path.join(dir, "s1.jsonl"),
    recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const sessions = cli(home, ["sessions", "--days", "100000", "--json"]);
  assert.equal(sessions.status, 0);
  assert.equal(JSON.parse(sessions.stdout).sessions, 1);
  assert.match(cli(home, ["sessions", "--days", "100000"]).stdout, /optimAIzr \| sessions/);
});
