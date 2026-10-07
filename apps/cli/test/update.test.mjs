import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { changelogSections, newer, updateLines, updatesEnabled } from "optimaizr";

const execFileAsync = promisify(execFile);
const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

/**
 * Update awareness must never slow a command or say anything about the user:
 * these tests never touch the network, only the decisions around it.
 */

test("versions compare as releases", () => {
  assert.equal(newer("0.9.0", "0.8.1"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("0.9.0", "0.9.0"), false);
  assert.equal(newer("0.8.1", "0.9.0"), false);
  assert.equal(newer("1.0.0-beta", "0.9.0"), true);
});

test("the check is off in CI, for --json, when piped, and when switched off", () => {
  const on = { env: {}, isTTY: true, json: false };
  assert.equal(updatesEnabled(on), true);
  assert.equal(updatesEnabled({ ...on, env: { CI: "true" } }), false);
  assert.equal(updatesEnabled({ ...on, env: { OPTIMAIZR_NO_UPDATE_CHECK: "1" } }), false);
  assert.equal(updatesEnabled({ ...on, env: { OPTIMAIZR_NO_UPDATE_CHECK: "0" } }), true);
  assert.equal(updatesEnabled({ ...on, json: true }), false);
  assert.equal(updatesEnabled({ ...on, isTTY: false }), false);
  assert.equal(updatesEnabled({ ...on, configured: false }), false);
});

const NOW = Date.parse("2026-10-06T12:00:00Z");

test("after an upgrade, what's new is said once", () => {
  const lines = strip(updateLines({ seenVersion: "0.8.1" }, NOW, { version: "0.9.0" }).join("\n"));
  assert.match(lines, /optimAIzr 0\.9\.0 · what's new/);
  assert.match(lines, /Your Claude plan is detected/);
  assert.match(lines, /optimaizr changelog/);
  assert.deepEqual(updateLines({ seenVersion: "0.9.0" }, NOW, { version: "0.9.0" }), []);
  // A fresh install has nothing to compare with; someone who used 0.8 does.
  assert.deepEqual(updateLines({}, NOW, { version: "0.9.0" }), []);
  assert.match(
    strip(updateLines({}, NOW, { version: "0.9.0", usedBefore: true }).join("\n")),
    /what's new/,
  );
});

test("a newer release is announced at most once a day", () => {
  const state = { seenVersion: "0.9.0", latest: "0.9.1" };
  const lines = strip(updateLines(state, NOW, { version: "0.9.0" }).join("\n"));
  assert.match(lines, /optimAIzr 0\.9\.1 is available · you have 0\.9\.0/);
  assert.match(lines, /npm i -g optimaizr@latest/);
  const told = { ...state, noticedAt: new Date(NOW - 3_600_000).toISOString() };
  assert.deepEqual(updateLines(told, NOW, { version: "0.9.0" }), []);
  const yesterday = { ...state, noticedAt: new Date(NOW - 25 * 3_600_000).toISOString() };
  assert.equal(updateLines(yesterday, NOW, { version: "0.9.0" }).length > 0, true);
  assert.deepEqual(
    updateLines({ seenVersion: "0.9.0", latest: "0.8.1" }, NOW, { version: "0.9.0" }),
    [],
  );
});

test("the changelog splits into versions", () => {
  const sections = changelogSections("# Changelog\n\n## 0.9.0\n\n- new\n\n## 0.8.1\n\n- old\n");
  assert.deepEqual(
    sections.map((s) => s.version),
    ["0.9.0", "0.8.1"],
  );
  assert.equal(sections[0].body, "- new");
});

const CLI = path.join(new URL("..", import.meta.url).pathname, "dist/cli.js");
const skip = fs.existsSync(CLI) ? false : "dist/cli.js is not built";

test("optimaizr changelog prints this version's notes, offline", { skip }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-changelog-"));
  const { stdout } = await execFileAsync(process.execPath, [CLI, "changelog"], {
    env: {
      ...process.env,
      HOME: home,
      OPTIMAIZR_DIR: path.join(home, ".optimaizr"),
      NO_COLOR: "1",
    },
  });
  const version = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  assert.match(stdout, new RegExp(`optimAIzr ${version.replace(/\./g, "\\.")}`));
  assert.match(stdout, /optimaizr statusline on/);
  assert.match(stdout, /optimaizr changelog --all/);
  // Piped output: no update notice and nothing written.
  assert.equal(fs.existsSync(path.join(home, ".optimaizr")), false);
});
