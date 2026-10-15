import { ingestOpencode, registerAdapter } from "@optimaizr/core";
import type { AdapterResult, AdapterSource } from "@optimaizr/core";

/**
 * opencode ingestion: its SQLite history, read in place with no changes to
 * opencode. It answers the same `local-transcripts` source as the Claude Code
 * and Codex adapters, and all three feed one dataset.
 */

registerAdapter({
  provider: "any",
  label: "opencode history",
  canRead: (s: AdapterSource) => s.kind === "local-transcripts",
  async read(s: AdapterSource): Promise<AdapterResult> {
    // A pinned root names a transcript folder, not opencode's database: read nothing.
    if (s.kind !== "local-transcripts" || s.root) return { events: [], sources: [], warnings: [] };
    const data = await ingestOpencode({ days: s.days, project: s.project });
    return {
      events: data.events,
      sources: data.sources,
      warnings: data.warnings,
      compactions: data.compactions,
      titles: data.titles,
    };
  },
});
