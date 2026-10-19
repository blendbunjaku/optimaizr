import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSqlite, mapOpencodeRows, readOpencodeRows } from "@optimaizr/core";
import { tailOpencode } from "@optimaizr/local";

const sqlite = await loadSqlite();
const noSqlite = sqlite ? false : "node:sqlite needs Node 22.13+";
const TOKENS = { input: 1000, output: 200, reasoning: 0, cache: { read: 40_000, write: 0 } };
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cleanups = new WeakMap();

function cleanup(t, fn) {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(() => {
      for (const close of cleanups.get(t).reverse()) close();
    });
  }
  cleanups.get(t).push(fn);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-live-"));
  cleanup(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function database(t, file = path.join(tempDir(t), "opencode.db")) {
  const db = new sqlite.DatabaseSync(file);
  cleanup(t, () => db.close());
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL,
      title text NOT NULL, model text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE INDEX part_session_idx ON part (session_id);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    INSERT INTO session VALUES ('ses_a', NULL, '/p', 'Live one', NULL, 0, 0);
    INSERT INTO session VALUES ('ses_b', NULL, '/other', 'Other one', NULL, 0, 0);
  `);
  return { file, db };
}

function call(db, n, at, { sessionId = "ses_a", summary = false, tokens = TOKENS } = {}) {
  const mid = `msg_${n}`;
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    mid,
    sessionId,
    at,
    at,
    JSON.stringify({ role: "assistant", modelID: "claude-sonnet-5", parentID: "u", summary }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
    `prt_${String(n).padStart(4, "0")}`,
    mid,
    sessionId,
    at,
    at,
    JSON.stringify({ type: "step-finish", reason: "stop", tokens }),
  );
  // Intentionally leave session.time_updated unchanged: parts drive live.
}

async function follow(t, file, opts = {}, onEvent) {
  const seen = [];
  const tail = tailOpencode(onEvent ?? ((e) => seen.push(e)), {
    db: file,
    intervalMs: 60_000,
    keepAlive: true,
    ...opts,
  });
  cleanup(t, () => {
    tail.stop();
    tail.flush();
  });
  assert.ok(tail.ready instanceof Promise);
  await tail.ready;
  return { tail, seen };
}

test(
  "live reports only new calls, once each, and forwards titles",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    call(db, 1, Date.now() - 60_000);
    const titles = [];
    const { tail, seen } = await follow(t, file, {
      onTitle: (id, title) => titles.push([id, title]),
    });
    assert.deepEqual(seen, []);
    call(db, 2, Date.now());
    tail.flush();
    tail.flush();
    assert.deepEqual(
      seen.map((e) => e.id),
      ["ses_a#prt_0002"],
    );
    assert.equal(seen[0].source, "opencode");
    assert.ok(titles.some(([id, title]) => id === "ses_a" && title === "Live one"));
  },
);

test(
  "numeric backfill includes history and agrees with batch mapping",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    const at = Date.now() - 120_000;
    call(db, 1, at);
    call(db, 2, at + 10_000, { summary: true });
    call(db, 3, at + 20_000);
    const { tail, seen } = await follow(t, file, { backfill: 50 });
    tail.flush();
    assert.deepEqual(seen, mapOpencodeRows(readOpencodeRows(db, { sessionIds: ["ses_a"] })).events);
    assert.equal(seen[2].contextEpoch, 1);
  },
);

test(
  "a delayed commit inside the overlap window is emitted exactly once",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    const { tail, seen } = await follow(t, file);
    const at = Date.now();
    call(db, 1, at);
    call(db, 3, at + 40_000);
    tail.flush();
    call(db, 2, at + 20_000, { sessionId: "ses_b" });
    tail.flush();
    tail.flush();
    assert.deepEqual(
      seen.map((e) => e.id),
      ["ses_a#prt_0001", "ses_a#prt_0003", "ses_b#prt_0002"],
    );
  },
);

test(
  "advancing the cursor never replays pruned calls from whole-session reads",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    const { tail, seen } = await follow(t, file);
    const at = Date.now();
    for (let n = 1; n <= 8; n++) {
      call(db, n, at + n * 40_000);
      tail.flush();
      tail.flush();
    }
    assert.deepEqual(
      seen.map((e) => e.id),
      Array.from({ length: 8 }, (_, i) => `ses_a#prt_${String(i + 1).padStart(4, "0")}`),
    );
  },
);

test(
  "startup excludes old calls even when their session gains a new call",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    call(db, 1, Date.now() - 120_000);
    call(db, 2, Date.now() - 5000);
    const { tail, seen } = await follow(t, file);
    call(db, 3, Date.now());
    tail.flush();
    assert.deepEqual(
      seen.map((e) => e.id),
      ["ses_a#prt_0003"],
    );
  },
);

test(
  "stop then flush emits the last call and closes the read handle",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    const { tail, seen } = await follow(t, file);
    call(db, 1, Date.now());
    tail.stop();
    tail.flush();
    call(db, 2, Date.now() + 1);
    tail.flush();
    assert.deepEqual(
      seen.map((e) => e.id),
      ["ses_a#prt_0001"],
    );
  },
);

test("a database that appears after startup is picked up", { skip: noSqlite }, async (t) => {
  const file = path.join(tempDir(t), "opencode.db");
  const { tail, seen } = await follow(t, file);
  const { db } = database(t, file);
  call(db, 1, Date.now());
  tail.flush();
  assert.deepEqual(
    seen.map((e) => e.id),
    ["ses_a#prt_0001"],
  );
});

test("a non-database file replaced by a valid database recovers", { skip: noSqlite }, async (t) => {
  const file = path.join(tempDir(t), "opencode.db");
  fs.writeFileSync(file, "not sqlite");
  const { tail, seen } = await follow(t, file);
  tail.flush();
  fs.rmSync(file);
  const { db } = database(t, file);
  call(db, 1, Date.now());
  tail.flush();
  assert.deepEqual(
    seen.map((e) => e.id),
    ["ses_a#prt_0001"],
  );
});

test("a query error is retried without losing the pending call", { skip: noSqlite }, async (t) => {
  const { file, db } = database(t);
  const { tail, seen } = await follow(t, file);
  db.exec("ALTER TABLE message RENAME TO held_message");
  db.prepare("INSERT INTO part VALUES ('prt_0001', 'msg_1', 'ses_a', ?, ?, ?)").run(
    Date.now(),
    Date.now(),
    JSON.stringify({ type: "step-finish", tokens: TOKENS }),
  );
  tail.flush();
  assert.deepEqual(seen, []);
  db.exec("ALTER TABLE held_message RENAME TO message");
  db.prepare("INSERT INTO message VALUES ('msg_1', 'ses_a', ?, ?, ?)").run(
    Date.now(),
    Date.now(),
    JSON.stringify({ role: "assistant", modelID: "claude-sonnet-5" }),
  );
  tail.flush();
  assert.deepEqual(
    seen.map((e) => e.id),
    ["ses_a#prt_0001"],
  );
});

test(
  "malformed parts and broken consumers do not interrupt other calls",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    const seen = [];
    const { tail } = await follow(
      t,
      file,
      {
        onTitle: () => {
          throw new Error("renderer");
        },
      },
      (e) => {
        seen.push(e.id);
        throw new Error("consumer");
      },
    );
    db.exec("INSERT INTO part VALUES ('prt_0000', 'bad', 'ses_a', 0, 0, '{oops')");
    call(db, 1, Date.now());
    call(db, 2, Date.now() + 1);
    tail.flush();
    tail.flush();
    assert.deepEqual(seen, ["ses_a#prt_0001", "ses_a#prt_0002"]);
  },
);

test(
  "the cursor query uses the part primary-key index and rereads only billed sessions",
  { skip: noSqlite },
  async (t) => {
    const { file, db } = database(t);
    const prepare = sqlite.DatabaseSync.prototype.prepare;
    const queries = [];
    sqlite.DatabaseSync.prototype.prepare = function (sql) {
      queries.push(sql);
      return prepare.call(this, sql);
    };
    cleanup(t, () => {
      sqlite.DatabaseSync.prototype.prepare = prepare;
    });
    const { tail, seen } = await follow(t, file);
    // A tool-only session must not cause its historical billed calls to be mapped.
    call(db, 1, Date.now(), { sessionId: "ses_b" });
    tail.flush();
    queries.length = 0;
    db.exec("INSERT INTO part VALUES ('prt_0002', 'tool', 'ses_a', 0, 0, '{\"type\":\"tool\"}')");
    tail.flush();
    assert.equal(seen.length, 1);
    const cursorQuery = queries.find((sql) => /FROM part\s+WHERE id > \?/i.test(sql));
    assert.ok(cursorQuery, "change detection must use a primary-key range");
    const plans = prepare.call(db, `EXPLAIN QUERY PLAN ${cursorQuery}`).all("");
    assert.ok(plans.some((p) => /SEARCH part USING INDEX .*\(id>\?\)/.test(p.detail)));
    assert.ok(plans.every((p) => !/SCAN part/.test(p.detail)));
    assert.ok(
      queries.every((sql) => !/FROM message/.test(sql)),
      "no new billed sessions to reread",
    );
  },
);

test("a missing database is a quiet no-op", async (t) => {
  const file = path.join(tempDir(t), "opencode.db");
  const { tail, seen } = await follow(t, file);
  tail.stop();
  tail.flush();
  assert.deepEqual(seen, []);
  assert.equal(fs.existsSync(file), false);
});

test("stopping before the loader is ready is safe", async (t) => {
  const tail = tailOpencode(() => assert.fail("no events expected"), {
    db: path.join(tempDir(t), "opencode.db"),
    intervalMs: 60_000,
    keepAlive: true,
  });
  tail.stop();
  tail.flush();
  await tail.ready;
  tail.flush();
});

// Windows has no SIGINT to send: kill() ends the child abruptly, without its shutdown.
const noCtrlC = process.platform === "win32" ? "no SIGINT to deliver on Windows" : false;

async function liveCli(t, home, args, check) {
  // Signal only after the CLI installs its handlers, without a timing delay.
  const preload = `
    const on = process.on;
    process.on = function (name, ...args) {
      const result = on.call(this, name, ...args);
      if (name === 'SIGTERM') { process.on = on; process.send('ready'); }
      return result;
    };
  `;
  const child = spawn(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      cli,
      "live",
      "--no-prompt",
      ...args,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
        CODEX_HOME: path.join(home, ".codex"),
        OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  cleanup(t, () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  let signalled = false;
  let ready = false;
  const stop = () => {
    if (ready && !signalled && check(stdout)) {
      signalled = true;
      child.kill("SIGINT");
      child.disconnect();
    }
  };
  child.on("message", () => {
    ready = true;
    stop();
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    stop();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.equal(signalled, true, stdout);
  assert.doesNotMatch(stderr, /ExperimentalWarning/);
  return stdout;
}

test(
  "CLI watches opencode only for agent sources and notes unavailable SQLite once",
  { skip: noCtrlC, timeout: 15_000 },
  async (t) => {
    const home = tempDir(t);
    const dir = path.join(home, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.db");
    fs.writeFileSync(file, "not sqlite");
    const stdout = await liveCli(t, home, ["--source", "agents"], (out) =>
      out.includes("Ctrl-C to stop"),
    );
    assert.ok(
      stdout.includes(
        sqlite
          ? "Watching Claude Code, Codex and opencode on this machine"
          : "Watching Claude Code and Codex on this machine",
      ),
    );
    assert.equal(
      stdout.split("opencode history skipped: it needs Node 22.13 or later").length - 1,
      sqlite ? 0 : 1,
    );
    const sdk = await liveCli(t, home, ["--source", "sdk"], (out) =>
      out.includes("Ctrl-C to stop"),
    );
    assert.ok(sdk.includes("Watching API calls made through optimAIzr on this machine"));
    fs.rmSync(file);
    const missing = await liveCli(t, home, ["--source", "agents"], (out) =>
      out.includes("Ctrl-C to stop"),
    );
    // No history yet is still watched: the tail opens the database once it appears.
    assert.ok(
      missing.includes(
        sqlite
          ? "Watching Claude Code, Codex and opencode on this machine"
          : "Watching Claude Code and Codex on this machine",
      ),
    );
    assert.ok(!missing.includes("opencode history skipped"));
  },
);

test(
  "CLI numeric backfill feeds opencode calls into live analysis",
  { skip: noSqlite || noCtrlC, timeout: 15_000 },
  async (t) => {
    const home = tempDir(t);
    const dir = path.join(home, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const { db } = database(t, path.join(dir, "opencode.db"));
    call(db, 1, Date.now() - 1000, { tokens: { ...TOKENS, input: 200_000 } });
    const stdout = await liveCli(
      t,
      home,
      ["--source", "agents", "--backfill", "50", "--json"],
      (out) => out.includes('"context":'),
    );
    const notices = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.context);
    assert.equal(notices[0].context.sessionId, "ses_a");
    assert.equal(notices[0].context.kind, "long");
  },
);
