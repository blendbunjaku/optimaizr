import crypto from "node:crypto";

import type { ToolCall } from "@optimaizr/core";

/**
 * How each vendor's SDK shapes a request and a response. `wrap()` needs the
 * same few facts from every call (model, usage, stop reason, tools, cacheable
 * prefix), and each vendor puts them somewhere else. Adding a vendor means
 * adding a `Shape`, not editing the proxy.
 */

/** The part of a request that prompt caching keys on. */
export interface RequestShape {
  systemChars: number;
  toolDefCount: number;
  prefixHash: string;
}

/** Accumulates a streamed response into something `Shape` can read. */
export interface StreamAccumulator {
  message: any;
  observe(chunk: any): void;
}

export interface Shape {
  /** Which SDK surface this describes, for diagnostics. */
  name: string;
  idOf(result: any): string | undefined;
  modelOf(params: any, result: any): string;
  usageOf(result: any): any;
  stopOf(result: any): string | null;
  toolsOf(result: any): ToolCall[];
  requestOf(params: any): RequestShape;
  /**
   * The part of a response worth keeping as a verification baseline: the
   * answer and its tool calls, not the envelope.
   */
  answerOf(result: any): unknown;
  /**
   * The request fields capture is allowed to store, as an allowlist. Capture
   * writes prompts to disk, so a field that is not named here is not kept,
   * and a new SDK parameter cannot leak in by default.
   */
  captureFieldsOf(params: any): Record<string, unknown>;
  effortOf(params: any): string | null;
  speedOf(params: any, result: any): string | null;
  tierOf(params: any, result: any): string | null;
  accumulator(): StreamAccumulator;
}

function hash(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function fingerprint(systemText: string, toolSig: string, toolCount: number): RequestShape {
  return {
    systemChars: systemText.length,
    toolDefCount: toolCount,
    prefixHash: hash(`${toolSig} ${systemText}`),
  };
}

/** Text out of a string, or out of an array of content blocks. */
function textOf(value: any): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("");
}

/* ------------------------------------------------------------------ *
 * Anthropic Messages
 * ------------------------------------------------------------------ */

export const anthropicMessages: Shape = {
  name: "anthropic.messages",
  idOf: (r) => r?.id,
  modelOf: (p, r) => r?.model ?? p?.model ?? "",
  usageOf: (r) => r?.usage,
  stopOf: (r) => r?.stop_reason ?? null,
  toolsOf(result) {
    const content = result?.content;
    if (!Array.isArray(content)) return [];
    const out: ToolCall[] = [];
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      out.push({
        id: b.id ?? `${out.length}`,
        name: b.name ?? "unknown",
        signature: `${b.name ?? "unknown"}:${JSON.stringify(b.input ?? {}).slice(0, 200)}`,
      });
    }
    return out;
  },
  requestOf(params) {
    const systemText = textOf(params?.system);
    const tools = Array.isArray(params?.tools) ? params.tools : [];
    const toolSig = tools
      .map((t: any) => `${t?.name ?? t?.type ?? ""}:${JSON.stringify(t?.input_schema ?? "")}`)
      .join("|");
    return fingerprint(systemText, toolSig, tools.length);
  },
  answerOf: (r) => r?.content,
  captureFieldsOf: (p) => ({
    model: p?.model,
    system: p?.system,
    messages: p?.messages,
    tools: p?.tools,
    max_tokens: p?.max_tokens,
    temperature: p?.temperature,
    output_config: p?.output_config,
  }),
  effortOf: (p) => p?.output_config?.effort ?? null,
  speedOf: (p, r) => p?.speed ?? r?.usage?.speed ?? null,
  tierOf: (_p, r) => r?.usage?.service_tier ?? null,
  accumulator() {
    const message: any = { usage: {}, content: [] };
    return {
      message,
      observe(chunk: any) {
        try {
          if (chunk?.type === "message_start" && chunk.message) {
            message.id = chunk.message.id;
            message.model = chunk.message.model;
            Object.assign(message.usage, chunk.message.usage ?? {});
          } else if (chunk?.type === "message_delta") {
            // Final output token count arrives here.
            Object.assign(message.usage, chunk.usage ?? {});
            if (chunk.delta?.stop_reason) message.stop_reason = chunk.delta.stop_reason;
          } else if (chunk?.type === "content_block_start" && chunk.content_block) {
            message.content.push(chunk.content_block);
          }
        } catch {
          /* observation must not disturb the stream */
        }
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * OpenAI Chat Completions
 * ------------------------------------------------------------------ */

/** System-equivalent roles, both of which sit in the cacheable prefix. */
const PREFIX_ROLES = new Set(["system", "developer"]);

export const openaiChat: Shape = {
  name: "openai.chat.completions",
  idOf: (r) => r?.id,
  modelOf: (p, r) => r?.model ?? p?.model ?? "",
  usageOf: (r) => r?.usage,
  stopOf: (r) => r?.choices?.[0]?.finish_reason ?? null,
  toolsOf(result) {
    const calls = result?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls)) return [];
    return calls.map((c: any, i: number) => {
      const name = c?.function?.name ?? c?.name ?? "unknown";
      const args = c?.function?.arguments ?? "";
      return {
        id: c?.id ?? `${i}`,
        name,
        signature: `${name}:${(typeof args === "string" ? args : JSON.stringify(args)).slice(0, 200)}`,
      };
    });
  },
  requestOf(params) {
    const messages = Array.isArray(params?.messages) ? params.messages : [];
    const systemText = messages
      .filter((m: any) => PREFIX_ROLES.has(m?.role))
      .map((m: any) => textOf(m?.content))
      .join("");
    const tools = Array.isArray(params?.tools) ? params.tools : [];
    const toolSig = tools
      .map(
        (t: any) =>
          `${t?.function?.name ?? t?.name ?? t?.type ?? ""}:${JSON.stringify(t?.function?.parameters ?? t?.parameters ?? "")}`,
      )
      .join("|");
    return fingerprint(systemText, toolSig, tools.length);
  },
  answerOf: (r) => r?.choices,
  captureFieldsOf: (p) => ({
    model: p?.model,
    messages: p?.messages,
    tools: p?.tools,
    tool_choice: p?.tool_choice,
    max_completion_tokens: p?.max_completion_tokens,
    max_tokens: p?.max_tokens,
    temperature: p?.temperature,
    reasoning_effort: p?.reasoning_effort,
    response_format: p?.response_format,
  }),
  effortOf: (p) => p?.reasoning_effort ?? null,
  speedOf: () => null,
  tierOf: (p, r) => r?.service_tier ?? p?.service_tier ?? null,
  accumulator() {
    const message: any = { usage: {}, choices: [{ message: { tool_calls: [] } }] };
    return {
      message,
      observe(chunk: any) {
        try {
          if (chunk?.id) message.id = chunk.id;
          if (chunk?.model) message.model = chunk.model;
          // Sent only on the final chunk, and only with
          // stream_options: { include_usage: true }.
          if (chunk?.usage) Object.assign(message.usage, chunk.usage);
          const choice = chunk?.choices?.[0];
          if (choice?.finish_reason) message.choices[0].finish_reason = choice.finish_reason;
          for (const call of choice?.delta?.tool_calls ?? []) {
            const i = call?.index ?? 0;
            const slot = (message.choices[0].message.tool_calls[i] ??= {
              id: call?.id,
              function: { name: "", arguments: "" },
            });
            if (call?.id) slot.id = call.id;
            if (call?.function?.name) slot.function.name += call.function.name;
            if (call?.function?.arguments) slot.function.arguments += call.function.arguments;
          }
        } catch {
          /* observation must not disturb the stream */
        }
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * OpenAI Responses
 * ------------------------------------------------------------------ */

export const openaiResponses: Shape = {
  name: "openai.responses",
  idOf: (r) => r?.id,
  modelOf: (p, r) => r?.model ?? p?.model ?? "",
  usageOf: (r) => r?.usage,
  stopOf: (r) => r?.incomplete_details?.reason ?? r?.status ?? null,
  toolsOf(result) {
    const output = result?.output;
    if (!Array.isArray(output)) return [];
    const out: ToolCall[] = [];
    for (const item of output) {
      if (item?.type !== "function_call") continue;
      const name = item.name ?? "unknown";
      out.push({
        id: item.call_id ?? item.id ?? `${out.length}`,
        name,
        signature: `${name}:${String(item.arguments ?? "").slice(0, 200)}`,
      });
    }
    return out;
  },
  requestOf(params) {
    const systemText = textOf(params?.instructions);
    const tools = Array.isArray(params?.tools) ? params.tools : [];
    const toolSig = tools
      .map((t: any) => `${t?.name ?? t?.type ?? ""}:${JSON.stringify(t?.parameters ?? "")}`)
      .join("|");
    return fingerprint(systemText, toolSig, tools.length);
  },
  answerOf: (r) => r?.output,
  captureFieldsOf: (p) => ({
    model: p?.model,
    instructions: p?.instructions,
    input: p?.input,
    tools: p?.tools,
    tool_choice: p?.tool_choice,
    max_output_tokens: p?.max_output_tokens,
    temperature: p?.temperature,
    reasoning: p?.reasoning,
    text: p?.text,
  }),
  effortOf: (p) => p?.reasoning?.effort ?? null,
  speedOf: () => null,
  tierOf: (p, r) => r?.service_tier ?? p?.service_tier ?? null,
  accumulator() {
    const message: any = { usage: {}, output: [] };
    return {
      message,
      observe(chunk: any) {
        try {
          // The terminal event carries the assembled response, usage included.
          const done = chunk?.response;
          if (
            done &&
            (chunk.type === "response.completed" || chunk.type === "response.incomplete")
          ) {
            message.id = done.id ?? message.id;
            message.model = done.model ?? message.model;
            message.status = done.status ?? message.status;
            message.incomplete_details = done.incomplete_details;
            message.output = Array.isArray(done.output) ? done.output : message.output;
            Object.assign(message.usage, done.usage ?? {});
          } else if (chunk?.type === "response.created" && chunk.response) {
            message.id = chunk.response.id;
            message.model = chunk.response.model;
          }
        } catch {
          /* observation must not disturb the stream */
        }
      },
    };
  },
};

/* ------------------------------------------------------------------ *
 * Google Gemini: models.generateContent
 * ------------------------------------------------------------------ */

/**
 * `@google/genai`'s `ai.models.generateContent(...)`. Unlike the others, the
 * methods are `generateContent` / `generateContentStream`, and the stream
 * method returns an async iterable with no `stream: true` flag. Token
 * semantics are handled in `normalizeUsage`.
 */
export const googleGenerateContent: Shape = {
  name: "google.generateContent",
  idOf: (r) => r?.responseId,
  modelOf: (p, r) => p?.model ?? r?.modelVersion ?? "",
  usageOf: (r) => r?.usageMetadata,
  stopOf: (r) => r?.candidates?.[0]?.finishReason ?? null,
  toolsOf(result) {
    const parts = result?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return [];
    const out: ToolCall[] = [];
    for (const part of parts) {
      const call = part?.functionCall;
      if (!call) continue;
      const name = call.name ?? "unknown";
      out.push({
        id: call.id ?? `${out.length}`,
        name,
        signature: `${name}:${JSON.stringify(call.args ?? {}).slice(0, 200)}`,
      });
    }
    return out;
  },
  requestOf(params) {
    // Gemini puts the system prompt and tool declarations under `config`.
    const cfg = params?.config ?? {};
    const systemText = textOf(cfg.systemInstruction ?? params?.systemInstruction);
    const groups = Array.isArray(cfg.tools) ? cfg.tools : [];
    const declared = groups.flatMap((g: any) =>
      Array.isArray(g?.functionDeclarations) ? g.functionDeclarations : [],
    );
    const toolSig = declared
      .map((t: any) => `${t?.name ?? ""}:${JSON.stringify(t?.parameters ?? "")}`)
      .join("|");
    return fingerprint(systemText, toolSig, declared.length);
  },
  answerOf: (r) => r?.candidates?.[0]?.content,
  captureFieldsOf: (p) => ({
    model: p?.model,
    contents: p?.contents,
    systemInstruction: p?.config?.systemInstruction,
    tools: p?.config?.tools,
    maxOutputTokens: p?.config?.maxOutputTokens,
    temperature: p?.config?.temperature,
    thinkingConfig: p?.config?.thinkingConfig,
  }),
  effortOf: (p) => {
    const budget = p?.config?.thinkingConfig?.thinkingBudget;
    return budget === undefined || budget === null ? null : String(budget);
  },
  speedOf: () => null,
  tierOf: () => null,
  accumulator() {
    const message: any = { usageMetadata: {}, candidates: [{ content: { parts: [] } }] };
    return {
      message,
      observe(chunk: any) {
        try {
          if (chunk?.responseId) message.responseId = chunk.responseId;
          if (chunk?.modelVersion) message.modelVersion = chunk.modelVersion;
          // Every chunk carries a running usageMetadata; the last one is final.
          if (chunk?.usageMetadata) Object.assign(message.usageMetadata, chunk.usageMetadata);
          const candidate = chunk?.candidates?.[0];
          if (candidate?.finishReason) message.candidates[0].finishReason = candidate.finishReason;
          const parts = candidate?.content?.parts;
          if (Array.isArray(parts)) message.candidates[0].content.parts.push(...parts);
        } catch {
          /* observation must not disturb the stream */
        }
      },
    };
  },
};
