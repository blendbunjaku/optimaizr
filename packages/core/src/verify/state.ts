import type {
  OptimizationFinding,
  VerificationMode,
  VerificationRecord,
  VerificationState,
} from "../domain/types.js";

/**
 * Verification state: the one answer `verify` writes and `apply` reads, derived
 * in one place so the two commands can't disagree about a finding.
 *
 * A change may be applied only when there's reason to believe quality holds:
 * it can't affect output (`not_required`), a replay on the user's traffic
 * cleared their bar (`passed`), or the user signed off a change no replay can
 * settle (`manual` plus `acceptedRiskAt`). Nothing else, including a `failed`
 * or `inconclusive` replay.
 */

/** How this finding's quality question can be settled. */
export function verificationModeOf(finding: OptimizationFinding): VerificationMode {
  // Hand-made findings (tests, older payloads) may lack it: derive it the same
  // way build() does.
  if (finding.verification) return finding.verification;
  if (finding.risk === "safe") return "not-required";
  return finding.candidate ? "replay" : "manual";
}

/** Map a replay verdict onto the persisted state vocabulary. */
export function stateForVerdict(verdict: "PASS" | "FAIL" | "INCONCLUSIVE"): VerificationState {
  if (verdict === "PASS") return "passed";
  if (verdict === "FAIL") return "failed";
  return "inconclusive";
}

export interface ResolvedVerification {
  state: VerificationState;
  mode: VerificationMode;
  /** Whether `apply` may hand over a change. */
  canApply: boolean;
  /** One line stating where this stands. */
  headline: string;
  /** What the user can do about it, when there is something to do. */
  guidance: string | null;
  /** The record this was resolved against, if any. */
  record: VerificationRecord | null;
}

/**
 * Resolve a finding and its persisted record into one state. Pure: it takes the
 * record instead of reading a store, so every host resolves the same way.
 */
export function resolveVerification(
  finding: OptimizationFinding,
  record: VerificationRecord | null,
): ResolvedVerification {
  const mode = verificationModeOf(finding);

  if (mode === "not-required") {
    return {
      state: "not_required",
      mode,
      canApply: true,
      headline: "No verification required - this removes waste without changing output.",
      guidance: null,
      record,
    };
  }

  if (mode === "manual") {
    // Only the user can settle this, and `apply` gates on that being recorded.
    if (record?.acceptedRiskAt) {
      return {
        state: "passed",
        mode,
        canApply: true,
        headline: `Risk accepted on ${record.acceptedRiskAt.slice(0, 10)} - verified by you, not by replay.`,
        guidance: null,
        record,
      };
    }
    return {
      state: "unverified",
      mode,
      canApply: false,
      headline: "This change can alter output, and no replay can settle it.",
      guidance:
        "There is no mechanical rewrite to replay here - the fix changes how the work is dispatched, not one field of a request. Validate it on your own evals or staging traffic, then re-run apply with --accept-risk to record that you did.",
      record,
    };
  }

  // mode === "replay": a verdict on the user's own traffic is the gate.
  if (!record) {
    return {
      state: "unverified",
      mode,
      canApply: false,
      headline: "Not verified.",
      guidance:
        "This change can alter model output, so optimAIzr will not hand you a change to apply until it has cleared your quality bar.",
      record,
    };
  }

  if (record.state === "passed") {
    return {
      state: "passed",
      mode,
      canApply: true,
      headline: `Verified PASS on ${record.at.slice(0, 10)}${record.samples ? `, ${record.samples} samples` : ""}.`,
      guidance: null,
      record,
    };
  }

  if (record.state === "failed") {
    return {
      state: "failed",
      mode,
      canApply: false,
      headline: `Verification failed on ${record.at.slice(0, 10)}.`,
      guidance:
        "This did not clear your quality bar on your own traffic. That is the point of verifying first: the saving was not free.",
      record,
    };
  }

  return {
    state: record.state === "inconclusive" ? "inconclusive" : "unverified",
    mode,
    canApply: false,
    headline: `Verification was inconclusive on ${record.at.slice(0, 10)}.`,
    guidance:
      "Too little captured traffic to conclude either way. Capture more samples and verify again.",
    record,
  };
}

/* ------------------------------------------------------------------ *
 * Persistence, injected like DecisionStore
 * ------------------------------------------------------------------ */

/**
 * Where verification results persist. A verification is evidence the user paid
 * for, so unlike a finding it has to outlive the run. The host injects the
 * store; the CLI uses a file.
 */
export interface VerificationStore {
  load(): Record<string, VerificationRecord>;
  save(all: Record<string, VerificationRecord>): void;
}

function memoryStore(): VerificationStore {
  let state: Record<string, VerificationRecord> = {};
  return {
    load: () => state,
    save: (all) => {
      state = all;
    },
  };
}

let store: VerificationStore = memoryStore();

/** Install the host's verification store. Called once at startup. */
export function setVerificationStore(next: VerificationStore): void {
  store = next;
}

export function loadVerifications(): Record<string, VerificationRecord> {
  try {
    return store.load();
  } catch {
    return {};
  }
}

/** The latest verification for one rule, or null. */
export function readVerification(rule: string): VerificationRecord | null {
  return loadVerifications()[rule] ?? null;
}

/**
 * Record a verification result. Never throws; a lost record fails closed (the
 * finding reads as unverified).
 */
export function recordVerification(entry: VerificationRecord): void {
  try {
    const all = { ...loadVerifications() };
    // Keep an earlier risk acceptance: a later replay adds information, it
    // doesn't withdraw the user's decision.
    const previous = all[entry.rule];
    all[entry.rule] = {
      ...entry,
      acceptedRiskAt: entry.acceptedRiskAt ?? previous?.acceptedRiskAt,
    };
    store.save(all);
  } catch {
    /* a lost verification must not break the run */
  }
}

/**
 * Record that the user has taken responsibility for a finding no replay can
 * settle. Returns the stored record.
 */
export function acceptRisk(rule: string, note?: string): VerificationRecord {
  const at = new Date().toISOString();
  const entry: VerificationRecord = {
    rule,
    at,
    state: "passed",
    mode: "manual",
    acceptedRiskAt: at,
    note: note ?? "Risk accepted by the user; no replay was possible for this rule.",
  };
  recordVerification(entry);
  return entry;
}
