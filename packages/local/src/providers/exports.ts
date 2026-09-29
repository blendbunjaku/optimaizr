import { importUsageFile, registerAdapter } from "@optimaizr/core";
import { readLedger } from "../ledger.js";
import type { AdapterResult, AdapterSource } from "@optimaizr/core";

/**
 * Provider-agnostic ingestion: the model catalogue decides which provider each
 * row belongs to, so Anthropic and OpenAI calls land in one dataset. Registered
 * once, since two adapters claiming a source would double-count it.
 */

registerAdapter({
  provider: "any",
  label: "SDK recorder",
  canRead: (s: AdapterSource) => s.kind === "ledger",
  async read(s: AdapterSource): Promise<AdapterResult> {
    if (s.kind !== "ledger") return { events: [], sources: [], warnings: [] };
    const data = await readLedger({ days: s.days, project: s.project });
    return { events: data.events, sources: data.sources, warnings: data.warnings };
  },
});

registerAdapter({
  provider: "any",
  label: "Usage export",
  canRead: (s: AdapterSource) => s.kind === "file",
  async read(s: AdapterSource): Promise<AdapterResult> {
    if (s.kind !== "file") return { events: [], sources: [], warnings: [] };
    const result = importUsageFile(s.path, { service: s.service });
    const warnings: string[] = [];
    if (result.skipped > 0) {
      warnings.push(`${s.path}: skipped ${result.skipped} row(s) with no model or token counts`);
    }
    return { events: result.events, sources: [s.path], warnings };
  },
});
