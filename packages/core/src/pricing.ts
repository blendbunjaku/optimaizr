/**
 * Model catalogue and cost maths. Prices live only here, and they're dated: a
 * call is costed at the rate card in force on its day, so a later price change
 * doesn't rewrite history. Users can add or override models in
 * `~/.optimaizr/models.json` or the `models` key of `optimaizr.config.json`.
 */

export type Tier = "frontier" | "balanced" | "fast";

export type Capability =
  "tools" | "vision" | "reasoning" | "batch" | "caching" | "structured-output";

/** A price that was in effect over a date range. */
export interface RateCard {
  /** Inclusive ISO date this rate took effect. */
  from: string;
  /** Inclusive ISO date it stopped applying. Absent means "still current". */
  until?: string;
  inputPerM: number;
  outputPerM: number;
  /**
   * Explicit cached-input rate. When absent, the provider's cache-read
   * multiplier is applied to `inputPerM`.
   */
  cachedInputPerM?: number;
  /**
   * Explicit cache-write rate for every TTL. When absent, the provider's write
   * multipliers apply. (OpenAI writes are free before GPT-5.6 and 1.25x input
   * from it, which is per model, so it lives here.)
   */
  cacheWritePerM?: number;
  /**
   * Rates that replace the ones above once a call's prompt passes
   * `aboveTokens`. Gemini Pro roughly doubles past its long-context threshold.
   */
  longContext?: {
    aboveTokens: number;
    inputPerM: number;
    outputPerM: number;
    cachedInputPerM?: number;
    cacheWritePerM?: number;
  };
  /**
   * A discount outside peak hours, on weekdays by UTC clock; weekends count as
   * off-peak. The rates above are the peak ones. DeepSeek halves off-peak.
   */
  offPeak?: { factor: number; peakUtc: Array<[number, number]> };
  /** Why this card exists, e.g. "introductory pricing". */
  label?: string;
}

export interface ModelPrice {
  id: string;
  label: string;
  provider: string;
  tier: Tier;
  /** Chronological rate cards. The last card with no `until` is current. */
  rates: RateCard[];
  contextTokens: number;
  maxOutputTokens: number;
  capabilities: Capability[];
  /** Fast-mode premium pricing, where the model supports `speed: "fast"`. */
  fast?: { inputPerM: number; outputPerM: number };
  /** Short note used by `optimaizr guide` when recommending a route. */
  bestFor: string;
  /** False prices a model without proposing switches to it, e.g. one too new to vouch for. */
  switchTarget?: false;
  /** False leaves it out of `optimaizr guide`: priced so its calls count, not recommended. */
  listed?: false;
}

/**
 * How each provider prices cache traffic, as multipliers on the input rate.
 * A model may override any of these with an explicit rate.
 */
export interface ProviderCachePolicy {
  read: number;
  write5m: number;
  write1h: number;
  /** Discount applied to asynchronous batch traffic. */
  batch: number;
  /**
   * True when the reported input count already includes cache reads (OpenAI's
   * `prompt_tokens` does, Anthropic's `input_tokens` doesn't). `normalizeUsage`
   * subtracts them so "input" means the same thing for every vendor.
   */
  inputIncludesCacheReads?: boolean;
}

/**
 * Server-side tools billed per request, which no token count includes. Only
 * tools with a published per-request price: web fetch is free, and code
 * execution bills by container-hour, which transcripts don't record.
 */
export interface ServerToolPrices {
  /** USD per 1,000 web searches. */
  webSearchPer1k: number;
}

export const SERVER_TOOLS: Record<string, ServerToolPrices> = {
  anthropic: { webSearchPer1k: 10 },
};

export const PROVIDERS: Record<string, ProviderCachePolicy> = {
  anthropic: { read: 0.1, write5m: 1.25, write1h: 2.0, batch: 0.5 },
  // OpenAI caches automatically and bills nothing to write, so a write is just
  // input. Older models discount reads by less than 10x and set `cachedInputPerM`.
  openai: { read: 0.1, write5m: 1.0, write1h: 1.0, batch: 0.5, inputIncludesCacheReads: true },
  // Google's `promptTokenCount` includes cached tokens, like OpenAI's. Explicit
  // caching also bills storage per token-hour, which isn't tied to a request
  // and isn't counted; implicit caching (what agents hit) is modelled exactly.
  google: { read: 0.25, write5m: 1.0, write1h: 1.0, batch: 0.5, inputIncludesCacheReads: true },
  // The providers below set an explicit cached rate on every card. DeepSeek and
  // Z.ai bill nothing extra to write, Kimi bills a 1h write at twice input.
  deepseek: { read: 0.02, write5m: 1.0, write1h: 1.0, batch: 1 },
  zai: { read: 0.2, write5m: 1.0, write1h: 1.0, batch: 1 },
  moonshot: { read: 0.1, write5m: 1.0, write1h: 2.0, batch: 1 },
  minimax: { read: 0.2, write5m: 1.25, write1h: 1.25, batch: 1 },
};

/** Anthropic's cache multipliers, kept as a named export for readability. */
export const CACHE_MULTIPLIER = PROVIDERS.anthropic!;
export const BATCH_MULTIPLIER = PROVIDERS.anthropic!.batch;

const anthropicCaps: Capability[] = ["tools", "vision", "batch", "caching", "structured-output"];
const openaiCaps: Capability[] = ["tools", "vision", "batch", "caching", "structured-output"];
const googleCaps: Capability[] = ["tools", "vision", "batch", "caching", "structured-output"];
const openCaps: Capability[] = ["tools", "caching", "reasoning"];

/** A card whose rate changes above a prompt-size threshold. */
function tiered(
  inputPerM: number,
  outputPerM: number,
  aboveTokens: number,
  longInputPerM: number,
  longOutputPerM: number,
  from = "2026-01-01",
): RateCard[] {
  return [
    {
      from,
      inputPerM,
      outputPerM,
      longContext: { aboveTokens, inputPerM: longInputPerM, outputPerM: longOutputPerM },
    },
  ];
}

function flat(inputPerM: number, outputPerM: number, from = "2026-01-01"): RateCard[] {
  return [{ from, inputPerM, outputPerM }];
}

/** A rate card whose cached-input price is not the provider's default multiple. */
function withCache(
  inputPerM: number,
  outputPerM: number,
  cachedInputPerM: number,
  from: string,
): RateCard[] {
  return [{ from, inputPerM, outputPerM, cachedInputPerM }];
}

/**
 * An OpenAI card from GPT-5.4 on. `writes`: GPT-5.6+ bills cache writes at
 * 1.25x input. `long`: past 272K input tokens the whole request bills at 2x
 * input and cache, 1.5x output. No cached rate means no prompt caching.
 */
function gpt(
  inputPerM: number,
  cachedInputPerM: number | undefined,
  outputPerM: number,
  from: string,
  opts: { writes?: boolean; long?: boolean } = {},
): RateCard[] {
  const cacheWritePerM = opts.writes ? inputPerM * 1.25 : undefined;
  const card: RateCard = { from, inputPerM, outputPerM, cachedInputPerM, cacheWritePerM };
  if (opts.long) {
    card.longContext = {
      aboveTokens: 272_000,
      inputPerM: inputPerM * 2,
      outputPerM: outputPerM * 1.5,
      cachedInputPerM: cachedInputPerM === undefined ? undefined : cachedInputPerM * 2,
      cacheWritePerM: cacheWritePerM === undefined ? undefined : cacheWritePerM * 2,
    };
  }
  return [card];
}

/**
 * A card for a model optimAIzr prices but doesn't recommend: it costs the calls
 * people make on it (mostly through opencode) and stays out of guide and switches.
 */
function openModel(
  id: string,
  label: string,
  provider: string,
  tier: Tier,
  card: Omit<RateCard, "from">,
  contextTokens: number,
  maxOutputTokens: number,
): ModelPrice {
  return {
    id,
    label,
    provider,
    tier,
    rates: [{ from: "2026-01-01", ...card }],
    contextTokens,
    maxOutputTokens,
    capabilities: openCaps,
    bestFor: "Priced so its calls count. Not compared or recommended here.",
    switchTarget: false,
    listed: false,
  };
}

// The models' own price lists, read 2026-10-19: api-docs.deepseek.com,
// docs.z.ai, platform.kimi.ai and platform.minimax.io. All in USD per million.
const DEEPSEEK_PEAK: Array<[number, number]> = [
  [1, 4],
  [6, 10],
];
const deepseek = (inputPerM: number, cachedInputPerM: number, outputPerM: number) => ({
  inputPerM,
  outputPerM,
  cachedInputPerM,
  offPeak: { factor: 0.5, peakUtc: DEEPSEEK_PEAK },
});
const glm = (inputPerM: number, cachedInputPerM: number, outputPerM: number) => ({
  inputPerM,
  outputPerM,
  cachedInputPerM,
});
const M1 = 1_048_576;
const K200 = 202_752;

export const OPEN_MODELS: ModelPrice[] = [
  // DeepSeek bills half from 10:00 to 01:00 UTC and on weekends.
  openModel(
    "deepseek-v4-pro",
    "DeepSeek V4 Pro",
    "deepseek",
    "frontier",
    deepseek(1.32, 0.044, 3.96),
    M1,
    384_000,
  ),
  openModel(
    "deepseek-flash",
    "DeepSeek Flash",
    "deepseek",
    "fast",
    deepseek(0.3, 0.006, 1.2),
    M1,
    384_000,
  ),
  // The old Flash ids bill at the new Flash price.
  openModel(
    "deepseek-v4-flash",
    "DeepSeek V4 Flash",
    "deepseek",
    "fast",
    deepseek(0.3, 0.006, 1.2),
    M1,
    384_000,
  ),

  openModel("glm-5.3-flashx", "GLM-5.3 FlashX", "zai", "fast", glm(0.37, 0.075, 1.25), M1, 131_072),
  openModel("glm-5.3-flash", "GLM-5.3 Flash", "zai", "fast", glm(0.15, 0.03, 0.5), M1, 131_072),
  openModel("glm-5.3", "GLM-5.3", "zai", "frontier", glm(1.4, 0.26, 4.4), M1, 131_072),
  openModel("glm-5.2", "GLM-5.2", "zai", "frontier", glm(1.4, 0.26, 4.4), M1, 32_768),
  openModel("glm-5.1", "GLM-5.1", "zai", "frontier", glm(1.4, 0.26, 4.4), K200, 16_384),
  openModel("glm-5", "GLM-5", "zai", "frontier", glm(1, 0.2, 3.2), K200, 16_384),
  // Z.ai's free models get a $0 card, so they don't prefix-match a paid one.
  openModel("glm-4.7-flashx", "GLM-4.7 FlashX", "zai", "fast", glm(0.07, 0.01, 0.4), K200, 16_384),
  openModel("glm-4.7-flash", "GLM-4.7 Flash", "zai", "fast", glm(0, 0, 0), K200, 16_384),
  openModel("glm-4.7", "GLM-4.7", "zai", "balanced", glm(0.6, 0.11, 2.2), K200, 16_384),
  openModel("glm-4.6", "GLM-4.6", "zai", "balanced", glm(0.6, 0.11, 2.2), K200, 131_072),
  openModel("glm-4.5-airx", "GLM-4.5 AirX", "zai", "fast", glm(1.1, 0.22, 4.5), 131_072, 98_304),
  openModel("glm-4.5-air", "GLM-4.5 Air", "zai", "fast", glm(0.2, 0.03, 1.1), 131_072, 98_304),
  openModel("glm-4.5-flash", "GLM-4.5 Flash", "zai", "fast", glm(0, 0, 0), 131_072, 98_304),
  openModel("glm-4.5-x", "GLM-4.5 X", "zai", "balanced", glm(2.2, 0.45, 8.9), 131_072, 98_304),
  openModel("glm-4.5", "GLM-4.5", "zai", "balanced", glm(0.6, 0.11, 2.2), 131_072, 98_304),

  // Kimi lists a cache hit and a cache miss; a miss is the input rate.
  openModel("kimi-k3", "Kimi K3", "moonshot", "frontier", glm(3, 0.3, 15), M1, 131_072),
  openModel(
    "kimi-k2.7-code-highspeed",
    "Kimi K2.7 Code Highspeed",
    "moonshot",
    "balanced",
    glm(1.9, 0.38, 8),
    262_144,
    131_072,
  ),
  openModel(
    "kimi-k2.7-code",
    "Kimi K2.7 Code",
    "moonshot",
    "balanced",
    glm(0.95, 0.19, 4),
    262_144,
    131_072,
  ),
  openModel("kimi-k2.6", "Kimi K2.6", "moonshot", "balanced", glm(0.95, 0.16, 4), 262_144, 131_072),

  // MiniMax-M3 doubles past 512K input. Its write rate isn't listed, so M2.7's
  // is used, doubled past 512K like the rest.
  openModel(
    "minimax-m3",
    "MiniMax-M3",
    "minimax",
    "balanced",
    {
      ...glm(0.3, 0.06, 1.2),
      cacheWritePerM: 0.375,
      longContext: {
        aboveTokens: 524_288,
        inputPerM: 0.6,
        outputPerM: 2.4,
        cachedInputPerM: 0.12,
        cacheWritePerM: 0.75,
      },
    },
    M1,
    131_072,
  ),
  openModel(
    "minimax-m2.7-highspeed",
    "MiniMax-M2.7 Highspeed",
    "minimax",
    "balanced",
    { ...glm(0.6, 0.06, 2.4), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.7",
    "MiniMax-M2.7",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.06, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.5-highspeed",
    "MiniMax-M2.5 Highspeed",
    "minimax",
    "balanced",
    { ...glm(0.6, 0.03, 2.4), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.5",
    "MiniMax-M2.5",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.03, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.1-highspeed",
    "MiniMax-M2.1 Highspeed",
    "minimax",
    "balanced",
    { ...glm(0.6, 0.03, 2.4), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.1",
    "MiniMax-M2.1",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.03, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2",
    "MiniMax-M2",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.03, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
];

export const BUILTIN_MODELS: ModelPrice[] = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    provider: "anthropic",
    tier: "frontier",
    // Cache reads are $0.25/M, not a tenth of input. Agent traffic is mostly
    // cache reads, so the default would overbill Fable 5.1 by up to 4x.
    rates: withCache(10, 50, 0.25, "2026-09-22"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Hardest reasoning and long-horizon agentic runs. Thinking is always on.",
  },
  {
    id: "claude-mythos-5-1",
    label: "Mythos 5.1",
    provider: "anthropic",
    tier: "frontier",
    // Mythos 5.1's cache-read rate wasn't published at launch; Fable 5.1's is
    // assumed. If it's the default $1.00 instead, this understates.
    rates: withCache(10, 50, 0.25, "2026-09-22"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Same capability as Fable 5.1, for approved organisations.",
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(10, 50, "2026-06-24"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous Fable generation, at the same price as Fable 5.1.",
  },
  {
    id: "claude-mythos-5",
    label: "Mythos 5",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(10, 50, "2026-06-24"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Same capability as Fable 5, for approved organisations.",
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    provider: "anthropic",
    tier: "frontier",
    // Cache reads are $0.20/M: a twentieth of input, not a tenth.
    rates: withCache(4, 20, 0.2, "2026-09-22"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    fast: { inputPerM: 8, outputPerM: 40 },
    bestFor:
      "Complex multi-step work, refactors, architecture, judging other models. Thinking is always on.",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25, "2026-06-24"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    fast: { inputPerM: 10, outputPerM: 50 },
    bestFor: "Previous Opus generation; Opus 5.5 does the same work for 20% less.",
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous frontier generation; still strong on agentic coding.",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Older frontier generation.",
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Older frontier generation.",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    provider: "anthropic",
    tier: "balanced",
    rates: flat(2, 10, "2026-09-25"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "The default workhorse: most coding, editing and tool-driven turns.",
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    provider: "anthropic",
    tier: "balanced",
    // $2/$10 was announced as introductory with a rise to $3/$15 on 2026-09-01,
    // which Anthropic cancelled. One card, not two (see pricing.test.mjs).
    rates: flat(2, 10, "2026-02-05"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous Sonnet generation, at the same price as Sonnet 5.5.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    provider: "anthropic",
    tier: "balanced",
    rates: flat(3, 15),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous balanced generation.",
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    provider: "anthropic",
    tier: "fast",
    // Every rate is 5x once the prompt, cache reads and writes included, is over 100K.
    rates: tiered(0.1, 0.5, 100_000, 0.5, 2.5, "2026-10-07"),
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor:
      "Sub-agents and short, well-specified turns. A tenth of Haiku 4.5 under 100K of prompt, 5x that past it.",
    switchTarget: false,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    provider: "anthropic",
    tier: "fast",
    rates: flat(1, 5, "2025-10-01"),
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    capabilities: anthropicCaps,
    bestFor:
      "Mechanical, well-specified work: classification, extraction, formatting, log triage, cheap sub-agents.",
  },

  /* ---------------------------------------------------------------- OpenAI */

  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    tier: "frontier",
    rates: gpt(10, 1, 50, "2026-03-05", { writes: true, long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "OpenAI's flagship: hardest reasoning, long agentic runs, judging other models.",
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    provider: "openai",
    tier: "balanced",
    rates: gpt(2, 0.2, 10, "2026-03-05", { writes: true, long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "The GPT-6 workhorse: complex coding and agentic workflows.",
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    tier: "fast",
    rates: gpt(0.1, 0.01, 0.5, "2026-03-05", { writes: true, long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Focused, high-volume work: classification, extraction, cheap sub-agents.",
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    tier: "frontier",
    rates: gpt(4, 0.4, 20, "2026-01-01", { writes: true, long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous-generation flagship, below GPT-6 Astra's price.",
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    tier: "balanced",
    rates: gpt(2, 0.2, 12, "2026-01-01", { writes: true, long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous-generation workhorse, superseded by GPT-6 Sol at a lower output rate.",
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    tier: "fast",
    rates: gpt(0.2, 0.02, 1.2, "2026-01-01", { writes: true, long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous-generation cheap tier, superseded by GPT-6 Luna.",
  },
  {
    id: "gpt-5.5-pro",
    label: "GPT-5.5 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(30, undefined, 180, "2026-04-23", { long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Maximum-effort answers where cost is secondary. No prompt caching.",
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    tier: "frontier",
    rates: gpt(5, 0.5, 30, "2026-04-23", { long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous frontier generation.",
  },
  {
    id: "gpt-5.4-pro",
    label: "GPT-5.4 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(30, undefined, 180, "2026-03-05", { long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older maximum-effort tier. No prompt caching.",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    provider: "openai",
    tier: "balanced",
    rates: gpt(0.75, 0.075, 4.5, "2026-03-05"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older mid tier.",
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    provider: "openai",
    tier: "fast",
    rates: gpt(0.2, 0.02, 1.25, "2026-03-05"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older cheap tier.",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    tier: "frontier",
    rates: gpt(2.5, 0.25, 15, "2026-03-05", { long: true }),
    contextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older frontier generation.",
  },
  {
    id: "gpt-5.2-pro",
    label: "GPT-5.2 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(21, undefined, 168, "2025-12-11"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older maximum-effort tier. No prompt caching.",
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    provider: "openai",
    tier: "frontier",
    rates: gpt(1.75, 0.175, 14, "2025-12-11"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older frontier generation.",
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    provider: "openai",
    tier: "frontier",
    rates: gpt(1.25, 0.125, 10, "2025-11-13"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older frontier generation.",
  },
  {
    id: "gpt-5-pro",
    label: "GPT-5 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(15, undefined, 120, "2025-10-06"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older maximum-effort tier. No prompt caching.",
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    provider: "openai",
    tier: "frontier",
    rates: withCache(1.25, 10, 0.125, "2025-08-07"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Hardest reasoning, long agentic runs, and judging other models.",
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    provider: "openai",
    tier: "balanced",
    rates: withCache(0.25, 2, 0.025, "2025-08-07"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "The workhorse of the GPT-5 family: most coding, editing and tool-driven turns.",
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 nano",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.05, 0.4, 0.005, "2025-08-07"),
    contextTokens: 400_000,
    maxOutputTokens: 128_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor:
      "Mechanical, well-specified work: classification, extraction, formatting, cheap sub-agents.",
  },
  {
    id: "o3",
    label: "o3",
    provider: "openai",
    tier: "frontier",
    rates: withCache(2, 8, 0.5, "2025-06-10"),
    contextTokens: 200_000,
    maxOutputTokens: 100_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Deliberate step-by-step reasoning on maths, science and hard debugging.",
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    provider: "openai",
    tier: "balanced",
    rates: withCache(1.1, 4.4, 0.275, "2025-04-16"),
    contextTokens: 200_000,
    maxOutputTokens: 100_000,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Cheaper reasoning where o3's depth is more than the task needs.",
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    provider: "openai",
    tier: "balanced",
    rates: withCache(2, 8, 0.5, "2025-04-14"),
    contextTokens: 1_047_576,
    maxOutputTokens: 32_768,
    capabilities: openaiCaps,
    bestFor: "Long-context work that does not need reasoning: large documents, wide edits.",
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.4, 1.6, 0.1, "2025-04-14"),
    contextTokens: 1_047_576,
    maxOutputTokens: 32_768,
    capabilities: openaiCaps,
    bestFor: "Long-context work that does not need frontier judgement.",
  },
  {
    id: "gpt-4.1-nano",
    label: "GPT-4.1 nano",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.1, 0.4, 0.025, "2025-04-14"),
    contextTokens: 1_047_576,
    maxOutputTokens: 32_768,
    capabilities: openaiCaps,
    bestFor: "High-volume classification and extraction at the lowest rate on offer.",
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    tier: "balanced",
    // 4o discounts cache reads 2x, not 10x, hence the explicit cached rate.
    rates: withCache(2.5, 10, 1.25, "2024-08-06"),
    contextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: openaiCaps,
    bestFor: "Previous generation; still common in production traffic.",
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.15, 0.6, 0.075, "2024-07-18"),
    contextTokens: 128_000,
    maxOutputTokens: 16_384,
    capabilities: openaiCaps,
    bestFor: "Previous-generation cheap tier, superseded by GPT-5 nano.",
  },
  ...OPEN_MODELS,
];

/**
 * Google Gemini: implemented but off by default, because these rates haven't
 * been checked against Google's price list and no replay has run against the
 * live API. `enableGemini()` registers the catalogue and provider, which turns
 * on the whole path (the wrapper instruments a client only if its models are
 * priced). Enable with `OPTIMAIZR_GEMINI=1` or `"experimental": { "gemini": true }`.
 */
export const GEMINI_MODELS: ModelPrice[] = [
  {
    id: "gemini-3-pro",
    label: "Gemini 3 Pro",
    provider: "google",
    tier: "frontier",
    rates: tiered(2, 12, 200_000, 4, 18, "2025-11-18"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "Hardest reasoning and very long context. Thinking is always on.",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    tier: "frontier",
    rates: tiered(1.25, 10, 200_000, 2.5, 15, "2025-06-17"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "Long-context analysis and multi-step work below Gemini 3 Pro's price.",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    tier: "balanced",
    rates: flat(0.3, 2.5, "2025-06-17"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "The default workhorse: fast, cheap, and still able to think.",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "google",
    tier: "fast",
    rates: flat(0.1, 0.4, "2025-07-22"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: googleCaps,
    bestFor: "Classification, extraction and other mechanical steps at the lowest rate.",
  },
];

const catalogue: ModelPrice[] = [...BUILTIN_MODELS];
let byId = new Map(catalogue.map((m) => [m.id, m]));

function reindex(): void {
  byId = new Map(catalogue.map((m) => [m.id, m]));
}

/** The live catalogue, built-ins plus anything registered at runtime. */
export const MODELS: ModelPrice[] = catalogue;

export function allModels(): ModelPrice[] {
  return catalogue;
}

export function providersInUse(): string[] {
  return [...new Set(catalogue.map((m) => m.provider))].sort();
}

/**
 * Add or replace models at runtime. An entry with an existing id replaces it,
 * which is how a price update ships without a release.
 */
export function registerModels(models: ModelPrice[]): void {
  for (const m of models) {
    const i = catalogue.findIndex((existing) => existing.id === m.id);
    if (i >= 0) catalogue[i] = m;
    else catalogue.push(m);
  }
  reindex();
}

/** Restore the built-in catalogue. Used by tests. */
export function resetModels(): void {
  catalogue.length = 0;
  catalogue.push(...BUILTIN_MODELS);
  reindex();
}

// The vendor's own name in front of its model, as gateways pass it through
// (openai/gpt-5, z-ai/glm-4.6). A host's spelling (deepseek-ai/DeepSeek-V4-Pro)
// is not stripped: a host sets its own price, so it stays unpriced.
const VENDOR_PREFIX = /^(anthropic|openai|azure|deepseek|z-ai|zai|moonshotai|minimax)[./]/i;

/**
 * Resolve a model id to its price card. Handles the date-suffixed ids every
 * provider emits, the platform prefixes used on Bedrock and Vertex, and the
 * `vendor/model` form gateways such as OpenRouter and LiteLLM pass through.
 */
export function priceFor(modelId: string | undefined | null): ModelPrice | null {
  if (!modelId) return null;
  const id = modelId
    .trim()
    .replace(/^(us|eu|apac)\./, "")
    .replace(VENDOR_PREFIX, "");
  const exact = byId.get(id) ?? byId.get(id.toLowerCase());
  if (exact) return exact;
  // Vendors spell their own ids in mixed case (MiniMax-M3, GLM-4.6).
  const lower = id.toLowerCase();
  let best: ModelPrice | null = null;
  for (const m of catalogue) {
    if (lower.startsWith(m.id.toLowerCase()) && (!best || m.id.length > best.id.length)) best = m;
  }
  return best;
}

export function providerOf(modelId: string | undefined | null): string {
  return priceFor(modelId)?.provider ?? "unknown";
}

/**
 * A model id for display: the catalogue label where there is one
 * (`claude-haiku-4-5` -> "Haiku 4.5"), otherwise the raw id.
 */
export function modelLabel(modelId: string | undefined | null): string {
  if (!modelId) return "unknown";
  return priceFor(modelId)?.label ?? modelId;
}

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /* --- OpenAI Chat Completions --- */
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** DeepSeek's spelling of a cache read, and Kimi's. */
  prompt_cache_hit_tokens?: number;
  cached_tokens?: number;
  /* --- OpenAI Responses --- */
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number; thinking_tokens?: number };
  /* --- Google Gemini (`usageMetadata`) --- */
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  /* --- Server-side tools, billed per request rather than per token --- */
  server_tool_use?: {
    web_search_requests?: number;
    /** Free of charge; read only so the shape is documented. */
    web_fetch_requests?: number;
  };
}

/** Usage in the one shape the rest of the system uses. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Server-side web searches, billed per request rather than per token. */
  webSearches: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read any supported vendor's usage object into one shape. Vendors disagree on
 * what "input" means (OpenAI's includes cached tokens, Anthropic's doesn't), so
 * the provider's cache policy decides the subtraction here, once. Everything
 * downstream sees uncached input only.
 */
export function normalizeUsage(
  usage: UsageLike | null | undefined,
  modelId?: string | null,
): NormalizedUsage {
  const u = usage ?? {};

  const cacheRead = num(
    u.cache_read_input_tokens ??
      u.prompt_tokens_details?.cached_tokens ??
      u.input_tokens_details?.cached_tokens ??
      u.prompt_cache_hit_tokens ??
      u.cached_tokens ??
      u.cachedContentTokenCount,
  );

  // OpenAI (GPT-5.6+) reports cache writes inside `input_tokens`, like reads.
  // Only the Responses field is documented; any Chat Completions write count is
  // billed as plain input (understated, never inflated).
  const includedWrites = num(u.input_tokens_details?.cache_write_tokens);

  let input = num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  const policy = PROVIDERS[providerOf(modelId)];
  // Chat Completions' `prompt_tokens` counts cache reads for every vendor that
  // speaks it (DeepSeek, Z.ai, Kimi), whatever the provider does natively.
  const chat = u.input_tokens === undefined && u.prompt_tokens !== undefined;
  if (policy?.inputIncludesCacheReads || chat) {
    input = Math.max(0, input - cacheRead - includedWrites);
  }

  const thinking = num(
    u.output_tokens_details?.thinking_tokens ??
      u.output_tokens_details?.reasoning_tokens ??
      u.completion_tokens_details?.reasoning_tokens ??
      u.thoughtsTokenCount,
  );

  // Gemini reports reasoning (`thoughtsTokenCount`) beside the visible output
  // instead of inside it, though both bill as output. Add them so "output"
  // means the same thing for every vendor.
  const output =
    u.output_tokens !== undefined || u.completion_tokens !== undefined
      ? num(u.output_tokens ?? u.completion_tokens)
      : num(u.candidatesTokenCount) + thinking;

  const write1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const writeReported5m = num(u.cache_creation?.ephemeral_5m_input_tokens);
  const writeTotal =
    num(u.cache_creation_input_tokens) || write1h + writeReported5m || includedWrites;

  return {
    inputTokens: input,
    outputTokens: output,
    thinkingTokens: thinking,
    cacheReadTokens: cacheRead,
    // Only the aggregate reported: bill at the cheaper short-TTL rate, which
    // understates rather than inflates.
    cacheWrite5mTokens: Math.max(0, writeTotal - write1h),
    cacheWrite1hTokens: write1h,
    webSearches: num(u.server_tool_use?.web_search_requests),
  };
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Per-request server-tool charges (web search is $10 per 1,000). No token count includes them. */
  serverTools: number;
  total: number;
  /** True when the model id was not in the catalogue and cost is 0. */
  unpriced: boolean;
  /** The agent's own figure for a model with no card here, split by token mix. */
  stated?: true;
}

export const ZERO_COST: CostBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  serverTools: 0,
  total: 0,
  unpriced: true,
};

export interface CostOptions {
  /** When the call happened, which decides the rate card. */
  at?: Date | string;
  /** `"fast"` bills at fast-mode rates on models that support it. */
  speed?: string | null;
  /** Batch traffic bills at the provider's batch discount. */
  batch?: boolean;
  /**
   * Prompt size (input + cache reads), which picks the band of a tiered card.
   * When omitted, the cheaper band is used.
   */
  promptTokens?: number;
}

/** The rate card in force for a model at a given moment. */
export function cardFor(price: ModelPrice, at?: Date | string): RateCard {
  const when = at ? new Date(at) : new Date();
  const time = when.getTime();
  if (!Number.isNaN(time)) {
    for (const card of price.rates) {
      const from = new Date(`${card.from}T00:00:00.000Z`).getTime();
      const until = card.until ? new Date(`${card.until}T23:59:59.999Z`).getTime() : Infinity;
      if (time >= from && time <= until) return card;
    }
  }
  // Outside every window: use the most recent card.
  return price.rates[price.rates.length - 1]!;
}

export interface EffectiveRates {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number;
  cacheWrite5mPerM: number;
  cacheWrite1hPerM: number;
  /** The card these came from, so callers can explain the number. */
  card: RateCard;
}

/** Whether a moment falls in peak hours: a weekday, inside one of the UTC hour ranges. */
export function isPeak(peakUtc: Array<[number, number]>, at?: Date | string): boolean {
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) return true;
  const day = when.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = when.getUTCHours() + when.getUTCMinutes() / 60;
  return peakUtc.some(([from, to]) => hour >= from && hour < to);
}

/** Fully resolved per-million rates for a model at a point in time. */
export function ratesFor(price: ModelPrice, opts: CostOptions = {}): EffectiveRates {
  const card = cardFor(price, opts.at);
  const policy = PROVIDERS[price.provider] ?? PROVIDERS.anthropic!;
  const scale = card.offPeak && !isPeak(card.offPeak.peakUtc, opts.at) ? card.offPeak.factor : 1;

  let inputPerM = card.inputPerM;
  let outputPerM = card.outputPerM;
  let cardCachedPerM = card.cachedInputPerM;
  let cardWritePerM = card.cacheWritePerM;

  // Long-context band, where the provider prices one. Checked before fast-mode
  // so an explicit fast rate still wins, as it does for a flat card.
  const band = card.longContext;
  if (band && (opts.promptTokens ?? 0) > band.aboveTokens) {
    inputPerM = band.inputPerM;
    outputPerM = band.outputPerM;
    cardCachedPerM = band.cachedInputPerM ?? undefined;
    cardWritePerM = band.cacheWritePerM ?? undefined;
  }

  if (opts.speed === "fast" && price.fast) {
    // The fast premium covers cache traffic too. A derived cache rate follows
    // the new input rate on its own; an explicit one has to be scaled.
    const premium = price.fast.inputPerM / inputPerM;
    if (cardCachedPerM !== undefined) cardCachedPerM *= premium;
    if (cardWritePerM !== undefined) cardWritePerM *= premium;
    inputPerM = price.fast.inputPerM;
    outputPerM = price.fast.outputPerM;
  }

  let cachedInputPerM = cardCachedPerM ?? inputPerM * policy.read;
  let cacheWrite5mPerM = cardWritePerM ?? inputPerM * policy.write5m;
  let cacheWrite1hPerM = cardWritePerM ?? inputPerM * policy.write1h;

  if (opts.batch || scale !== 1) {
    const d = (opts.batch ? policy.batch : 1) * scale;
    inputPerM *= d;
    outputPerM *= d;
    cachedInputPerM *= d;
    cacheWrite5mPerM *= d;
    cacheWrite1hPerM *= d;
  }

  return { inputPerM, outputPerM, cachedInputPerM, cacheWrite5mPerM, cacheWrite1hPerM, card };
}

/** Cost of one API call, from usage in whatever shape its SDK returned. */
export function costOf(
  usage: UsageLike | null | undefined,
  modelId: string | null | undefined,
  opts: CostOptions = {},
): CostBreakdown {
  const price = priceFor(modelId);
  if (!price || !usage) return { ...ZERO_COST };

  const n = normalizeUsage(usage, modelId);
  const M = 1_000_000;
  // A tiered card bands on the whole prompt sent (fresh input plus cache reads
  // and writes), not just the part billed at full price.
  const r = ratesFor(price, {
    ...opts,
    promptTokens:
      opts.promptTokens ??
      n.inputTokens + n.cacheReadTokens + n.cacheWrite5mTokens + n.cacheWrite1hTokens,
  });

  const input = (n.inputTokens * r.inputPerM) / M;
  const output = (n.outputTokens * r.outputPerM) / M;
  const cacheRead = (n.cacheReadTokens * r.cachedInputPerM) / M;
  const cacheWrite =
    (n.cacheWrite5mTokens * r.cacheWrite5mPerM + n.cacheWrite1hTokens * r.cacheWrite1hPerM) / M;

  // Per-request tool charges are not token traffic, so the batch discount and
  // fast-mode premium do not touch them.
  const tools = SERVER_TOOLS[price.provider];
  const serverTools = tools ? (n.webSearches * tools.webSearchPer1k) / 1000 : 0;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    serverTools,
    total: input + output + cacheRead + cacheWrite + serverTools,
    unpriced: false,
  };
}

// Rough weights of each kind of token against input, to split a stated total.
const MIX = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

/**
 * A cost the agent stated itself (opencode records one per step), for a model
 * with no card here. The total is kept; the split follows the token mix, so
 * per-kind numbers are estimates.
 */
export function statedCost(
  total: number,
  usage: UsageLike | null | undefined,
  modelId?: string | null,
): CostBreakdown {
  const n = normalizeUsage(usage, modelId);
  const parts = {
    input: n.inputTokens * MIX.input,
    output: n.outputTokens * MIX.output,
    cacheRead: n.cacheReadTokens * MIX.cacheRead,
    cacheWrite: (n.cacheWrite5mTokens + n.cacheWrite1hTokens) * MIX.cacheWrite,
  };
  const weight = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
  const share = (x: number) => (weight > 0 ? (total * x) / weight : 0);
  return {
    input: weight > 0 ? share(parts.input) : total,
    output: share(parts.output),
    cacheRead: share(parts.cacheRead),
    cacheWrite: share(parts.cacheWrite),
    serverTools: 0,
    total,
    unpriced: false,
    stated: true,
  };
}

/** What the same token profile would have cost on a different model. */
export function costOnModel(
  usage: UsageLike,
  targetModelId: string,
  opts: CostOptions = {},
): CostBreakdown {
  return costOf(usage, targetModelId, opts);
}

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    serverTools: a.serverTools + b.serverTools,
    total: a.total + b.total,
    unpriced: a.unpriced && b.unpriced,
  };
}

export function emptyCost(): CostBreakdown {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    serverTools: 0,
    total: 0,
    unpriced: false,
  };
}

export function usd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  if (Math.abs(n) >= 1000) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
