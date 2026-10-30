import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { lib, sandbox, snapshot } from "./helpers.mjs";

const home = sandbox("shared");
const { claim, pruneClaims, projectDirName, inFolders, newestTranscript } = lib;
const { readCachedSnapshot, writeCachedSnapshot, snapshotPath, extensionDir } = lib;

test("the shared folder sits in optimAIzr's own, wherever that is", () => {
  assert.equal(extensionDir(), path.join(home, ".optimaizr", "vscode"));
  assert.equal(snapshotPath(), path.join(home, ".optimaizr", "vscode", "snapshot.json"));
});

test("a claim goes to one window only", () => {
  const dir = path.join(home, "claims");
  assert.equal(claim("expiring|s1|123", dir), true);
  assert.equal(claim("expiring|s1|123", dir), false);
  assert.equal(claim("expiring|s1|456", dir), true);
  // A day later they are cleared, so the folder does not grow for ever.
  assert.equal(pruneClaims(dir, 86_400_000, Date.now() + 2 * 86_400_000), 2);
  assert.equal(claim("expiring|s1|123", dir), true);
  assert.equal(pruneClaims(path.join(home, "nowhere")), 0);
});

test("a cached snapshot is used while fresh and for the same days only", () => {
  const dir = path.join(home, "cache");
  const now = Date.now();
  const s = snapshot({}, now);
  const at = Date.parse(s.at);
  assert.equal(readCachedSnapshot(30, 60_000, { dir, now }), null);
  writeCachedSnapshot(s, dir);
  assert.deepEqual(readCachedSnapshot(30, 9 * 60_000, { dir, now: at + 1000 }), s);
  assert.equal(readCachedSnapshot(14, 9 * 60_000, { dir, now: at + 1000 }), null);
  assert.equal(readCachedSnapshot(30, 9 * 60_000, { dir, now: at + 10 * 60_000 }), null);
  // A clock that went backwards is not a fresh snapshot.
  assert.equal(readCachedSnapshot(30, 9 * 60_000, { dir, now: at - 1000 }), null);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
  );
  fs.writeFileSync(snapshotPath(dir), "{ half a file");
  assert.equal(readCachedSnapshot(30, 9 * 60_000, { dir, now: at + 1000 }), null);
});

test("Claude Code's folder name for a project", () => {
  assert.equal(projectDirName("/Users/me/my.app"), "-Users-me-my-app");
  assert.equal(projectDirName("C:\\Users\\me\\app"), "C--Users-me-app");
});

test("a call belongs to the open folder or one inside it", () => {
  const root = path.join(home, "work", "app");
  assert.equal(inFolders(root, [root]), true);
  assert.equal(inFolders(path.join(root, "packages", "web"), [root]), true);
  assert.equal(inFolders(`${root}-old`, [root]), false);
  assert.equal(inFolders(path.join(home, "work"), [root]), false);
  assert.equal(inFolders(root, []), false);
  assert.equal(inFolders(root, [`${root}${path.sep}`]), true);
});

test("the newest transcript for a folder", () => {
  const root = path.join(home, ".claude", "projects");
  const folder = path.join(home, "work", "app");
  assert.equal(newestTranscript(folder, root), null);
  const dir = path.join(root, projectDirName(folder));
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "old.jsonl");
  const fresh = path.join(dir, "fresh.jsonl");
  fs.writeFileSync(old, "{}\n");
  fs.writeFileSync(fresh, "{}\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a transcript");
  const t = Date.now() / 1000;
  fs.utimesSync(old, t - 600, t - 600);
  fs.utimesSync(fresh, t, t);
  assert.equal(newestTranscript(folder, root), fresh);
  // Without a root it looks where Claude Code keeps them.
  assert.equal(newestTranscript(folder), fresh);
});
