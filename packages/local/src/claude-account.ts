import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeConfigDir,
  planFromAccount,
  type ClaudeAccountInfo,
  type PlanDetection,
  userPath,
} from "@optimaizr/core";

/**
 * Which Claude plan the signed-in Claude Code account is on, read from the
 * account block Claude Code caches in its config. Only the plan fields are
 * kept: no email, name or ids leave this function.
 */

/** Claude Code's global config: the legacy file when it exists, else `.claude.json`. */
export function claudeGlobalConfigPath(): string {
  const legacy = path.join(claudeConfigDir(), ".config.json");
  if (fs.existsSync(legacy)) return legacy;
  const set = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(set ? userPath(set) : os.homedir(), ".claude.json");
}

export function readClaudeAccount(file = claudeGlobalConfigPath()): ClaudeAccountInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const o = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount;
  if (typeof o !== "object" || o === null) return null;
  const pick = (k: keyof ClaudeAccountInfo) => {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "string" ? v : null;
  };
  return {
    organizationType: pick("organizationType"),
    organizationRateLimitTier: pick("organizationRateLimitTier"),
    userRateLimitTier: pick("userRateLimitTier"),
    seatTier: pick("seatTier"),
    billingType: pick("billingType"),
  };
}

export function detectClaudePlan(file?: string): PlanDetection {
  return planFromAccount(readClaudeAccount(file));
}
