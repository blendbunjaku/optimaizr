import fs from "node:fs";
import crypto from "node:crypto";

import { costOf, normalizeUsage, providerOf } from "../pricing.js";
import type { CallEvent } from "../types.js";

/**
 * Import usage data you already have, as CSV or JSON. Column names are matched
 * loosely against what provider exports actually use. Rows that can't be
 * priced are imported and flagged, never dropped or guessed.
 */

/** Column aliases, lowercased and stripped of separators. */
const FIELDS: Record<string, string[]> = {
  model: ["model", "modelid", "modelname", "engine", "deployment"],
  ts: ["timestamp", "time", "date", "createdat", "requesttime", "starttime"],
  inputTokens: ["inputtokens", "prompttokens", "input", "ntokensprompt", "tokensin"],
  outputTokens: ["outputtokens", "completiontokens", "output", "ntokenscompletion", "tokensout"],
  cacheReadTokens: ["cachereadtokens", "cachereadinputtokens", "cachedtokens", "cachedinputtokens"],
  cacheWriteTokens: ["cachewritetokens", "cachecreationinputtokens", "cachecreationtokens"],
  thinkingTokens: ["thinkingtokens", "reasoningtokens"],
  latencyMs: ["latencyms", "latency", "durationms", "responsetimems"],
  route: ["route", "endpoint", "operation", "feature", "usecase"],
  project: ["project", "service", "application", "app", "workspace"],
  sessionId: ["sessionid", "session", "conversationid", "traceid", "requestid"],
  costUsd: ["cost", "costusd", "amount", "spend", "totalcost"],
};

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Build a map from a row's own headers to our canonical field names. */
function mapHeaders(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers) {
    const n = normalise(header);
    for (const [field, aliases] of Object.entries(FIELDS)) {
      if (aliases.includes(n)) {
        map.set(header, field);
        break;
      }
    }
  }
  return map;
}

/** Minimal RFC 4180 CSV parsing: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  return rows.map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h.trim()] = (r[i] ?? "").trim();
    });
    return obj;
  });
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export interface ImportOptions {
  /** Label applied when the export has no project column. */
  service?: string;
}

export interface ImportResult {
  events: CallEvent[];
  /** Rows that had no model or no token counts. */
  skipped: number;
}

/** Convert one loosely-shaped row into a CallEvent. */
function rowToEvent(
  row: Record<string, unknown>,
  headerMap: Map<string, string>,
  opts: ImportOptions,
): CallEvent | null {
  const get = (field: string): unknown => {
    for (const [header, mapped] of headerMap) {
      if (mapped === field && row[header] !== undefined && row[header] !== "") return row[header];
    }
    return undefined;
  };

  const model = String(get("model") ?? "").trim();
  if (!model) return null;

  const inputTokens = toNumber(get("inputTokens"));
  const outputTokens = toNumber(get("outputTokens"));
  const cacheReadTokens = toNumber(get("cacheReadTokens"));
  const cacheWriteTokens = toNumber(get("cacheWriteTokens"));
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return null;

  const rawTs = get("ts");
  const parsed = rawTs ? new Date(String(rawTs)) : new Date();
  const ts = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();

  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens,
  };

  // OpenAI exports' prompt tokens include cached tokens; Anthropic's don't.
  // Normalise so the event means the same thing either way.
  const n = normalizeUsage(usage, model);

  const computed = costOf(usage, model, { at: ts });
  // A cost column in the export is the bill, so it wins.
  const stated = get("costUsd");
  const cost =
    stated !== undefined && toNumber(stated) > 0
      ? { ...computed, total: toNumber(stated), unpriced: false }
      : computed;

  const latency = toNumber(get("latencyMs"));

  return {
    id: String(get("sessionId") ?? crypto.randomUUID()),
    source: "sdk",
    ts,
    model,
    provider: providerOf(model),
    sessionId: String(get("sessionId") ?? "imported"),
    project: String(get("project") ?? opts.service ?? "imported"),
    route: get("route") ? String(get("route")) : undefined,
    inputTokens: n.inputTokens,
    outputTokens: n.outputTokens,
    thinkingTokens: toNumber(get("thinkingTokens")) || n.thinkingTokens,
    cacheReadTokens: n.cacheReadTokens,
    cacheWrite5mTokens: n.cacheWrite5mTokens,
    cacheWrite1hTokens: n.cacheWrite1hTokens,
    webSearches: n.webSearches,
    latencyMs: latency > 0 ? latency : undefined,
    tools: [],
    cost,
  };
}

export function importUsageFile(file: string, opts: ImportOptions = {}): ImportResult {
  const text = fs.readFileSync(file, "utf8");
  let rows: Record<string, unknown>[];

  if (
    file.endsWith(".json") ||
    text.trimStart().startsWith("[") ||
    text.trimStart().startsWith("{")
  ) {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : (parsed.data ?? parsed.usage ?? parsed.results ?? []);
  } else {
    rows = parseCsv(text);
  }

  if (!Array.isArray(rows) || rows.length === 0) return { events: [], skipped: 0 };

  const headerMap = mapHeaders(Object.keys(rows[0] as Record<string, unknown>));
  const events: CallEvent[] = [];
  let skipped = 0;

  for (const row of rows) {
    const event = rowToEvent(row as Record<string, unknown>, headerMap, opts);
    if (event) events.push(event);
    else skipped++;
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, skipped };
}
