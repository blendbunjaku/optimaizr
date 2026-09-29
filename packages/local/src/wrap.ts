import crypto from "node:crypto";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

import { costOf, normalizeUsage, priceFor, providerOf } from "@optimaizr/core";
import { append } from "./ledger.js";
import { maybeCapture, type CaptureOptions } from "./samples.js";
import { overrideFor, overridesPath, readOverrides, type ModelOverride } from "./overrides.js";
import {
  anthropicMessages,
  googleGenerateContent,
  openaiChat,
  openaiResponses,
  type Shape,
} from "./providers/shapes.js";
import type { CallEvent } from "@optimaizr/core";

/**
 * One-line integration, whichever vendor you call:
 *
 * ```ts
 * const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
 * const openai = optimaizr.wrap(new OpenAI(), { service: "checkout-api" });
 * ```
 *
 * Every call keeps its normal signature and return value. The wrapper measures
 * latency, records token usage and cost, and fingerprints the cacheable prefix.
 * Both clients write to the same ledger in the same shape, which is what makes
 * the resulting spend directly comparable.
 *
 * Design rule: **the recorder must never break the caller.** Every hook is
 * wrapped in try/catch, recording is asynchronous and best-effort, and any
 * failure inside optimAIzr is swallowed rather than propagated.
 *
 * The one change it makes to a request is a model override the user accepted
 * in `optimaizr live` (see overrides.ts), and that obeys the same rule: if the
 * provider rejects the new model, the original request is sent instead.
 */

export interface WrapOptions {
  /** Label for this application or service. Defaults to the process name. */
  service?: string;
  /** Default route label for calls that don't set one. */
  route?: string;
  /** Set false to disable recording without removing the wrapper. */
  enabled?: boolean;
  /** Called for every recorded event, in addition to the local ledger. */
  onEvent?: (event: CallEvent) => void;
  /**
   * Opt-in prompt capture, needed by `optimaizr verify` to replay your traffic.
   * Samples a fraction of calls, redacts before writing, never leaves the
   * machine. `capture: { rate: 0.02 }` records one call in fifty.
   */
  capture?: CaptureOptions;
  /**
   * Apply model overrides accepted in `optimaizr live`. On by default: an
   * override only exists because someone pressed Y. Set false, or
   * OPTIMAIZR_OVERRIDES=0, to send every request exactly as written.
   */
  overrides?: boolean;
}

const routeStore = new AsyncLocalStorage<string>();

/** Tag every call made inside `fn` with a route label. */
export function withRoute<T>(route: string, fn: () => T): T {
  return routeStore.run(route, fn);
}

const projectOf = (opts: WrapOptions) => opts.service ?? process.env.OPTIMAIZR_SERVICE ?? "app";
const routeOf = (opts: WrapOptions) => routeStore.getStore() ?? opts.route;

// The overrides file is checked before every request, so a change accepted in
// `live` reaches the next call. A stat is cheap next to a model call, and the
// file is only re-read when it changes.
let overrideCache: { stamp: string; list: ModelOverride[] } = { stamp: "", list: [] };

function currentOverrides(): ModelOverride[] {
  const file = overridesPath();
  let stamp: string;
  try {
    const st = fs.statSync(file);
    stamp = `${file}:${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    overrideCache = { stamp: "", list: [] };
    return overrideCache.list;
  }
  if (stamp !== overrideCache.stamp) overrideCache = { stamp, list: readOverrides(file) };
  return overrideCache.list;
}

/** Overrides the provider refused in this process. Never tried twice. */
const refused = new Set<string>();
const keyOf = (o: ModelOverride) =>
  `${o.project}\u0000${o.route ?? ""}\u0000${o.from}\u0000${o.to}`;

function overrideForCall(params: any, opts: WrapOptions): ModelOverride | undefined {
  if (opts.overrides === false || process.env.OPTIMAIZR_OVERRIDES === "0") return undefined;
  if (!params || typeof params !== "object" || typeof params.model !== "string") return undefined;
  try {
    const o = overrideFor(currentOverrides(), {
      project: projectOf(opts),
      route: routeOf(opts),
      model: params.model,
    });
    return o && !refused.has(keyOf(o)) ? o : undefined;
  } catch {
    return undefined;
  }
}

/** A model the provider does not know, or a parameter it does not support on it. */
function isRejection(err: any): boolean {
  const status = err?.status ?? err?.statusCode;
  return status === 400 || status === 404;
}

/**
 * Send with the accepted override, if any, and return the params that went
 * out so the ledger records the model actually billed. Never mutates the
 * caller's params.
 */
async function send(
  call: (params: any) => Promise<any>,
  params: any,
  opts: WrapOptions,
): Promise<{ result: any; sent: any }> {
  const o = overrideForCall(params, opts);
  if (!o) return { result: await call(params), sent: params };
  const sent = { ...params, model: o.to };
  try {
    return { result: await call(sent), sent };
  } catch (err) {
    if (!isRejection(err)) throw err;
    // The original is what the caller asked for, so it is always safe to send.
    // Only blame the override if the original then goes through.
    const result = await call(params);
    refused.add(keyOf(o));
    return { result, sent: params };
  }
}

function buildEvent(
  shape: Shape,
  params: any,
  result: any,
  latencyMs: number,
  opts: WrapOptions,
  isBatch: boolean,
): CallEvent | null {
  const model = shape.modelOf(params, result);
  if (!model) return null;

  const usage = shape.usageOf(result);
  const n = normalizeUsage(usage, model);
  const request = shape.requestOf(params);
  const speed = shape.speedOf(params, result);

  return {
    id: shape.idOf(result) ?? crypto.randomUUID(),
    source: "sdk",
    ts: new Date(Date.now() - latencyMs).toISOString(),
    model,
    provider: providerOf(model),
    sessionId: routeOf(opts) ?? "default",
    project: projectOf(opts),
    route: routeOf(opts),
    inputTokens: n.inputTokens,
    outputTokens: n.outputTokens,
    thinkingTokens: n.thinkingTokens,
    cacheReadTokens: n.cacheReadTokens,
    cacheWrite5mTokens: n.cacheWrite5mTokens,
    cacheWrite1hTokens: n.cacheWrite1hTokens,
    webSearches: n.webSearches,
    latencyMs,
    stopReason: shape.stopOf(result),
    effort: shape.effortOf(params),
    speed,
    serviceTier: shape.tierOf(params, result),
    batch: isBatch,
    tools: shape.toolsOf(result),
    systemChars: request.systemChars,
    toolDefCount: request.toolDefCount,
    prefixHash: request.prefixHash,
    cost: costOf(usage, model, { at: new Date(), speed, batch: isBatch }),
  };
}

function emit(event: CallEvent | null, opts: WrapOptions): void {
  if (!event) return;
  try {
    append(event);
    opts.onEvent?.(event);
  } catch {
    /* never break the caller */
  }
}

/**
 * Instrument a `create`-style endpoint: Anthropic `messages`, OpenAI
 * `chat.completions` and `responses`.
 */
function instrument(
  surface: any,
  shape: Shape,
  opts: WrapOptions,
  isBatch: boolean,
  methods: string[],
): any {
  return new Proxy(surface, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (typeof prop === "string" && methods.includes(prop) && typeof value === "function") {
        return async function (original: any, ...rest: any[]) {
          const started = Date.now();
          const { result, sent: params } = await send(
            (p) => value.call(target, p, ...rest),
            original,
            opts,
          );

          // Streaming: wrap only the async iterator so the object keeps its
          // other methods. Detected by the return value, not `params.stream`,
          // because Gemini streams from a separate method with no such flag.
          if (result?.[Symbol.asyncIterator]) {
            const acc = shape.accumulator();
            return new Proxy(result, {
              get(t: any, p, r) {
                if (p === Symbol.asyncIterator) {
                  return function () {
                    const inner = t[Symbol.asyncIterator]();
                    return {
                      async next(...a: any[]) {
                        const step = await inner.next(...a);
                        if (!step.done) acc.observe(step.value);
                        else
                          emit(
                            buildEvent(
                              shape,
                              params,
                              acc.message,
                              Date.now() - started,
                              opts,
                              isBatch,
                            ),
                            opts,
                          );
                        return step;
                      },
                      async return(v: any) {
                        return inner.return ? inner.return(v) : { done: true, value: v };
                      },
                      [Symbol.asyncIterator]() {
                        return this;
                      },
                    };
                  };
                }
                return Reflect.get(t, p, r);
              },
            });
          }

          emit(buildEvent(shape, params, result, Date.now() - started, opts, isBatch), opts);
          if (opts.capture) {
            maybeCapture(params, result, opts.capture, routeStore.getStore() ?? opts.route, shape);
          }
          return result;
        };
      }

      // `.stream()` returns a helper whose `finalMessage()` (OpenAI:
      // `finalChatCompletion()`) resolves to the full response, so record there.
      // Overrides aren't applied: the helper returns before the request is
      // answered, so a rejected model couldn't be retried transparently.
      if (prop === "stream" && typeof value === "function") {
        return function (params: any, ...rest: any[]) {
          const started = Date.now();
          const stream = value.call(target, params, ...rest);
          try {
            for (const method of ["finalMessage", "finalChatCompletion", "finalResponse"]) {
              if (typeof stream?.[method] !== "function") continue;
              const original = stream[method].bind(stream);
              let recorded = false;
              stream[method] = async (...a: any[]) => {
                const msg = await original(...a);
                if (!recorded) {
                  recorded = true;
                  emit(buildEvent(shape, params, msg, Date.now() - started, opts, isBatch), opts);
                }
                return msg;
              };
              break;
            }
          } catch {
            /* leave the stream untouched if it isn't shaped as expected */
          }
          return stream;
        };
      }

      if (prop === "parse" && typeof value === "function") {
        return async function (original: any, ...rest: any[]) {
          const started = Date.now();
          const { result, sent: params } = await send(
            (p) => value.call(target, p, ...rest),
            original,
            opts,
          );
          emit(buildEvent(shape, params, result, Date.now() - started, opts, isBatch), opts);
          return result;
        };
      }

      return value;
    },
  });
}

/**
 * The endpoints worth instrumenting, the shape each speaks, and the methods
 * that send a request (`create` for Anthropic and OpenAI, `generateContent`
 * and `generateContentStream` for Google).
 */
const DEFAULT_METHODS = ["create"];

const SURFACES: Array<{
  path: string[];
  shape: Shape;
  methods?: string[];
  /** Gate, for a surface whose provider is not enabled by default. */
  enabled?: () => boolean;
}> = [
  { path: ["messages"], shape: anthropicMessages },
  { path: ["beta", "messages"], shape: anthropicMessages },
  { path: ["chat", "completions"], shape: openaiChat },
  { path: ["beta", "chat", "completions"], shape: openaiChat },
  { path: ["responses"], shape: openaiResponses },
  {
    path: ["models"],
    shape: googleGenerateContent,
    methods: ["generateContent", "generateContentStream"],
    // Gemini is off by default. Asking the catalogue makes `enableGemini()` the
    // single switch: without its models a Google client is left alone.
    enabled: () => priceFor("gemini-2.5-flash") !== null,
  },
];

/**
 * Wrap the object at `path` and nothing else. Proxies only properties that lead
 * to an instrumented surface, so an unknown client behaves exactly as before.
 */
function instrumentPath(
  node: any,
  path: string[],
  shape: Shape,
  opts: WrapOptions,
  methods: string[],
): any {
  if (path.length === 0) return instrument(node, shape, opts, false, methods);
  const [head, ...tail] = path;
  return new Proxy(node, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === head && value && typeof value === "object") {
        return instrumentPath(value, tail, shape, opts, methods);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Wrap an Anthropic or OpenAI client. Returns the same client, instrumented.
 * If anything about the client is unexpected, the original is returned
 * unchanged rather than throwing.
 */
export function wrap<T extends object>(client: T, options: WrapOptions = {}): T {
  const opts: WrapOptions = { enabled: true, ...options };
  if (opts.enabled === false || process.env.OPTIMAIZR_DISABLED === "1") return client;

  try {
    // One proxy over the client, dispatching each top-level property to the
    // surface that owns it. `beta` leads to two vendors' surfaces, so the
    // branch it takes is decided by what the client actually exposes.
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (!value || typeof value !== "object") {
          return typeof value === "function" ? value.bind(target) : value;
        }

        for (const { path, shape, methods = DEFAULT_METHODS, enabled } of SURFACES) {
          if (path[0] !== prop) continue;
          if (enabled && !enabled()) continue;
          const rest = path.slice(1);
          // Only claim this property if the surface it names is really there.
          let node: any = value;
          for (const step of rest) {
            node = node?.[step];
            if (!node || typeof node !== "object") break;
          }
          if (!node || typeof node !== "object") continue;
          const sends = methods.some((m) => typeof node[m] === "function");
          if (!sends && typeof node.stream !== "function") continue;
          return instrumentPath(value, rest, shape, opts, methods);
        }

        return value;
      },
    });
  } catch {
    return client;
  }
}

/**
 * Record a call made outside a supported SDK (another language, raw HTTP, a
 * gateway). `usage` is accepted in any vendor's shape.
 */
export function record(input: {
  model: string;
  usage: any;
  latencyMs?: number;
  route?: string;
  service?: string;
  sessionId?: string;
}): void {
  try {
    const n = normalizeUsage(input.usage, input.model);
    const event: CallEvent = {
      id: crypto.randomUUID(),
      source: "sdk",
      ts: new Date().toISOString(),
      model: input.model,
      provider: providerOf(input.model),
      sessionId: input.sessionId ?? input.route ?? "default",
      project: input.service ?? process.env.OPTIMAIZR_SERVICE ?? "app",
      route: input.route,
      inputTokens: n.inputTokens,
      outputTokens: n.outputTokens,
      thinkingTokens: n.thinkingTokens,
      cacheReadTokens: n.cacheReadTokens,
      cacheWrite5mTokens: n.cacheWrite5mTokens,
      cacheWrite1hTokens: n.cacheWrite1hTokens,
      webSearches: n.webSearches,
      latencyMs: input.latencyMs,
      tools: [],
      cost: costOf(input.usage, input.model),
    };
    append(event);
  } catch {
    /* best effort */
  }
}
