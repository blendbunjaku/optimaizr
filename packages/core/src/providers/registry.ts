import { GEMINI_MODELS, PROVIDERS, registerModels } from "../pricing.js";
import type {
  AdapterResult,
  AdapterSource,
  Dataset,
  Provider,
  ProviderAdapter,
  UsageEvent,
} from "../domain/types.js";

/**
 * Provider and adapter registry. Adapters turn a vendor's usage into
 * `UsageEvent`s and are the only vendor-specific code; everything downstream
 * reads `UsageEvent`, so adding a vendor never touches the analysis.
 */

const providers = new Map<string, Provider>();
const adapters: ProviderAdapter[] = [];

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function registerAdapter(adapter: ProviderAdapter): void {
  const i = adapters.findIndex((a) => a.label === adapter.label);
  if (i >= 0) adapters[i] = adapter;
  else adapters.push(adapter);
}

export function listProviders(): Provider[] {
  return [...providers.values()];
}

export function listAdapters(): ProviderAdapter[] {
  return [...adapters];
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

/** Providers derived from the pricing catalogue's cache policies. */
registerProvider({
  id: "anthropic",
  label: "Anthropic",
  cachePolicy: PROVIDERS.anthropic!,
  usageExportHint: "console.anthropic.com → Usage",
});

registerProvider({
  id: "openai",
  label: "OpenAI",
  cachePolicy: PROVIDERS.openai!,
  usageExportHint: "platform.openai.com → Usage → Export",
});

/**
 * Read everything the given sources can offer into one dataset. An adapter
 * that fails mid-read adds a `failure` instead of aborting the run; failures
 * are kept apart from warnings because each means a whole source is missing.
 */
export async function ingest(sources: AdapterSource[]): Promise<Dataset> {
  const events: UsageEvent[] = [];
  const readSources: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  for (const source of sources) {
    for (const adapter of adapters) {
      if (!adapter.canRead(source)) continue;
      let result: AdapterResult;
      try {
        result = await adapter.read(source);
      } catch (err: any) {
        failures.push(`${adapter.label}: ${err?.message ?? "failed to read"}`);
        continue;
      }
      // Never `push(...result.events)`: past ~100k events (a few months of
      // heavy Claude Code use) the spread overflows V8's call stack.
      for (const e of result.events) events.push(e);
      for (const s of result.sources) readSources.push(s);
      for (const w of result.warnings) warnings.push(w);
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days =
    from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) : 0;

  return { events, window: { from, to, days }, sources: readSources, warnings, failures };
}

/**
 * Turn Gemini on: registers its models and provider, which also makes `wrap()`
 * instrument Google clients. Off by default because the rates are unverified.
 * Idempotent. The CLI calls it when `OPTIMAIZR_GEMINI` or the config asks.
 */
export function enableGemini(): void {
  registerModels(GEMINI_MODELS);
  registerProvider({
    id: "google",
    label: "Google",
    cachePolicy: PROVIDERS.google!,
    usageExportHint: "console.cloud.google.com → Billing → Reports",
  });
}

/** Whether the Gemini catalogue is currently registered. */
export function geminiEnabled(): boolean {
  return providers.has("google");
}
