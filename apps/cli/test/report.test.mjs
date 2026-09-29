import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ingestClaudeCode } from "@optimaizr/core";
import { summarize } from "@optimaizr/core";
import { findWaste } from "@optimaizr/core";
import { renderHtml } from "@optimaizr/core";

/**
 * The HTML report is the one artefact optimAIzr produces that gets forwarded —
 * emailed to finance, committed, opened by someone who never ran the tool. The
 * names inside it (models, projects, providers, routes) arrive from transcripts,
 * directory names and `optimaizr import` files, none of which we control.
 *
 * So the report is treated as a rendering of untrusted data.
 */

const BREAKOUT = "</script><script>alert(document.domain)</script>";
const MARKUP = "<img src=x onerror=alert(1)>";

function writeFixture(models) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-report-"));
  const dir = path.join(root, "-Users-someone-project");
  fs.mkdirSync(dir, { recursive: true });
  const records = models.map((model, i) => ({
    type: "assistant",
    timestamp: `2026-09-0${i + 1}T10:00:00.000Z`,
    sessionId: "session-a",
    cwd: "/Users/someone/project",
    message: {
      id: `msg_${i}`,
      model,
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
    },
  }));
  fs.writeFileSync(
    path.join(dir, "session-a.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return root;
}

async function reportFor(models) {
  const data = await ingestClaudeCode({ root: writeFixture(models) });
  return renderHtml(summarize(data), findWaste(data), {});
}

/** The DATA literal, evaluated the way the browser's parser would evaluate it. */
function embeddedData(html) {
  const m = html.match(/var DATA = (\{[\s\S]*?\});/);
  assert.ok(m, "report embeds a DATA literal");
  return new Function(`return (${m[1]})`)();
}

test("a model name cannot close the report's script block", async () => {
  const html = await reportFor([BREAKOUT, "claude-sonnet-5"]);

  assert.ok(!html.includes(BREAKOUT), "the payload is never emitted raw");
  assert.equal(
    html.match(/<script/g).length,
    html.match(/<\/script>/g).length,
    "script tags stay balanced, so nothing broke out of the block",
  );
});

test("markup in ingested names is never emitted as markup", async () => {
  const html = await reportFor([MARKUP, "claude-sonnet-5"]);

  assert.ok(!html.includes(MARKUP), "no raw tag reaches the document");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "it is shown as text instead");
});

test("escaping the embedded JSON does not corrupt the values it carries", async () => {
  const html = await reportFor([BREAKOUT, MARKUP]);
  const keys = embeddedData(html).model.map((r) => r.key);

  // Escaped for the parser, identical once parsed - the chart still labels
  // the row with the name that was actually in the data.
  assert.ok(keys.includes(BREAKOUT));
  assert.ok(keys.includes(MARKUP));
});

test("chart rows are built as DOM, so a name can never be interpreted as markup", async () => {
  const html = await reportFor(["claude-sonnet-5"]);

  assert.ok(!/rows\.innerHTML/.test(html), "no innerHTML sink for row data");
  assert.ok(/name\.textContent = r\.key/.test(html), "the name goes in as text");
});

test("the org label is escaped", async () => {
  const data = await ingestClaudeCode({ root: writeFixture(["claude-sonnet-5"]) });
  const html = renderHtml(summarize(data), findWaste(data), { org: MARKUP });

  assert.ok(!html.includes(MARKUP));
  assert.ok(html.includes("&lt;img src=x"));
});

test("the report carries no credential-shaped material", async () => {
  const html = await reportFor(["claude-sonnet-5"]);

  assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(html), "no API key shape");
  assert.ok(!/ANTHROPIC_API_KEY/.test(html), "no key variable named");
  assert.ok(!/Bearer\s+[A-Za-z0-9._-]{12,}/.test(html), "no bearer token");
});
