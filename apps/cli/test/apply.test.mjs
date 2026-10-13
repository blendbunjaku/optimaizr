import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `apply` lists what it can change, gives the steps for a change only you can
 * make, and `--done` writes that change to the journal `results` reads.
 */

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const skip = fs.existsSync(CLI) ? false : "dist/cli.js is not built";

const day = (i) => `2026-09-${String((i % 28) + 1).padStart(2, "0")}`;

/** Small calls, plus a few that start with a whole session's context: an oversized-input finding. */
function records() {
  const call = (id, ts, session, read) => ({
    type: "assistant",
    timestamp: ts,
    sessionId: session,
    cwd: "/Users/someone/project",
    message: {
      id,
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: 500,
      },
      content: [{ type: "tool_use", id: `t${id}`, name: "Bash", input: { command: "ls" } }],
    },
  });
  const out = [];
  for (let i = 0; i < 40; i++) out.push(call(`s${i}`, `${day(i)}T10:00:00.000Z`, "small", 5_000));
  for (let i = 0; i < 10; i++) out.push(call(`b${i}`, `${day(i)}T11:00:00.000Z`, "big", 400_000));
  return out;
}

function home(withUsage = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-apply-"));
  if (withUsage) {
    const projects = path.join(dir, ".claude", "projects", "-Users-someone-project");
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, "session.jsonl"),
      records()
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
  }
  return {
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
    CODEX_HOME: path.join(dir, ".codex"),
    OPTIMAIZR_DIR: path.join(dir, ".optimaizr"),
  };
}

async function run(argv, env) {
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

const journal = (env) => {
  const file = path.join(env.OPTIMAIZR_DIR, "changes.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

test("bare apply lists the levers, off by default, and the findings", { skip }, async () => {
  const env = home();
  const { code, stdout } = await run(["apply"], env);
  assert.equal(code, 0);
  assert.match(stdout, /Changes optimAIzr makes for you/);
  assert.match(stdout, /context-compaction\s+off\s+optimaizr apply context-compaction/);
  assert.match(stdout, /statusline\s+off/);
  assert.match(stdout, /Changes you make yourself/);
  assert.match(stdout, /oversized-input\s+Oversized context/);
  assert.match(stdout, /optimaizr apply <rule> --done/);
});

test("an agent finding gives the steps, no gate, and writes no file", { skip }, async () => {
  const env = home();
  const { code, stdout } = await run(["apply", "oversized-input"], env);
  assert.equal(code, 0);
  assert.match(stdout, /What to do/);
  assert.match(stdout, /optimaizr apply oversized-input --done/);
  assert.doesNotMatch(stdout, /unverified/);
  assert.equal(fs.existsSync(path.join(env.HOME, "optimaizr-change.md")), false);
});

test("--done records the change with who it covers, once", { skip }, async () => {
  const env = home();
  const first = await run(["apply", "oversized-input", "--done"], env);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /Recorded Oversized context in project/);
  assert.match(first.stdout, /optimaizr results/);

  const again = await run(["apply", "--done", "oversized-input"], env);
  assert.match(again.stdout, /Already recorded/);

  const entries = journal(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "record");
  assert.equal(entries[0].source, "claude-code");
  assert.equal(entries[0].project, "/Users/someone/project");

  const list = await run(["apply"], env);
  assert.match(list.stdout, /oversized-input\s+done since/);
  const steps = await run(["apply", "oversized-input"], env);
  assert.match(steps.stdout, /You recorded this as done on/);
});

test(
  "--done takes any known rule, even with nothing found, and refuses an unknown one",
  { skip },
  async () => {
    const env = home(false);
    const known = await run(["apply", "heavy-start", "--done"], env);
    assert.equal(known.code, 0);
    assert.deepEqual(
      journal(env).map((e) => [e.kind, e.rule, e.source ?? null]),
      [["record", "heavy-start", null]],
    );

    const unknown = await run(["apply", "no-such-rule", "--done"], env);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stdout, /No such rule/);
    assert.equal(journal(env).length, 1);
  },
);

test("compaction set by hand is recorded at its point, for that agent", { skip }, async () => {
  const env = home(false);
  await run(["apply", "context-compaction", "--done", "--at", "300K", "--agent", "claude"], env);
  const [e] = journal(env);
  assert.equal(e.rule, "context-compaction");
  assert.equal(e.source, "claude-code");
  assert.equal(e.value, "300000");
});

test(
  "undo of a change made by hand notes when, and results stops counting it",
  { skip },
  async () => {
    const env = home();
    await run(["apply", "oversized-input", "--done"], env);
    const { stdout } = await run(["undo", "oversized-input"], env);
    assert.match(stdout, /Recorded oversized-input as undone today/);
    assert.deepEqual(
      journal(env).map((e) => e.kind),
      ["record", "undo"],
    );
    const list = await run(["apply"], env);
    assert.doesNotMatch(list.stdout, /done since/);
  },
);
