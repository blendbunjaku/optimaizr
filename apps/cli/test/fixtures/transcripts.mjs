import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingestClaudeCode, ingestCodex } from "@optimaizr/core";

/** Claude Code transcripts built from short scripts, shared by the task and tier tests. */

export const OPUS = "claude-opus-5-5";
export const START = Date.UTC(2026, 8, 20, 10, 0);

/**
 * A Claude Code transcript from a short script:
 * `{ prompt }`, `{ compact: true }`, or a call `{ tools, out, think, ctx, side, stop }`
 * where each tool is `{ name, input, error?, chars? }`. Records are 20 seconds
 * apart; `gap` adds minutes before one. A call's `write` sets its cache write,
 * 500 by default, and `hour` makes it a 1-hour write.
 */
export function transcript(session, script) {
  const recs = [];
  let n = 0;
  let idle = 0;
  const at = (s = {}) => {
    idle += (s.gap ?? 0) * 60_000;
    return new Date(START + idle + n++ * 20_000).toISOString();
  };
  for (const s of script) {
    const side = s.side ? { isSidechain: true, agentId: s.side } : {};
    if (s.prompt !== undefined) {
      recs.push({
        type: "user",
        uuid: `${session}-u${n}`,
        timestamp: at(s),
        sessionId: session,
        ...side,
        ...(s.meta ? { isMeta: true } : {}),
        message: { role: "user", content: [{ type: "text", text: s.prompt }] },
      });
      continue;
    }
    if (s.compact) {
      recs.push({
        type: "system",
        subtype: "compact_boundary",
        timestamp: at(),
        sessionId: session,
      });
      continue;
    }
    const id = `${session}-m${n}`;
    const tools = (s.tools ?? []).map((t, k) => ({
      type: "tool_use",
      id: `${id}-t${k}`,
      name: t.name,
      input: t.input ?? {},
    }));
    const write = s.write ?? 500;
    recs.push({
      type: "assistant",
      timestamp: at(s),
      sessionId: session,
      cwd: "/w",
      ...side,
      message: {
        id,
        model: s.model ?? OPUS,
        stop_reason: s.stop ?? (tools.length ? "tool_use" : "end_turn"),
        usage: {
          input_tokens: 10,
          output_tokens: s.out ?? 200,
          ...(s.think ? { output_tokens_details: { thinking_tokens: s.think } } : {}),
          cache_read_input_tokens: s.ctx ?? 20_000,
          cache_creation_input_tokens: write,
          ...(s.hour ? { cache_creation: { ephemeral_1h_input_tokens: write } } : {}),
        },
        content: tools,
      },
    });
    if (tools.length) {
      recs.push({
        type: "user",
        timestamp: at(),
        sessionId: session,
        ...side,
        message: {
          role: "user",
          content: tools.map((b, k) => ({
            type: "tool_result",
            tool_use_id: b.id,
            content: "x".repeat(s.tools[k].chars ?? 2_000),
            is_error: Boolean(s.tools[k].error),
          })),
        },
      });
    }
  }
  return recs;
}

export async function load(sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-tasks-"));
  const dir = path.join(root, "-w");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, recs] of Object.entries(sessions)) {
    fs.writeFileSync(
      path.join(dir, `${name}.jsonl`),
      recs.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }
  return ingestClaudeCode({ root });
}

export const read = (file, extra = {}) => ({ name: "Read", input: { file_path: file, ...extra } });
export const edit = (file, change = "a") => ({
  name: "Edit",
  input: { file_path: file, old_string: change, new_string: `${change}!` },
});
export const bash = (command, extra = {}) => ({ name: "Bash", input: { command }, ...extra });

/**
 * A quick lookup: read one file, answer in a paragraph. Cache reads cost the
 * same on Opus 5.5 and Sonnet 5.5, so the saving is in output and cache writes.
 */
export const lookup = (opts = {}) => [
  { prompt: "where is it?", ...(opts.side ? { side: opts.side } : {}) },
  { tools: [read(opts.file ?? "/w/a.ts")], out: 150, ctx: opts.ctx ?? 5_000, side: opts.side },
  { out: 800, ctx: opts.ctx ?? 5_000, side: opts.side },
];

/**
 * A Codex rollout from a short script: `{ prompt, gap }`, `{ compact: true }`,
 * or a call `{ cmd, error, out, think, ctx, cached }`. Each call is one billed
 * token_count; `gap` is minutes away before the prompt.
 */
export function codexRollout(id, script, model = "gpt-5.4") {
  const rows = [];
  let n = 0;
  let idle = 0;
  let total = 0;
  const at = (gap = 0) => {
    idle += gap * 60_000;
    return new Date(START + idle + n++ * 20_000).toISOString();
  };
  const row = (type, payload, gap) => rows.push({ type, timestamp: at(gap), payload });
  row("session_meta", { id, cwd: "/w" });
  row("turn_context", { model });
  for (const s of script) {
    if (s.prompt !== undefined) {
      row("event_msg", { type: "user_message", message: s.prompt }, s.gap);
      continue;
    }
    if (s.compact) {
      row("event_msg", { type: "context_compacted" });
      continue;
    }
    if (s.cmd) {
      const callId = `c${n}`;
      row("response_item", {
        type: "function_call",
        call_id: callId,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: s.cmd }),
      });
      row("response_item", {
        type: "function_call_output",
        call_id: callId,
        output: `Process exited with code ${s.error ? 1 : 0}\n${"x".repeat(2_000)}`,
      });
    }
    const ctx = s.ctx ?? 20_000;
    const out = s.out ?? 200;
    total += ctx + out;
    row("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: {
          input_tokens: ctx,
          cached_input_tokens: s.cached ?? Math.max(0, ctx - 500),
          output_tokens: out,
          reasoning_output_tokens: s.think ?? 0,
          total_tokens: ctx + out,
        },
      },
    });
  }
  return rows;
}

/** Write rollouts where Codex keeps them and ingest them. */
export async function loadCodex(rollouts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-codex-"));
  const dir = path.join(root, "2026", "09", "20");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(rollouts)) {
    fs.writeFileSync(
      path.join(dir, `rollout-${name}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }
  return ingestCodex({ root });
}
