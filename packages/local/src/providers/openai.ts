import { ingestCodex, registerAdapter } from "@optimaizr/core";
import type { AdapterResult, AdapterSource } from "@optimaizr/core";

/**
 * OpenAI ingestion: Codex CLI session rollouts in `~/.codex/sessions`, read
 * with no production changes. It answers the same `local-transcripts` source
 * as the Claude Code adapter, and both feed one dataset.
 */

registerAdapter({
  provider: "openai",
  label: "Codex transcripts",
  canRead: (s: AdapterSource) => s.kind === "local-transcripts",
  async read(s: AdapterSource): Promise<AdapterResult> {
    if (s.kind !== "local-transcripts") return { events: [], sources: [], warnings: [] };
    const data = await ingestCodex({ root: s.root, days: s.days, project: s.project });
    return { events: data.events, sources: data.sources, warnings: data.warnings };
  },
});
