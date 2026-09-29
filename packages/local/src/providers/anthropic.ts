import { ingestClaudeCode, registerAdapter } from "@optimaizr/core";
import type { AdapterResult, AdapterSource } from "@optimaizr/core";

/**
 * Anthropic ingestion: Claude Code transcripts on disk, read with no
 * production changes. `./exports.ts` holds the vendor-neutral adapters.
 */

registerAdapter({
  provider: "anthropic",
  label: "Claude Code transcripts",
  canRead: (s: AdapterSource) => s.kind === "local-transcripts",
  async read(s: AdapterSource): Promise<AdapterResult> {
    if (s.kind !== "local-transcripts") return { events: [], sources: [], warnings: [] };
    const data = await ingestClaudeCode({ root: s.root, days: s.days, project: s.project });
    return { events: data.events, sources: data.sources, warnings: data.warnings };
  },
});
