import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { lib, sandbox, snapshot } from "./helpers.mjs";

const home = sandbox("actions");
const { compactOn, compactOff, markDone, undoDone, findCli, guardOff, guardNow, withLocalState } =
  lib;
const settings = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  } catch {
    return {};
  }
};

test("compaction is one setting in Claude Code's settings, undone the same way", () => {
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const on = compactOn();
  assert.equal(on.ok, true);
  assert.match(on.message, /compacts a little before 200K/);
  assert.equal(settings().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(settings().theme, "dark");

  const s = withLocalState(snapshot());
  assert.equal(s.compaction.at, 200_000);
  assert.equal(s.compaction.ours, true);

  const off = compactOff();
  assert.equal(off.ok, true);
  assert.equal(off.message, "Claude Code compacts where it did before.");
  assert.deepEqual(settings(), { theme: "dark" });
  assert.equal(withLocalState(snapshot()).compaction.at, null);
  assert.match(compactOff().message, /had not changed/);
});

test("a habit is recorded once, shows as done, and undoes", () => {
  const fix = { rule: "dup-read", scope: { source: "claude-code" } };
  assert.match(markDone(fix).message, /^Recorded as done today/);
  assert.match(markDone(fix).message, /^Already recorded/);
  const s = withLocalState(snapshot());
  assert.ok(s.fixes.find((f) => f.rule === "dup-read").doneAt);
  assert.equal(s.fixes.find((f) => f.rule === "model-choice").doneAt, null);

  assert.match(undoDone("dup-read").message, /^Undone/);
  assert.match(undoDone("dup-read").message, /nothing recorded/);
  assert.equal(withLocalState(snapshot()).fixes.find((f) => f.rule === "dup-read").doneAt, null);
});

test("guard off needs no CLI, and says so when it was never on", () => {
  assert.deepEqual(guardOff(), { ok: true, message: "Guard was already off." });
  assert.deepEqual(guardNow(), { on: false, catches: 0, savedUsd: 0, recent: [] });
});

test("guard's week reads its own log, newest first", () => {
  const dir = path.join(home, ".optimaizr", "guard");
  fs.mkdirSync(dir, { recursive: true });
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const lines = [
    { at: at(90), session: "s1", kind: "big-read", tokens: 120_000, detail: "/work/app/big.log" },
    { at: at(30), session: "s1", kind: "cold-hold", usd: 1.4, tokens: 140_000 },
    { at: at(20), session: "s1", kind: "session-start" },
  ];
  fs.writeFileSync(
    path.join(dir, "receipts.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const g = guardNow();
  assert.deepEqual(
    g.recent.map((r) => r.title),
    ["Held a message", "Held a big read"],
  );
  assert.match(g.recent[1].text, /^big\.log is about 120K tokens whole/);
});

test("the CLI is found on PATH, or where the setting points", () => {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const name = process.platform === "win32" ? "optimaizr.cmd" : "optimaizr";
  const file = path.join(bin, name);
  fs.writeFileSync(file, "");
  assert.equal(findCli("", { PATH: bin }), file);
  assert.equal(findCli(file, {}), file);
  assert.equal(findCli(path.join(home, "missing"), { PATH: bin }), null);
});
