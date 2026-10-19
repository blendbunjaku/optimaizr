import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createContextWatch, renderContextNotice } from "@optimaizr/core";
import { applyCompaction, compactionStatus, undoCompaction } from "@optimaizr/local";
import {
  createLivePrompt,
  emptyStatus,
  QUORUM,
  recordCall,
  renderNow,
  renderRunSummary,
  renderStatus,
} from "optimaizr";
import { transcript } from "./fixtures/transcripts.mjs";

const execFileAsync = promisify(execFile);

/**
 * 0.9's live: a status line that says it is working, a word when a
 * conversation's context jumps or passes the compaction line, and a real,
 * undoable way to compact earlier in Claude Code and Codex.
 */

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `optimaizr-${name}-`));
const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

function files() {
  const dir = tmp("compact");
  return {
    claudeSettings: path.join(dir, "claude", "settings.json"),
    codexConfig: path.join(dir, "codex", "config.toml"),
    ledger: path.join(dir, "optimaizr", "settings-changes.json"),
  };
}

/* ------------------------------------------------------------------ *
 * Compaction, applied and undone
 * ------------------------------------------------------------------ */

test("Claude Code: the env is merged into settings.json and undone exactly", () => {
  const p = files();
  fs.mkdirSync(path.dirname(p.claudeSettings), { recursive: true });
  fs.writeFileSync(p.claudeSettings, JSON.stringify({ model: "opus", env: { FOO: "1" } }));

  const [r] = applyCompaction(["claude-code"], p);
  assert.equal(r.ok, true);
  assert.match(r.detail, /CLAUDE_CODE_AUTO_COMPACT_WINDOW unset -> 200000/);
  // Claude Code compacts short of the window it is given.
  assert.match(r.detail, /Claude Code compacts a little before 200K from its next session/);
  const after = JSON.parse(fs.readFileSync(p.claudeSettings, "utf8"));
  assert.deepEqual(after, {
    model: "opus",
    env: { FOO: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" },
  });
  assert.equal(compactionStatus(p)["claude-code"], "200000");

  // Applying again changes nothing and keeps the original for undo.
  assert.match(applyCompaction(["claude-code"], p)[0].detail, /already compacts at 200000/);

  undoCompaction(p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, "utf8")), {
    model: "opus",
    env: { FOO: "1" },
  });
  assert.equal(compactionStatus(p)["claude-code"], null);
});

test("Claude Code: no settings file is created, then removed cleanly", () => {
  const p = files();
  applyCompaction(["claude-code"], p);
  undoCompaction(p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.claudeSettings, "utf8")), {});
});

test("Codex: the key goes in at top level, before any table, and comments survive", () => {
  const p = files();
  fs.mkdirSync(path.dirname(p.codexConfig), { recursive: true });
  const original = [
    "# my config",
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.docs]",
    'command = "docs"',
    "",
  ].join("\n");
  fs.writeFileSync(p.codexConfig, original);

  const [r] = applyCompaction(["codex"], p);
  assert.equal(r.ok, true);
  assert.match(r.detail, /model_auto_compact_token_limit unset -> 200000/);
  const text = fs.readFileSync(p.codexConfig, "utf8");
  const lines = text.split("\n");
  assert.ok(
    lines.indexOf("model_auto_compact_token_limit = 200000") < lines.indexOf("[mcp_servers.docs]"),
  );
  assert.ok(text.startsWith("# my config\n"));
  assert.equal(compactionStatus(p).codex, "200000");

  undoCompaction(p);
  assert.equal(fs.readFileSync(p.codexConfig, "utf8"), original);
});

test("Codex: an existing limit is replaced, and undo puts the old one back", () => {
  const p = files();
  fs.mkdirSync(path.dirname(p.codexConfig), { recursive: true });
  fs.writeFileSync(p.codexConfig, "model_auto_compact_token_limit = 350000\n");
  applyCompaction(["codex"], p);
  assert.equal(fs.readFileSync(p.codexConfig, "utf8"), "model_auto_compact_token_limit = 200000\n");
  undoCompaction(p);
  assert.equal(fs.readFileSync(p.codexConfig, "utf8"), "model_auto_compact_token_limit = 350000\n");
});

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const skip = fs.existsSync(CLI) ? false : "dist/cli.js is not built";

test("optimaizr apply and undo context-compaction", { skip }, async () => {
  const home = tmp("compact-cli");
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
    NO_COLOR: "1",
  };
  const run = (...argv) => execFileAsync(process.execPath, [CLI, ...argv], { env, cwd: home });

  const applied = await run("apply", "context-compaction", "--agent", "codex");
  assert.match(applied.stdout, /Applied .*model_auto_compact_token_limit unset -> 200000/);
  assert.match(applied.stdout, /optimaizr undo context-compaction/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /= 200000/);

  const listed = await run("undo");
  assert.match(listed.stdout, /Codex is set to compact at 200K/);

  const undone = await run("undo", "context-compaction");
  assert.match(undone.stdout, /Reverted .*setting removed/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), /200000/);
});

test("a later point with --at, still undone to the original", () => {
  const p = files();
  fs.mkdirSync(path.dirname(p.codexConfig), { recursive: true });
  fs.writeFileSync(p.codexConfig, "model_auto_compact_token_limit = 900000\n");
  applyCompaction(["codex"], p);
  const [r] = applyCompaction(["codex"], { ...p, tokens: 400_000 });
  assert.match(r.detail, /200000 -> 400000\. Codex compacts at 400K/);
  undoCompaction(p);
  assert.equal(fs.readFileSync(p.codexConfig, "utf8"), "model_auto_compact_token_limit = 900000\n");
});

test("optimaizr apply context-compaction --at", { skip }, async () => {
  const home = tmp("compact-at");
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
    NO_COLOR: "1",
  };
  const run = (...argv) => execFileAsync(process.execPath, [CLI, ...argv], { env, cwd: home });

  const applied = await run("apply", "context-compaction", "--agent", "claude", "--at", "400K");
  assert.match(applied.stdout, /CLAUDE_CODE_AUTO_COMPACT_WINDOW unset -> 400000/);
  assert.match(applied.stdout, /Claude Code compacts a little before 400K/);
  assert.match((await run("undo")).stdout, /Claude Code is set to compact at 400K/);

  const dryClaude = await run("apply", "context-compaction", "--agent", "claude", "--dry-run");
  assert.match(dryClaude.stdout, /compacts a little before that point/);

  const dry = await run(
    "apply",
    "context-compaction",
    "--agent",
    "codex",
    "--at=0.6M",
    "--dry-run",
  );
  assert.match(dry.stdout, /would set codex to compact at 600000\.\s*$/m);

  for (const bad of ["50K", "2M", "lots"]) {
    await assert.rejects(
      run("apply", "context-compaction", "--agent", "codex", "--at", bad),
      (err) => /--at takes a size from 100K to 1M/.test(err.stdout),
    );
  }
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
});

test("a point at or past the model's window is not written", { skip }, async () => {
  const home = tmp("compact-window");
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
    NO_COLOR: "1",
  };
  const run = async (...argv) =>
    strip((await execFileAsync(process.execPath, [CLI, ...argv], { env, cwd: home })).stdout)
      .replace(/\s+/g, " ")
      .trim();
  const projects = path.join(home, ".claude", "projects", "-w");
  fs.mkdirSync(projects, { recursive: true });
  const save = (name, model) => {
    const recs = transcript(name, [{ prompt: "fix it" }, { model, ctx: 90_000 }]);
    fs.writeFileSync(
      path.join(projects, `${name}.jsonl`),
      recs.map((r) => JSON.stringify(r)).join("\n"),
    );
  };
  const settings = path.join(home, ".claude", "settings.json");

  // Haiku 4.5 compacts near its 200K window already, so the default would be a no-op.
  save("s1", "claude-haiku-4-5");
  const haiku = await run("apply", "context-compaction");
  assert.match(haiku, /Haiku 4\.5 compacts as its 200K window fills either way/);
  assert.match(haiku, /Claude Code was left as it is/);
  assert.match(haiku, /optimaizr apply context-compaction --at 150K/);
  assert.match(haiku, /check \/context first/);
  assert.equal(fs.existsSync(settings), false);

  // Below the window it is a real change.
  const lower = await run("apply", "context-compaction", "--at", "150K", "--dry-run");
  assert.match(lower, /would set claude-code to compact at 150000/);
  assert.doesNotMatch(lower, /either way/);

  // With a 1M model in use as well, it is set, and says which model it moves.
  save("s2", "claude-opus-5-5");
  const both = await run("apply", "context-compaction");
  assert.match(both, /Applied .*CLAUDE_CODE_AUTO_COMPACT_WINDOW unset -> 200000/);
  assert.match(
    both,
    /Haiku 4\.5 compacts as its 200K window fills either way, so this changes Opus 5\.5 only/,
  );
});

/* ------------------------------------------------------------------ *
 * Context watch
 * ------------------------------------------------------------------ */

const call = (o = {}) => ({
  id: `e${Math.random()}`,
  source: "claude-code",
  provider: "anthropic",
  ts: "2026-10-06T10:00:00.000Z",
  model: "claude-opus-5-5",
  sessionId: "s1",
  project: "/w",
  inputTokens: 10,
  outputTokens: 100,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  tools: [],
  cost: { total: 0.05, cacheRead: 0.04 },
  ...o,
});

test("a jump and the 200K line are each said once per conversation", () => {
  const w = createContextWatch();
  assert.deepEqual(w.push(call({ cacheReadTokens: 100_000 })), []);
  const jump = w.push(call({ cacheReadTokens: 180_000 }));
  assert.equal(jump.length, 1);
  assert.equal(jump[0].kind, "jump");
  assert.equal(jump[0].added, 80_000);

  const long = w.push(call({ cacheReadTokens: 210_000 }));
  assert.deepEqual(
    long.map((n) => n.kind),
    ["long"],
  );
  assert.deepEqual(w.push(call({ cacheReadTokens: 220_000 })), [], "not twice");

  // A subagent starts empty, and a compaction starts a new conversation.
  assert.deepEqual(w.push(call({ isSubagent: true, cacheReadTokens: 300_000 })), []);
  assert.equal(w.push(call({ contextEpoch: 1, cacheReadTokens: 250_000 }))[0].kind, "long");
  // Codex counts too.
  assert.equal(
    w.push(call({ source: "codex", sessionId: "c1", cacheReadTokens: 260_000 }))[0].kind,
    "long",
  );
});

test("a long-conversation notice prices the re-read of one call", () => {
  const w = createContextWatch();
  const [n] = w.push(call({ cacheReadTokens: 230_000, cost: { total: 0.06, cacheRead: 0.046 } }));
  const text = strip(renderContextNotice(n));
  assert.match(text, /Long conversation now 230\.0K of context/);
  assert.match(text, /Every call re-reads all of it: \$0\.046 on this call alone/);
});

/* ------------------------------------------------------------------ *
 * Status line
 * ------------------------------------------------------------------ */

test("the status line says it is watching, then what it has seen", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const s = emptyStatus(now);
  assert.match(
    strip(renderStatus(s, now)),
    /optimAIzr live · watching for Claude Code, Codex, opencode and API calls ⣾$/,
  );
  // The square turns, a step every 300ms, so it reads as alive while nothing comes in.
  assert.match(strip(renderStatus(s, now + 300)), /API calls ⣽$/);
  assert.match(strip(renderStatus(s, now + 2_100)), /API calls ⣷$/);
  assert.match(strip(renderStatus(s, now + 2_400)), /API calls ⣾$/);
  // It names what this run reads, as the header does.
  const agents = emptyStatus(now);
  agents.watched = ["Claude Code", "Codex"];
  assert.match(strip(renderStatus(agents, now)), /watching for Claude Code and Codex ⣾$/);

  recordCall(s, call({ cacheReadTokens: 182_000, cost: { total: 0.04, cacheRead: 0.03 } }), now);
  let line = strip(renderStatus(s, now + 3_000, 200));
  assert.match(line, /\$0\.040 this run · 1 call/);
  assert.match(line, /nothing found yet · watching [⣾⣽⣻⢿⡿⣟⣯⣷]$/);
  // The rows above say what each conversation does, so the last call is not repeated.
  assert.doesNotMatch(line, /last Opus/);
  const api = emptyStatus(now);
  recordCall(api, call({ source: "sdk", cacheReadTokens: 182_000, cost: { total: 0.04 } }), now);
  assert.match(strip(renderStatus(api, now, 200)), /last Opus 5\.5 \$0\.040, 182\.0K context/);
  assert.deepEqual(renderNow(api, now), [], "API calls get no row");

  // Quiet over enough calls reads as no waste, and says where the reasons are.
  for (let i = 1; i < QUORUM; i++) recordCall(s, call({ id: `q${i}` }), now);
  s.keys = true;
  line = strip(renderStatus(s, now + 3_000, 200));
  assert.match(line, /no waste found \(\? why\)/);
  s.keys = false;

  // With two conversations it names the one that cost the most.
  recordCall(s, call({ sessionId: "s2", cost: { total: 9 } }), now);
  s.titleOf = (id) => (id === "s2" ? "Rewrite the importer" : undefined);
  assert.match(strip(renderStatus(s, now, 200)), /most: Rewrite the importer \$9\.00/);

  s.found.set("model-fit", 0.24);
  line = strip(renderStatus(s, now + 3_000, 200));
  assert.match(line, /1 found: \$0\.240 already paid/);
  assert.doesNotMatch(line, /still avoidable/);
  // What each call still pays shows once it is known, and n is the way in.
  s.perCall.set("model-fit", 0.04);
  s.keys = true;
  line = strip(renderStatus(s, now + 3_000, 300));
  assert.match(
    line,
    /1 found: \$0\.240 already paid, ~\$0\.040 a call still avoidable \(n next step\)/,
  );
  s.keys = false;
  s.perCall.clear();

  // On a narrow terminal the detail goes, the name and the verdict stay.
  const narrow = strip(renderStatus(s, now + 3_000, 60));
  assert.ok(narrow.length <= 60, narrow);
  assert.match(narrow, /optimAIzr live/);
  assert.match(narrow, /1 found/);
  // Past what can be dropped the line is cut, never wider than the terminal.
  for (const width of [40, 24, 12]) {
    const cut = renderStatus(s, now + 3_000, width);
    assert.ok(strip(cut).length <= width - 2, `${width}: ${strip(cut)}`);
    assert.ok(cut.endsWith(`${String.fromCharCode(27)}[0m`), "colour reset after the cut");
  }
});

test("the rows at the bottom: a spinner while Claude works, idle time once it waits", () => {
  const t0 = Date.parse("2026-10-06T10:00:00Z");
  const at = (ms) => new Date(t0 + ms).toISOString();
  const s = emptyStatus(t0);
  s.titleOf = (id) => (id === "s1" ? "Fix the login bug" : undefined);
  const step = (ms, o = {}) =>
    recordCall(
      s,
      call({
        ts: at(ms),
        turnId: "p1",
        turnStartedAt: at(0),
        stopReason: "tool_use",
        cacheReadTokens: 161_000,
        cost: { total: 0.1 },
        ...o,
      }),
      t0 + ms,
    );
  step(40_000);
  step(72_000);
  let rows = renderNow(s, t0 + 75_000).map(strip);
  assert.match(rows[0], /── now/);
  assert.match(
    rows[1],
    /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Fix the login bug\s+Claude working · 1m 15s · \$0\.200 so far · 161\.0K$/,
  );
  // The spinner turns between redraws.
  assert.notEqual(strip(renderNow(s, t0 + 75_500)[1])[2], rows[1][2]);
  // A subagent's call keeps the turn going.
  step(80_000, { isSubagent: true, stopReason: "end_turn" });
  assert.match(strip(renderNow(s, t0 + 81_000)[1]), /Claude working · 1m 21s · \$0\.300 so far/);

  step(90_000, { stopReason: "end_turn" });
  rows = renderNow(s, t0 + 102_000).map(strip);
  assert.match(rows[1], /^ {2}○ Fix the login bug\s+idle 12s · 161\.0K$/);
  // The next prompt starts a new turn, from its own start.
  step(200_000, { turnId: "p2", turnStartedAt: at(190_000) });
  assert.match(strip(renderNow(s, t0 + 205_000)[1]), /working · 15s · \$0\.100 so far/);
  // A turn with no call for ten minutes was most likely stopped.
  assert.match(strip(renderNow(s, t0 + 200_000 + 11 * 60_000)[1]), /○ .+idle 11m/);

  // Codex says nothing about how a turn ends, so a recent call counts as working.
  const c = emptyStatus(t0);
  recordCall(c, call({ source: "codex", sessionId: "x", project: "/w/api", ts: at(0) }), t0);
  assert.match(strip(renderNow(c, t0 + 10_000)[1]), /x api\s+Codex working/);
  assert.match(strip(renderNow(c, t0 + 40_000)[1]), /○ x api\s+idle 40s/);

  // Working first, then the latest; past four the rest are counted.
  for (const id of ["a", "b", "c", "d", "e"]) {
    recordCall(c, call({ source: "codex", sessionId: id, ts: at(-60_000) }), t0);
  }
  rows = renderNow(c, t0 + 10_000).map(strip);
  assert.match(rows[1], /Codex working/);
  assert.equal(rows.length, 6);
  assert.match(rows[5], /and 2 more open/);
  for (const r of renderNow(c, t0 + 10_000, 40)) assert.ok(strip(r).length <= 38, strip(r));
});

test("stopping prints what the run saw and found", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");
  const s = emptyStatus(now);
  assert.match(strip(renderRunSummary(s, now)), /0 calls · \$0\.00 spent · nothing worth changing/);
  recordCall(s, call(), now);
  // With calls seen, the checks follow the line and say what was fine.
  const quiet = strip(renderRunSummary(s, now + 10 * 60_000));
  assert.match(quiet, /10 min · 1 call · \$0\.050 spent$/);
  s.found.set("model-fit", 0.3);
  assert.match(
    strip(renderRunSummary(s, now + 10 * 60_000)),
    /1 opportunity: \$0\.300 already paid$/,
  );
});

/* ------------------------------------------------------------------ *
 * Yes/no questions
 * ------------------------------------------------------------------ */

function harness(keys, interactive = true) {
  const written = [];
  let asks = 0;
  let answers = 0;
  const prompt = createLivePrompt({
    interactive,
    jevEnabled: false,
    dryRun: false,
    render: () => "",
    onExit: () => {},
    onAsk: () => asks++,
    onAnswered: () => answers++,
    io: { read: async () => keys.shift() ?? "n", write: (l) => written.push(l) },
  });
  return { prompt, written, counts: () => [asks, answers] };
}

test("Y runs the action and prints its result; the status line steps aside meanwhile", async () => {
  const h = harness(["y"]);
  let ran = 0;
  h.prompt.confirm("Compact at 200K?", () => {
    ran++;
    return "Applied";
  });
  await h.prompt.drain();
  assert.equal(ran, 1);
  assert.ok(h.written.includes("Applied"));
  assert.deepEqual(h.counts(), [1, 1]);
});

test("N leaves everything alone; not interactive means printed, not asked", async () => {
  const no = harness(["n"]);
  let ran = 0;
  no.prompt.confirm("Compact at 200K?", () => String(++ran));
  await no.prompt.drain();
  assert.equal(ran, 0);
  assert.match(no.written.join("\n"), /won't be asked again/);

  const quiet = harness([], false);
  quiet.prompt.confirm("Compact at 200K?", () => String(++ran));
  await quiet.prompt.drain();
  assert.equal(ran, 0);
  assert.deepEqual(quiet.written, ["Compact at 200K?"]);
  assert.deepEqual(quiet.counts(), [0, 0]);
});
