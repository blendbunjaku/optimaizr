import { priceFor, providerOf } from "../pricing.js";

/**
 * Which API dialect a recorded request is written in. Replay puts a request
 * back on the wire the way the app sent it, so everything that differs by
 * vendor (method, output-limit field, where effort lives) is decided here.
 */
export type Dialect =
  "anthropic-messages" | "openai-chat" | "openai-responses" | "google-generate-content";

/**
 * The dialect of a recorded request, decided by the model's provider: Anthropic
 * and OpenAI Chat Completions both take `messages`, so the body can't tell.
 */
export function dialectOf(request: Record<string, any> | null | undefined): Dialect {
  const provider = providerOf(request?.model);
  // Explicit, so an unknown provider (Gemini, say) isn't replayed against the
  // Anthropic API by default.
  if (provider === "google") return "google-generate-content";
  if (provider !== "openai") return "anthropic-messages";
  const openaiResponses = request?.input !== undefined || request?.instructions !== undefined;
  return openaiResponses ? "openai-responses" : "openai-chat";
}

export function providerOfDialect(dialect: Dialect): string {
  switch (dialect) {
    case "anthropic-messages":
      return "anthropic";
    case "google-generate-content":
      return "google";
    default:
      return "openai";
  }
}

/** The field each dialect caps output tokens with. */
export function outputLimitField(dialect: Dialect): string {
  switch (dialect) {
    case "anthropic-messages":
      return "max_tokens";
    case "openai-chat":
      return "max_completion_tokens";
    case "openai-responses":
      return "max_output_tokens";
    // Gemini nests this under `config`; `setOutputLimit` handles the nesting.
    case "google-generate-content":
      return "maxOutputTokens";
  }
}

/** Read the request's output ceiling, whatever this dialect calls it. */
export function outputLimitOf(request: Record<string, any>): number | undefined {
  const value =
    request.max_tokens ??
    request.max_completion_tokens ??
    request.max_output_tokens ??
    request.config?.maxOutputTokens ??
    undefined;
  return typeof value === "number" ? value : undefined;
}

/**
 * Cap a request's output at the target model's ceiling, in this dialect's
 * field. Asking for more than a model can produce is an error.
 */
export function setOutputLimit(
  request: Record<string, any>,
  dialect: Dialect,
  limit: number,
): void {
  const model = priceFor(request.model);
  const capped = model ? Math.min(limit, model.maxOutputTokens) : limit;
  // Drop the other dialects' spellings so a swapped request carries exactly one.
  delete request.max_tokens;
  delete request.max_completion_tokens;
  delete request.max_output_tokens;
  if (request.config && typeof request.config === "object") {
    delete request.config.maxOutputTokens;
  }

  if (dialect === "google-generate-content") {
    // Gemini takes generation settings under `config`, not at the top level.
    request.config = { ...(request.config ?? {}), maxOutputTokens: capped };
    return;
  }
  request[outputLimitField(dialect)] = capped;
}

/** Send a request on the client that speaks its dialect. */
export function sendChat(
  client: any,
  request: Record<string, any>,
  dialect: Dialect = dialectOf(request),
): Promise<any> {
  switch (dialect) {
    case "anthropic-messages":
      return client.messages.create(request);
    case "openai-chat":
      return client.chat.completions.create(request);
    case "openai-responses":
      return client.responses.create(request);
    case "google-generate-content":
      return client.models.generateContent(request);
  }
}
