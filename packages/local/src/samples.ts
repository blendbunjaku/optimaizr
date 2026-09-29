import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";

import { optimaizrDir } from "./ledger.js";
import { anthropicMessages, type Shape } from "./providers/shapes.js";

/**
 * Sampled request/response pairs, used only by `optimaizr verify` to replay
 * your traffic. Prompts are sensitive, so capture is opt-in, sampled, redacted
 * and local-only. Nothing here is uploaded.
 */

export interface Sample {
  id: string;
  ts: string;
  route?: string;
  model: string;
  /** The request as sent, minus anything redaction removed. */
  request: Record<string, unknown>;
  /**
   * The response your app received: the baseline to beat, in its vendor's own
   * shape (the quality checks read all of them).
   */
  response: {
    content: unknown;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
}

export interface CaptureOptions {
  /** 0 disables capture; 0.05 samples one call in twenty. Default 0. */
  rate?: number;
  /** Cap on stored samples per route. Oldest are kept; newest dropped. */
  maxPerRoute?: number;
  /**
   * Redaction applied to every string before storage. Defaults to masking
   * emails, bearer tokens, API keys and long digit runs.
   */
  redact?: (text: string) => string;
}

const DEFAULT_PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[api-key]"],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [token]"],
  [/\b\d{12,}\b/g, "[number]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[card]"],
];

export function defaultRedact(text: string): string {
  let out = text;
  for (const [re, replacement] of DEFAULT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function deepRedact(value: unknown, redact: (t: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, redact);
    return out;
  }
  return value;
}

export function samplesPath(): string {
  return path.join(optimaizrDir(), "samples.jsonl");
}

const counts = new Map<string, number>();

/** Decide whether to store this call, then store it. Never throws. */
export function maybeCapture(
  params: any,
  response: any,
  opts: CaptureOptions,
  route: string | undefined,
  shape: Shape = anthropicMessages,
): void {
  try {
    const rate = opts.rate ?? 0;
    if (rate <= 0 || Math.random() >= rate) return;

    const key = route ?? "default";
    const max = opts.maxPerRoute ?? 200;
    const n = counts.get(key) ?? 0;
    if (n >= max) return;
    counts.set(key, n + 1);

    const redact = opts.redact ?? defaultRedact;
    const sample: Sample = {
      id: response?.id ?? crypto.randomUUID(),
      ts: new Date().toISOString(),
      route,
      model: response?.model ?? params?.model ?? "",
      request: deepRedact(shape.captureFieldsOf(params), redact) as Record<string, unknown>,
      response: {
        content: deepRedact(shape.answerOf(response), redact),
        stop_reason: shape.stopOf(response),
        usage: shape.usageOf(response),
      },
    };

    fs.mkdirSync(optimaizrDir(), { recursive: true });
    fs.appendFileSync(samplesPath(), `${JSON.stringify(sample)}\n`);
  } catch {
    /* capture must never break the caller */
  }
}

export async function readSamples(filter?: { route?: string; limit?: number }): Promise<Sample[]> {
  const file = samplesPath();
  if (!fs.existsSync(file)) return [];
  const out: Sample[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Sample;
      if (filter?.route && s.route !== filter.route) continue;
      out.push(s);
    } catch {
      /* skip malformed */
    }
  }
  return filter?.limit ? out.slice(-filter.limit) : out;
}
