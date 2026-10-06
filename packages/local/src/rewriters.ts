import fs from "node:fs";
import path from "node:path";

import { claudeConfigDir, priceFor } from "@optimaizr/core";
import type { OptimizationFinding, ProposedChange, RequestRewriter } from "@optimaizr/core";

/**
 * Applying a recommendation to Claude Code without the optimAIzr mod. `live`
 * runs in a separate process and the call is already billed, so the lever is
 * the `model` in `~/.claude/settings.json`. Claude Code reads it at session
 * start, so the change covers later sessions, and the outcome hands over the
 * `/model` command that switches the running one.
 */

export function claudeSettingsPath(): string {
  return path.join(claudeConfigDir(), "settings.json");
}

/**
 * Claude Code's settings take a family alias (`haiku`), not an id
 * (`claude-haiku-4-5`). Unknown ids pass through unchanged: a wrong alias
 * would pin the wrong model.
 */
export function settingsAliasFor(modelId: string): string {
  const id = modelId.toLowerCase();
  for (const family of ["haiku", "sonnet", "opus"]) {
    if (id.includes(family)) return family;
  }
  return modelId;
}

/**
 * How much of the traffic a finding must cover before changing the global
 * model is right. Below it, the switch would downgrade work the rule never
 * called mechanical; a sub-agent override is usually the real fix.
 */
const GLOBAL_CHANGE_SHARE = 0.8;

export interface ClaudeSettingsRewriterOptions {
  /** Override the settings path, for tests. */
  settingsPath?: string;
  /** Minimum affected share before a global change is offered. */
  minShare?: number;
  /** Stand aside when this is true, e.g. while the optimAIzr mod switches sessions itself. */
  unless?: () => boolean;
}

/**
 * The model Claude Code's own affected calls should move to. A finding can
 * span providers, so the headline target may not be an Anthropic model.
 * Without traffic info, it falls back to the headline target.
 */
function claudeTarget(change: ProposedChange, finding: OptimizationFinding): string | undefined {
  const slices = change.traffic?.slices.filter((s) => s.source === "claude-code");
  if (!slices) return change.toModelId;
  const busiest = [...slices].sort((a, b) => b.calls - a.calls)[0];
  if (!busiest) return undefined;
  return finding.candidate?.targetFor?.(busiest.model) ?? change.toModelId;
}

export function claudeSettingsRewriter(opts: ClaudeSettingsRewriterOptions = {}): RequestRewriter {
  const file = opts.settingsPath ?? claudeSettingsPath();
  const minShare = opts.minShare ?? GLOBAL_CHANGE_SHARE;

  return {
    kind: "claude-code settings",

    supports(change: ProposedChange, finding: OptimizationFinding): boolean {
      if (change.kind !== "swap-model" || opts.unless?.()) return false;
      // Claude Code only runs Anthropic models, so a swap to anything else is
      // not something this file can express.
      const target = claudeTarget(change, finding);
      return Boolean(target) && priceFor(target!)?.provider === "anthropic";
    },

    install(change: ProposedChange, finding: OptimizationFinding) {
      const target = claudeTarget(change, finding);
      if (!target) return { ok: false, detail: "no target model on this recommendation" };

      // Judged against Claude Code's own spend when that is known: that is the
      // traffic a global change would move.
      const share = change.traffic?.shareBySource["claude-code"] ?? finding.affected.share;
      if (share < minShare) {
        const pct = (share * 100).toFixed(0);
        return {
          ok: false,
          declined: true,
          detail:
            `only ${pct}% of your Claude Code spend is affected, so changing its global ` +
            `model would downgrade the rest too; the fix is a per-agent override`,
        };
      }

      const alias = settingsAliasFor(target);
      const now = `type /model ${alias} in the running Claude Code session to switch it now`;
      let settings: Record<string, unknown> = {};
      try {
        if (fs.existsSync(file)) {
          settings = JSON.parse(fs.readFileSync(file, "utf8"));
        }
      } catch (err) {
        return {
          ok: false,
          detail: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
        return { ok: false, detail: `${file} is not a JSON object; leaving it alone` };
      }

      const previous = typeof settings.model === "string" ? settings.model : undefined;
      if (previous === alias) {
        // The file is already right; a session on another model was started
        // with --model or switched by hand, and only /model reaches it.
        return {
          ok: false,
          declined: true,
          detail: `${file} already sets model to "${alias}"`,
          now,
        };
      }

      // Merge rather than replace: this file is the user's, and it holds far
      // more than a model.
      const next = { ...settings, model: alias };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      } catch (err) {
        return {
          ok: false,
          detail: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const undo = previous
        ? `set "model": "${previous}" to undo`
        : `remove the "model" key to undo`;
      return {
        ok: true,
        detail:
          `${file} model ${previous ? `"${previous}"` : "(unset)"} -> "${alias}". ` +
          `Applies to your next session, not the one running. ${undo}`,
        now,
      };
    },
  };
}
