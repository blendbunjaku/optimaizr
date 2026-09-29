import fs from "node:fs";
import path from "node:path";

import type { VerificationRecord, VerificationStore } from "@optimaizr/core";

import { optimaizrDir } from "./ledger.js";

/**
 * File-backed verification store for the CLI. `verifications.json` holds the
 * current record per rule, which `apply` gates on. `verifications.jsonl` is an
 * append-only log of every attempt, kept because each one cost real money.
 */
export function fileVerificationStore(): VerificationStore {
  const stateFile = () => path.join(optimaizrDir(), "verifications.json");
  const logFile = () => path.join(optimaizrDir(), "verifications.jsonl");

  return {
    load(): Record<string, VerificationRecord> {
      try {
        const p = stateFile();
        if (fs.existsSync(p)) {
          const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
          if (parsed && typeof parsed === "object") return parsed;
        }
        return migrateFromLog(logFile());
      } catch {
        // Fail closed: an unreadable store means nothing is verified.
        return {};
      }
    },

    save(all) {
      try {
        fs.mkdirSync(optimaizrDir(), { recursive: true });
        fs.writeFileSync(stateFile(), JSON.stringify(all, null, 2));
      } catch {
        /* a lost verification must not break the run */
      }
    },
  };
}

/**
 * Append one attempt to the log. Separate from `save`: the log records events,
 * the state records conclusions, and re-resolving must not rewrite history.
 */
export function logVerification(entry: VerificationRecord): void {
  try {
    fs.mkdirSync(optimaizrDir(), { recursive: true });
    fs.appendFileSync(
      path.join(optimaizrDir(), "verifications.jsonl"),
      `${JSON.stringify(entry)}\n`,
    );
  } catch {
    /* best effort */
  }
}

/**
 * Read state from the log older versions wrote (a raw `verdict`, no state), so
 * users who verified before upgrading don't pay for the same replay twice.
 */
function migrateFromLog(file: string): Record<string, VerificationRecord> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, VerificationRecord> = {};

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Partial<VerificationRecord> & { verdict?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.rule) continue;

    const state =
      entry.state ??
      (entry.verdict === "PASS"
        ? "passed"
        : entry.verdict === "FAIL"
          ? "failed"
          : entry.verdict === "INCONCLUSIVE"
            ? "inconclusive"
            : "unverified");

    out[entry.rule] = {
      rule: entry.rule,
      at: entry.at ?? new Date(0).toISOString(),
      state,
      // Only a replay ever produced one of these log lines.
      mode: entry.mode ?? "replay",
      verdict: entry.verdict as VerificationRecord["verdict"],
      samples: entry.samples,
      monthlySaving: entry.monthlySaving,
      description: entry.description,
      acceptedRiskAt: entry.acceptedRiskAt,
      note: entry.note,
    };
  }
  return out;
}
