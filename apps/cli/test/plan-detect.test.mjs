import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { claudeConfigDir, codexHome, planFromAccount, planView, renderPlan } from "@optimaizr/core";
import {
  claudeGlobalConfigPath,
  claudeProjectsRoot,
  claudeSettingsPath,
  codexSessionsRoot,
  detectClaudePlan,
  latestClaudeWindows,
  readClaudeAccount,
} from "@optimaizr/local";

const execFileAsync = promisify(execFile);

/**
 * The plan is read from Claude Code's cached sign-in, never guessed: a family
 * without a tier is `partial`, anything unrecognised is `unknown`, and an
 * explicit `--plan` or config entry always wins over what was detected.
 */

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `optimaizr-${name}-`));

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Mapping account fields to a plan
 * ------------------------------------------------------------------ */

test("Pro is read from the organization type", () => {
  const d = planFromAccount({
    organizationType: "claude_pro",
    organizationRateLimitTier: "default_claude_ai",
  });
  assert.deepEqual(d, { kind: "plan", plan: "pro", label: "Claude Pro" });
});

test("Max needs its rate-limit tier to tell 5x from 20x", () => {
  const max = (tier) =>
    planFromAccount({ organizationType: "claude_max", organizationRateLimitTier: tier });
  assert.equal(max("default_claude_max_20x").plan, "max20");
  assert.equal(max("default_claude_max_5x").plan, "max5");
  // The user's own tier counts as well as the organization's.
  assert.equal(
    planFromAccount({ organizationType: "claude_max", userRateLimitTier: "default_claude_max_20x" })
      .plan,
    "max20",
  );
  assert.deepEqual(max(null), {
    kind: "partial",
    label: "Claude Max",
    choices: ["max5", "max20"],
  });
});

test("Team reads the seat; without one it is partial, never Max 5x", () => {
  const team = (seatTier) =>
    planFromAccount({
      organizationType: "claude_team",
      seatTier,
      userRateLimitTier: "default_claude_max_5x",
    });
  assert.equal(team("premium").plan, "team-premium");
  assert.equal(team("standard").plan, "team");
  assert.equal(team(null).kind, "partial");
});

test("Enterprise is per-token; nothing usable is unknown", () => {
  assert.equal(planFromAccount({ organizationType: "claude_enterprise" }).kind, "per-token");
  assert.equal(planFromAccount(null).kind, "unknown");
  assert.equal(planFromAccount({ organizationType: null }).kind, "unknown");
  assert.equal(planFromAccount({ organizationType: "something_new" }).kind, "unknown");
});

/* ------------------------------------------------------------------ *
 * Reading Claude Code's config
 * ------------------------------------------------------------------ */

test("only the plan fields are read from the account block", () => {
  const dir = tmp("acct");
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      numStartups: 3,
      oauthAccount: {
        emailAddress: "someone@example.com",
        displayName: "Someone",
        organizationUuid: "org-1",
        organizationType: "claude_pro",
        organizationRateLimitTier: "default_claude_ai",
        seatTier: null,
      },
    }),
  );
  const account = readClaudeAccount(file);
  assert.equal(account.organizationType, "claude_pro");
  assert.equal(JSON.stringify(account).includes("someone@example.com"), false);
  assert.equal(JSON.stringify(account).includes("org-1"), false);
  assert.equal(detectClaudePlan(file).plan, "pro");
});

test("a missing or broken config, or one without a sign-in, reads as unknown", () => {
  const dir = tmp("acct-bad");
  assert.equal(readClaudeAccount(path.join(dir, "missing.json")), null);
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
  assert.equal(readClaudeAccount(path.join(dir, "broken.json")), null);
  fs.writeFileSync(path.join(dir, "apikey.json"), JSON.stringify({ numStartups: 1 }));
  assert.equal(detectClaudePlan(path.join(dir, "apikey.json")).kind, "unknown");
});

test("CLAUDE_CONFIG_DIR moves the config, transcripts and settings together", () => {
  const dir = tmp("cfgdir");
  withEnv({ CLAUDE_CONFIG_DIR: dir }, () => {
    assert.equal(claudeConfigDir(), dir);
    assert.equal(claudeGlobalConfigPath(), path.join(dir, ".claude.json"));
    assert.equal(claudeProjectsRoot(), path.join(dir, "projects"));
    assert.equal(claudeSettingsPath(), path.join(dir, "settings.json"));
  });
  withEnv({ CLAUDE_CONFIG_DIR: undefined }, () => {
    assert.equal(claudeConfigDir(), path.join(os.homedir(), ".claude"));
    // Unless the legacy file exists, the default config sits beside ~/.claude.
    if (!fs.existsSync(path.join(os.homedir(), ".claude", ".config.json"))) {
      assert.equal(claudeGlobalConfigPath(), path.join(os.homedir(), ".claude.json"));
    }
  });
});

test("a quoted ~ in CLAUDE_CONFIG_DIR or CODEX_HOME is expanded", () => {
  withEnv({ CLAUDE_CONFIG_DIR: "~/.claude-personal", CODEX_HOME: "~/.codex-work" }, () => {
    assert.equal(claudeConfigDir(), path.join(os.homedir(), ".claude-personal"));
    assert.equal(claudeProjectsRoot(), path.join(os.homedir(), ".claude-personal", "projects"));
    assert.equal(
      claudeGlobalConfigPath(),
      path.join(os.homedir(), ".claude-personal", ".claude.json"),
    );
    assert.equal(codexHome(), path.join(os.homedir(), ".codex-work"));
  });
});

test("CODEX_HOME moves where Codex sessions are read from", () => {
  const dir = tmp("codexhome");
  withEnv({ CODEX_HOME: dir }, () => {
    assert.equal(codexHome(), dir);
    assert.equal(codexSessionsRoot(), path.join(dir, "sessions"));
  });
  withEnv({ CODEX_HOME: undefined }, () => {
    assert.equal(codexSessionsRoot(), path.join(os.homedir(), ".codex", "sessions"));
  });
});

/* ------------------------------------------------------------------ *
 * Claude Code's meters, from the mod's session files
 * ------------------------------------------------------------------ */

const NOW = new Date("2026-10-05T12:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const ahead = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();

function sessionsDir(...beats) {
  const dir = tmp("mod-sessions");
  beats.forEach((b, i) =>
    fs.writeFileSync(
      path.join(dir, `s${i}.json`),
      JSON.stringify({ id: `s${i}`, version: "0.9.0", cwd: "/w", startedAt: ago(60), ...b }),
    ),
  );
  return dir;
}

test("the newest fresh reading wins", () => {
  const dir = sessionsDir(
    { seenAt: ago(1), windows: { at: ago(1), fiveHour: { percentUsed: 61, resetsAt: ahead(90) } } },
    { seenAt: ago(5), windows: { at: ago(5), fiveHour: { percentUsed: 55, resetsAt: ahead(90) } } },
  );
  const w = latestClaudeWindows({ dir, now: NOW });
  assert.equal(w.fiveHour.percentUsed, 61);
});

test("stale readings and meters past their reset are dropped", () => {
  const stale = sessionsDir({
    seenAt: ago(30),
    windows: { at: ago(30), fiveHour: { percentUsed: 90, resetsAt: ahead(60) } },
  });
  assert.equal(latestClaudeWindows({ dir: stale, now: NOW }), null);

  const reset = sessionsDir({
    seenAt: ago(2),
    windows: {
      at: ago(2),
      fiveHour: { percentUsed: 90, resetsAt: ago(1) },
      sevenDay: { percentUsed: 40, resetsAt: ahead(3000) },
    },
  });
  const w = latestClaudeWindows({ dir: reset, now: NOW });
  assert.equal(w.fiveHour, undefined);
  assert.equal(w.sevenDay.percentUsed, 40);

  // A mod older than 0.9.0 writes no meters at all.
  assert.equal(latestClaudeWindows({ dir: sessionsDir({ seenAt: ago(1) }), now: NOW }), null);
});

/* ------------------------------------------------------------------ *
 * The plan block
 * ------------------------------------------------------------------ */

test("the plan block says where the plan came from and shows real meters", () => {
  const v = planView([], [], {
    plan: "pro",
    source: "detected",
    windows: {
      at: NOW.toISOString(),
      fiveHour: { percentUsed: 61, resetsAt: ahead(90) },
      sevenDay: { percentUsed: 30 },
    },
    now: NOW,
  });
  const text = renderPlan(v).join("\n");
  assert.match(text, /Plan · detected from your Claude Code sign-in/);
  assert.match(text, /5-hour window\s+61%/);
  assert.match(text, /Weekly window\s+30%/);
  // The meter makes "run optimaizr limit" pointless.
  assert.doesNotMatch(text, /Your session limit/);
});

test("without meters the block keeps the learned limit and points at the mod", () => {
  const text = renderPlan(planView([], [], { plan: "max5", source: "flag" })).join("\n");
  assert.match(text, /Plan · from --plan/);
  assert.match(text, /Your session limit\s+unknown/);
  assert.match(text, /optimaizr mod/);
});

/* ------------------------------------------------------------------ *
 * The built CLI
 * ------------------------------------------------------------------ */

const CLI = path.join(new URL("..", import.meta.url).pathname, "dist/cli.js");
const skip = fs.existsSync(CLI) ? false : "dist/cli.js is not built";

/** A home with one Claude Code call and, optionally, a signed-in account. */
function home({ account, config } = {}) {
  const dir = tmp("plan-cli");
  const projects = path.join(dir, "projects", "-Users-someone-project");
  fs.mkdirSync(projects, { recursive: true });
  const rec = {
    type: "assistant",
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    sessionId: "s1",
    cwd: "/Users/someone/project",
    message: {
      id: "m1",
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [],
    },
  };
  fs.writeFileSync(path.join(projects, "s1.jsonl"), JSON.stringify(rec) + "\n");
  if (account)
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: account }));
  const optimaizr = path.join(dir, ".optimaizr");
  if (config) {
    fs.mkdirSync(optimaizr, { recursive: true });
    fs.writeFileSync(path.join(optimaizr, "config.json"), JSON.stringify(config));
  }
  return { HOME: dir, CLAUDE_CONFIG_DIR: dir, OPTIMAIZR_DIR: optimaizr };
}

async function profile(env, ...flags) {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "profile", ...flags], {
    env: { ...process.env, ...env, NO_COLOR: "1" },
    cwd: env.HOME,
  });
  return stdout;
}

const PRO = { organizationType: "claude_pro", organizationRateLimitTier: "default_claude_ai" };

test("profile detects the plan with no flag", { skip }, async () => {
  const out = await profile(home({ account: PRO }));
  assert.match(out, /Plan · detected from your Claude Code sign-in/);
  assert.match(out, /Claude Pro/);
  assert.doesNotMatch(out, /--plan pro/);
});

test("profile says the plan is unknown rather than guessing", { skip }, async () => {
  const out = await profile(home());
  assert.match(out, /Plan: unknown/);
  assert.doesNotMatch(out, /Plan · /);
});

test("a Max sign-in without a tier asks which one", { skip }, async () => {
  const out = await profile(home({ account: { organizationType: "claude_max" } }));
  assert.match(out, /Plan: Claude Max, tier not reported/);
  assert.match(out, /--plan max5 or --plan max20/);
});

test("--plan wins over detection and says it disagrees", { skip }, async () => {
  const out = await profile(home({ account: PRO }), "--plan", "max5");
  assert.match(out, /Plan · from --plan/);
  assert.match(out, /Claude Max 5x/);
  assert.match(out, /Claude Code's sign-in says Claude Pro/);
});

test("the config wins over detection; plan api silences it all", { skip }, async () => {
  const fromConfig = await profile(home({ account: PRO, config: { plan: "max20" } }));
  assert.match(fromConfig, /Plan · from your config/);
  assert.match(fromConfig, /Claude Max 20x/);

  const api = await profile(home({ account: PRO, config: { plan: "api" } }));
  assert.doesNotMatch(api, /Plan · |Plan: /);
});

test("profile --json carries the detection and the plan's source", { skip }, async () => {
  const p = JSON.parse(await profile(home({ account: PRO }), "--json"));
  assert.equal(p.plan.source, "detected");
  assert.deepEqual(p.detectedPlan, { kind: "plan", plan: "pro", label: "Claude Pro" });
});
