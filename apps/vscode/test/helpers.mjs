import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// The bundle the extension ships, minus the editor, plus fixtures shared by
// the tests. Every path is read at call time, so a sandbox can move them.

export const lib = createRequire(import.meta.url)("../dist/lib.cjs");

export const OPUS = "claude-opus-5-5";
const MIN = 60_000;

/** A home of its own: empty optimAIzr and Claude Code folders. */
export function sandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `optimaizr-vscode-${name}-`));
  process.env.OPTIMAIZR_DIR = path.join(dir, ".optimaizr");
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, ".claude");
  fs.mkdirSync(process.env.OPTIMAIZR_DIR, { recursive: true });
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  return dir;
}

export function fix(over = {}) {
  return {
    rule: "context-compaction",
    label: "Compact at 200K",
    tier: "fix",
    monthlyUsd: 40,
    usageShare: 0.06,
    confidence: "high",
    happened: "Conversations ran past 200K.",
    why: "Every call re-reads the whole conversation.",
    fix: "Compact a little before 200K.",
    kind: "compaction",
    doneAt: null,
    scope: { source: "claude-code" },
    ...over,
  };
}

/** A month like the one on the machine this was built on, trimmed down. */
export function snapshot(over = {}, now = Date.now()) {
  return {
    version: 1,
    at: new Date(now - 2 * MIN).toISOString(),
    days: 30,
    empty: false,
    window: { from: "Sep 29", to: "Oct 28", days: 30 },
    spend: { windowUsd: 676, perMonthUsd: 676, calls: 9120, tokens: 812_000_000 },
    plan: {
      label: "Claude Pro",
      priceUsd: 20,
      valueMonthlyUsd: 676,
      multiple: 33.8,
      limitUsd: 9.5,
      current: null,
    },
    allIn: {
      share: 0.13,
      monthlyUsd: 88,
      moreWork: 1.4,
      parts: [
        { rule: "context-compaction", label: "Compact at 200K", tier: "fix", share: 0.06 },
        { rule: "model-choice", label: "Sonnet for lookups", tier: "try", share: 0.05 },
        { rule: "idle-cache", label: "Reply before the cache expires", tier: "test", share: 0.02 },
      ],
    },
    savings: { clearMonthlyUsd: 40, likelyMonthlyUsd: 60 },
    biggestWin: { ...fix(), share: 0.06, moreWork: 1.06 },
    breakdown: { reread: 0.62, output: 0.21, cacheWrite: 0.14, input: 0.02, tools: 0.01 },
    fixes: [
      fix({
        rule: "dup-read",
        label: "Reading the same file twice",
        tier: "fix",
        monthlyUsd: 2,
        kind: "habit",
      }),
      fix(),
      fix({
        rule: "model-choice",
        label: "Sonnet for lookups",
        tier: "try",
        monthlyUsd: 56,
        kind: "habit",
      }),
    ],
    smaller: 2,
    compaction: { at: null, ours: false, since: null },
    guard: { on: false, catches: 0, savedUsd: 0, recent: [] },
    results: [
      {
        name: "Opus -> Sonnet",
        since: "2026-10-20T10:00:00.000Z",
        verdict: "working",
        text: "working: 18% less per prompt",
      },
    ],
    week: "Last 7 days: 12% less per prompt than the week before.",
    rate: { usdPerPercent: 0.41, basis: "limit hits" },
    titles: {},
    recent: [],
    firstLook: null,
    ...over,
  };
}

export function convo(over = {}, now = Date.now()) {
  return {
    sessionId: "s1",
    title: "Fix the login bug",
    project: "/work/app",
    model: OPUS,
    context: 142_000,
    expiresAt: now + 4 * MIN,
    rewriteUsd: 1.78,
    readUsd: 0.07,
    lastAt: now - MIN,
    ...over,
  };
}

export function live(over = {}, now = Date.now()) {
  return {
    now,
    convo: null,
    warm: [],
    fiveHour: null,
    lastTurn: null,
    cold: { count: 0, usd: 0 },
    ...over,
  };
}

export function view(over = {}, now = Date.now()) {
  return {
    snapshot: snapshot({}, now),
    live: live({}, now),
    loading: false,
    error: null,
    busy: null,
    cli: "found",
    ...over,
  };
}

/** Claude Code's records for one conversation, the shape its transcripts have. */
export function transcript(session, cwd, script, start) {
  const recs = [];
  let at = start;
  for (const s of script) {
    at += (s.after ?? 10) * 1000;
    const timestamp = new Date(at).toISOString();
    if (s.prompt) {
      recs.push({
        type: "user",
        uuid: `${session}-u${recs.length}`,
        timestamp,
        sessionId: session,
        cwd,
        message: { role: "user", content: [{ type: "text", text: s.prompt }] },
      });
      continue;
    }
    const id = `${session}-m${recs.length}`;
    const tools = s.tool
      ? [{ type: "tool_use", id: `${id}-t`, name: "Bash", input: { command: s.tool } }]
      : [];
    recs.push({
      type: "assistant",
      timestamp,
      sessionId: session,
      cwd,
      message: {
        id,
        model: OPUS,
        stop_reason: tools.length ? "tool_use" : "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 300,
          cache_read_input_tokens: s.read ?? 0,
          cache_creation_input_tokens: s.write ?? 500,
        },
        content: tools,
      },
    });
    if (tools.length) {
      at += 1000;
      recs.push({
        type: "user",
        timestamp: new Date(at).toISOString(),
        sessionId: session,
        cwd,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: tools[0].id, content: "ok", is_error: false },
          ],
        },
      });
    }
  }
  return recs;
}

export function writeTranscript(root, cwd, session, recs) {
  const dir = path.join(root, lib.projectDirName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}
