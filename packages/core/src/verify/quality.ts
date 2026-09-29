/**
 * The quality bar a change must clear before it's applied. `verify` replays
 * your own traffic under the change and measures the output two ways:
 * deterministic checks (JSON parses, same tool called, length budget), where
 * any regression fails the candidate; and a pairwise judge, shown both answers
 * twice with positions swapped, where a side must win both orders to win.
 */

import { costOf } from "../pricing.js";
import { dialectOf, sendChat, type Dialect } from "./dialect.js";

export type Check =
  | { type: "json-parses"; label?: string }
  | { type: "contains"; value: string; label?: string }
  | { type: "matches"; pattern: string; flags?: string; label?: string }
  | { type: "max-chars"; value: number; label?: string }
  | { type: "min-chars"; value: number; label?: string }
  | { type: "tool-name-matches"; label?: string }
  | { type: "no-refusal"; label?: string };

export interface JudgeConfig {
  /** Should be at least as capable as the baseline model. */
  model: string;
  /** What "better" means for this route, in your words. */
  criteria: string;
  /**
   * Minimum acceptable win rate for the candidate, where 0.5 is parity.
   * Default 0.45: marginally worse is fine, materially worse is not.
   */
  minWinRate?: number;
}

export interface QualityBar {
  checks: Check[];
  judge?: JudgeConfig;
  /** How many recorded calls to replay. Default 40. */
  sampleSize?: number;
}

export const DEFAULT_BAR: QualityBar = {
  checks: [{ type: "no-refusal" }, { type: "tool-name-matches" }],
  judge: {
    model: "claude-opus-5",
    criteria:
      "Which response better completes the user's request: more accurate, more complete, and correctly formatted?",
    minWinRate: 0.45,
  },
  sampleSize: 40,
};

const REFUSAL = /\b(I can't help|I cannot help|I'm unable to|I can't assist|I cannot assist)\b/i;

/**
 * The answer text of a response in any vendor's shape: Anthropic content
 * blocks, OpenAI `choices` or Responses `output`, Gemini candidates, a whole
 * response object, or a bare string.
 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";

  const value = content as any;

  // A whole response object: unwrap to the part that carries the answer.
  if (Array.isArray(value.content)) return textOf(value.content);
  if (Array.isArray(value.choices)) return textOf(value.choices);
  if (Array.isArray(value.output)) return textOf(value.output);
  // Gemini: candidates -> content -> parts.
  if (Array.isArray(value.candidates)) return textOf(value.candidates);
  if (Array.isArray(value.parts)) return textOf(value.parts);
  if (value.content && Array.isArray(value.content.parts)) return textOf(value.content.parts);
  // One OpenAI choice.
  if (value.message && typeof value.message === "object") return textOf(value.message.content);

  if (!Array.isArray(value)) return "";
  return value
    .flatMap((b: any) => {
      if (typeof b === "string") return [b];
      // Anthropic text block, or OpenAI Responses output_text.
      if ((b?.type === "text" || b?.type === "output_text") && typeof b.text === "string") {
        return [b.text];
      }
      // An OpenAI choice, or a Responses message wrapping its own content.
      if (b?.message !== undefined) return [textOf(b.message.content)];
      if (b?.type === "message" && Array.isArray(b.content)) return [textOf(b.content)];
      // A Gemini candidate, or one of its parts. Parts carry no `type`, which
      // is what keeps this from swallowing the typed blocks handled above.
      if (b?.content && Array.isArray(b.content.parts)) return [textOf(b.content.parts)];
      if (b?.type === undefined && typeof b?.text === "string") return [b.text];
      return [];
    })
    .filter((t) => t !== "")
    .join("\n");
}

export function toolNamesOf(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const value = content as any;

  if (Array.isArray(value.content)) return toolNamesOf(value.content);
  if (Array.isArray(value.choices)) return toolNamesOf(value.choices);
  if (Array.isArray(value.output)) return toolNamesOf(value.output);
  // Gemini: candidates -> content -> parts.
  if (Array.isArray(value.candidates)) return toolNamesOf(value.candidates);
  if (Array.isArray(value.parts)) return toolNamesOf(value.parts);
  if (value.content && Array.isArray(value.content.parts)) return toolNamesOf(value.content.parts);

  if (!Array.isArray(value)) return [];
  return value.flatMap((b: any) => {
    // Anthropic tool use.
    if (b?.type === "tool_use") return [String(b.name)];
    // Gemini function call, on a candidate or directly on a part.
    if (b?.content && Array.isArray(b.content.parts)) return toolNamesOf(b.content.parts);
    if (b?.functionCall?.name) return [String(b.functionCall.name)];
    // OpenAI Responses function call.
    if (b?.type === "function_call") return [String(b.name ?? "unknown")];
    // An OpenAI choice, whose calls hang off its message.
    const calls = b?.message?.tool_calls ?? b?.tool_calls;
    if (Array.isArray(calls)) {
      return calls.map((c: any) => String(c?.function?.name ?? c?.name ?? "unknown"));
    }
    return [];
  });
}

export function labelOf(check: Check): string {
  if (check.label) return check.label;
  switch (check.type) {
    case "contains":
      return `contains "${check.value.slice(0, 24)}"`;
    case "matches":
      return `matches /${check.pattern.slice(0, 24)}/`;
    case "max-chars":
      return `at most ${check.value} chars`;
    case "min-chars":
      return `at least ${check.value} chars`;
    default:
      return check.type;
  }
}

/** Run one check against one response. `baseline` supplies the reference tool calls. */
export function runCheck(check: Check, content: unknown, baseline: unknown): boolean {
  const text = textOf(content);
  switch (check.type) {
    case "json-parses": {
      const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      if (!body) return false;
      try {
        JSON.parse(body);
        return true;
      } catch {
        return false;
      }
    }
    case "contains":
      return text.includes(check.value);
    case "matches":
      try {
        return new RegExp(check.pattern, check.flags ?? "").test(text);
      } catch {
        return false;
      }
    case "max-chars":
      return text.length <= check.value;
    case "min-chars":
      return text.length >= check.value;
    case "tool-name-matches": {
      const want = toolNamesOf(baseline).join(",");
      const got = toolNamesOf(content).join(",");
      return want === got;
    }
    case "no-refusal":
      return !REFUSAL.test(text);
  }
}

export interface CheckResult {
  label: string;
  baselinePassed: number;
  candidatePassed: number;
  total: number;
  /** True when the candidate passes at least as often as the baseline. */
  ok: boolean;
}

export type JudgeVerdict = "candidate" | "baseline" | "tie";

/**
 * What the judging cost, priced from the usage each judge call reported. Calls
 * with no usage or an unknown model are counted in `unpriced` rather than
 * guessed, so `usd` is then a floor.
 */
export interface JudgeCost {
  /** Measured cost of judge calls, from reported usage at the rate in force. */
  usd: number;
  /** Judge calls that were priced. */
  priced: number;
  /** Judge calls whose cost is unknown and therefore missing from `usd`. */
  unpriced: number;
}

export interface JudgePairResult {
  verdict: JudgeVerdict;
  cost: JudgeCost;
}

const NO_JUDGE_COST: JudgeCost = { usd: 0, priced: 0, unpriced: 0 };

/** Add up judge costs without losing the priced/unpriced split. */
export function addJudgeCost(a: JudgeCost, b: JudgeCost): JudgeCost {
  return {
    usd: a.usd + b.usd,
    priced: a.priced + b.priced,
    unpriced: a.unpriced + b.unpriced,
  };
}

export const emptyJudgeCost = (): JudgeCost => ({ ...NO_JUDGE_COST });

const JUDGE_SYSTEM =
  "You are evaluating two responses to the same request. Judge only on the stated criteria. " +
  "Ignore length, style and formatting differences that do not affect whether the request is satisfied. " +
  'Reply with exactly one token: "A", "B", or "TIE".';

/**
 * Build the judge call in the judge model's own dialect. Reasoning models
 * spend output budget thinking before they answer, so the ceiling leaves room
 * for that: a tight one returns nothing, which would score as a tie.
 */
function judgeRequest(cfg: JudgeConfig, user: string, dialect: Dialect): Record<string, any> {
  switch (dialect) {
    case "anthropic-messages":
      return {
        model: cfg.model,
        max_tokens: 1024,
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: user }],
      };
    case "openai-chat":
      return {
        model: cfg.model,
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: user },
        ],
      };
    case "openai-responses":
      return {
        model: cfg.model,
        max_output_tokens: 1024,
        instructions: JUDGE_SYSTEM,
        input: user,
      };
    case "google-generate-content":
      // Gemini takes the system prompt and settings under `config`, and thinks
      // by default, so it gets the same budget as the other reasoning models.
      return {
        model: cfg.model,
        contents: [{ role: "user", parts: [{ text: user }] }],
        config: {
          maxOutputTokens: 1024,
          systemInstruction: JUDGE_SYSTEM,
        },
      };
  }
}

/**
 * Judge one pair, shown twice with positions swapped; a side must win both
 * orders to take the pair, otherwise it's a tie. `client` is the SDK for the
 * judge model's provider.
 */
export async function judgePair(
  client: any,
  cfg: JudgeConfig,
  prompt: string,
  baseline: string,
  candidate: string,
): Promise<JudgePairResult> {
  const dialect = dialectOf({ model: cfg.model });
  const ask = async (
    a: string,
    b: string,
  ): Promise<{ answer: "A" | "B" | "TIE"; cost: JudgeCost }> => {
    const res = await sendChat(
      client,
      judgeRequest(
        cfg,
        `Criteria: ${cfg.criteria}\n\n` +
          `--- REQUEST ---\n${prompt.slice(0, 6000)}\n\n` +
          `--- RESPONSE A ---\n${a.slice(0, 6000)}\n\n` +
          `--- RESPONSE B ---\n${b.slice(0, 6000)}\n\n` +
          "Which response better satisfies the criteria? Answer A, B, or TIE.",
        dialect,
      ),
      dialect,
    );

    // Priced like the traffic it judges: reported usage at the rate in force.
    const priced = costOf((res as any)?.usage, (res as any)?.model ?? cfg.model);
    const cost: JudgeCost = priced.unpriced
      ? { usd: 0, priced: 0, unpriced: 1 }
      : { usd: priced.total, priced: 1, unpriced: 0 };

    const out = textOf(res).trim().toUpperCase();
    const answer = out.startsWith("A") ? "A" : out.startsWith("B") ? "B" : "TIE";
    return { answer, cost };
  };

  // Order 1: baseline as A. Order 2: candidate as A.
  const [first, second] = await Promise.all([ask(baseline, candidate), ask(candidate, baseline)]);
  const cost = addJudgeCost(first.cost, second.cost);

  const firstSaysCandidate = first.answer === "B";
  const secondSaysCandidate = second.answer === "A";
  if (firstSaysCandidate && secondSaysCandidate) return { verdict: "candidate", cost };

  const firstSaysBaseline = first.answer === "A";
  const secondSaysBaseline = second.answer === "B";
  if (firstSaysBaseline && secondSaysBaseline) return { verdict: "baseline", cost };

  return { verdict: "tie", cost };
}
