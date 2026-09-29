import type { FrontierJudge, UsageEvent } from "@optimaizr/core";

/**
 * Jev (TypeSafe) as an optional second opinion on model fit. It can only veto
 * a downgrade the rules would have recommended, never invent one, so a wrong
 * answer costs a missed saving, not a bad recommendation.
 *
 * This is the only outbound path in optimAIzr, off unless you pass an API key.
 * It sends metadata only: route label, model id, call count, median token
 * counts and tool names. Never prompts, completions or tool payloads.
 * `describeEgress()` or `dryRun` shows the exact bytes before anything is sent.
 * Raw HTTP rather than `@typesafe-ai/sdk` keeps a network SDK out of the
 * dependency tree.
 */

/** Documented endpoint and default model alias. */
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/** Documented limit is 1,200 req/min; batching questions keeps us far below it. */
const MAX_QUESTIONS_PER_CALL = 32;

/* ------------------------------------------------------------------ *
 * Wire types: the documented request/response shapes.
 * ------------------------------------------------------------------ */

interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

interface SystemOneRequest {
  state: string[];
  model: string;
  questions: Record<string, NoulQuestion>;
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

interface SystemOneResponse {
  model: string;
  answers: Record<string, NoulAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/* ------------------------------------------------------------------ *
 * Route profiles: the only thing described to Jev.
 * ------------------------------------------------------------------ */

/**
 * Judged per route (one call site, one job), not per call: the answer is
 * stable, cacheable, and a better signal than any single call.
 */
interface RouteProfile {
  key: string;
  route: string;
  model: string;
  calls: number;
  inputTokens: number[];
  outputTokens: number[];
  thinkingTokens: number;
  tools: Set<string>;
}

export interface JevOptions {
  /** Defaults to `TYPESAFE_API_KEY`. With no key the judge is inert. */
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Minimum gap between refreshes. Profiles change slowly; no need to rush. */
  refreshIntervalMs?: number;
  /** Calls a route must accumulate before it is worth asking about. */
  minCalls?: number;
  /** Build the request and hand it to `onRequest` without sending it. */
  dryRun?: boolean;
  /** Observability hooks. Never throw from these. */
  onRequest?: (body: SystemOneRequest) => void;
  onError?: (err: Error) => void;
  onVerdict?: (route: string, needsFrontier: number) => void;
}

export interface JevJudge {
  /** Record a call. Cheap, synchronous, never blocks the caller. */
  observe(event: UsageEvent): void;
  /** The sync lookup handed to the live analyzer. */
  judge: FrontierJudge;
  /** Exactly what would be sent right now, for inspection. */
  describeEgress(): SystemOneRequest | null;
  /** Ask Jev about any routes that qualify. Safe to call often; self-throttles. */
  refresh(): Promise<void>;
  /** Verdicts held so far, route -> probability it needs a frontier model. */
  verdicts(): ReadonlyMap<string, number>;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** A route's identity for judging: the call site, falling back to the model. */
function keyOf(e: UsageEvent): string {
  return e.route ?? e.model;
}

/** One line of `key=value` metadata per route, easy to audit for prompt content. */
function describe(p: RouteProfile): string {
  const tools = [...p.tools].sort().join(",") || "none";
  return [
    `route=${JSON.stringify(p.route)}`,
    `model=${p.model}`,
    `calls=${p.calls}`,
    `median_input_tokens=${Math.round(median(p.inputTokens))}`,
    `median_output_tokens=${Math.round(median(p.outputTokens))}`,
    `thinking_tokens=${p.thinkingTokens}`,
    `tools=${tools}`,
  ].join(" ");
}

function questionFor(p: RouteProfile): NoulQuestion {
  return {
    type: "noul",
    instructions:
      `The route ${JSON.stringify(p.route)} in the state list describes a repeated LLM call site, ` +
      `given only by its name, its model and its token and tool profile. ` +
      `This workload genuinely requires a frontier reasoning model and would lose quality on a small fast model.`,
    criteria: {
      true:
        "The work implied by the route name needs multi-step reasoning, open-ended synthesis, " +
        "nuanced judgement, or long-range coherence.",
      false:
        "The work is mechanical (classification, extraction, formatting, routing, short " +
        "summarisation, or a single tool call) and a small fast model would do it as well.",
    },
  };
}

export function createJevJudge(opts: JevOptions = {}): JevJudge {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  const model = opts.model ?? MODEL;
  const endpoint = opts.endpoint ?? ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 60_000;
  const minCalls = opts.minCalls ?? 5;

  const profiles = new Map<string, RouteProfile>();
  const verdicts = new Map<string, number>();
  let lastRefresh = 0;
  let inFlight = false;

  /** Routes worth asking about: enough traffic, and no answer yet. */
  function pending(): RouteProfile[] {
    const out: RouteProfile[] = [];
    for (const p of profiles.values()) {
      if (p.calls < minCalls) continue;
      if (verdicts.has(p.key)) continue;
      out.push(p);
    }
    return out.slice(0, MAX_QUESTIONS_PER_CALL);
  }

  function buildRequest(batch: RouteProfile[]): SystemOneRequest | null {
    if (batch.length === 0) return null;
    const questions: Record<string, NoulQuestion> = {};
    // Positional ids: route labels are free-form and don't work as identifiers.
    batch.forEach((p, i) => {
      questions[`r${i}`] = questionFor(p);
    });
    return { state: batch.map(describe), model, questions };
  }

  return {
    observe(event: UsageEvent): void {
      try {
        const key = keyOf(event);
        let p = profiles.get(key);
        if (!p) {
          p = {
            key,
            route: key,
            model: event.model,
            calls: 0,
            inputTokens: [],
            outputTokens: [],
            thinkingTokens: 0,
            tools: new Set(),
          };
          profiles.set(key, p);
        }
        p.calls++;
        // Bounded: a long-lived process must not accumulate per-call arrays.
        if (p.inputTokens.length < 200) p.inputTokens.push(event.inputTokens);
        if (p.outputTokens.length < 200) p.outputTokens.push(event.outputTokens);
        p.thinkingTokens += event.thinkingTokens;
        for (const t of event.tools) p.tools.add(t.name);
      } catch {
        /* recording must never break the caller */
      }
    },

    judge(event: UsageEvent): number | undefined {
      return verdicts.get(keyOf(event));
    },

    describeEgress(): SystemOneRequest | null {
      return buildRequest(pending());
    },

    async refresh(): Promise<void> {
      // A dry run needs no key: it shows what would be sent before you commit.
      if ((!apiKey && !opts.dryRun) || inFlight) return;
      const since = Date.now() - lastRefresh;
      if (since < refreshIntervalMs) return;

      const batch = pending();
      const body = buildRequest(batch);
      if (!body) return;

      inFlight = true;
      lastRefresh = Date.now();
      try {
        opts.onRequest?.(body);
        if (opts.dryRun) return;

        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          // 429 and 529 are retryable. The interval gate on refresh is the
          // backoff, and a missing verdict just means the rules decide alone.
          throw new Error(`jev: ${res.status} ${res.statusText}`);
        }

        const json = (await res.json()) as SystemOneResponse;
        batch.forEach((p, i) => {
          const answer = json.answers[`r${i}`];
          if (!answer || typeof answer.noul !== "number") return;
          verdicts.set(p.key, answer.noul);
          opts.onVerdict?.(p.route, answer.noul);
        });
      } catch (err) {
        // A judge that's down degrades to "no opinion", never an error for the host.
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        inFlight = false;
      }
    },

    verdicts(): ReadonlyMap<string, number> {
      return verdicts;
    },
  };
}
