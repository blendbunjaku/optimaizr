import { priceFor } from "../pricing.js";
import { setStatus } from "./recommendations.js";
import { verificationModeOf } from "../verify/state.js";
import type { OptimizationFinding, UsageEvent, VerifyCandidate } from "../domain/types.js";

/**
 * What accepting a recommendation does. By the time `live` can show one, the
 * call it describes has already been billed, so only the next request can
 * change: an app using `wrap()` or a Claude Code session running the optimAIzr
 * mod picks up overrides on its next request, while Codex (and Claude Code
 * without the mod) reads its model at session start.
 *
 * `accept()` returns `applied` only when a rewriter really took the change,
 * `queued` when the decision was recorded and the user got the command that
 * applies it, or `failed` when a rewriter tried and couldn't.
 */

/** One slice of the traffic a finding covers, in the terms a rewriter matches requests on. */
export interface TrafficSlice {
  source: UsageEvent["source"];
  project: string;
  route?: string;
  model: string;
  calls: number;
  /** Claude Code only: subagent calls (true) or the main conversation (false). */
  subagent?: boolean;
  /** Affected spend over all spend in the same slice, so a rewriter can tell a narrow finding. */
  share?: number;
}

/** Where a finding's affected calls came from. `live` knows; a batch report may not. */
export interface Traffic {
  slices: TrafficSlice[];
  /**
   * Affected spend as a share of each source's own spend. `affected.share` is
   * against all spend, which undercounts a Claude Code finding when a busy SDK
   * app shares the window.
   */
  shareBySource: Partial<Record<UsageEvent["source"], number>>;
}

/** Group the events a finding counted by where they came from. */
export function trafficOf(f: OptimizationFinding, events: readonly UsageEvent[]): Traffic {
  const slices = new Map<string, TrafficSlice>();
  const total = new Map<string, number>();
  const hit = new Map<string, number>();
  const sliceSpend = new Map<string, number>();
  const sliceHit = new Map<string, number>();

  for (const e of events) {
    total.set(e.source, (total.get(e.source) ?? 0) + e.cost.total);
    // Claude Code's subagents are their own slice: the mod can switch them alone.
    const agent = e.source === "claude-code" ? (e.isSubagent ? "sub" : "main") : "";
    const key = [e.source, e.project, e.route ?? "", e.model, agent].join("\u0000");
    sliceSpend.set(key, (sliceSpend.get(key) ?? 0) + e.cost.total);
    if (!f.affects(e)) continue;
    hit.set(e.source, (hit.get(e.source) ?? 0) + e.cost.total);
    sliceHit.set(key, (sliceHit.get(key) ?? 0) + e.cost.total);
    const s = slices.get(key);
    if (s) s.calls++;
    else
      slices.set(key, {
        source: e.source,
        project: e.project,
        ...(e.route !== undefined ? { route: e.route } : {}),
        model: e.model,
        calls: 1,
        ...(agent ? { subagent: agent === "sub" } : {}),
      });
  }
  for (const [key, s] of slices) {
    const all = sliceSpend.get(key) ?? 0;
    s.share = all > 0 ? (sliceHit.get(key) ?? 0) / all : 0;
  }

  const shareBySource: Traffic["shareBySource"] = {};
  for (const [source, usd] of hit) {
    const all = total.get(source) ?? 0;
    shareBySource[source as UsageEvent["source"]] = all > 0 ? usd / all : 0;
  }
  return { slices: [...slices.values()], shareBySource };
}

/** A proposed change, in the terms a prompt needs to render it. */
export interface ProposedChange {
  kind: VerifyCandidate["kind"] | "manual";
  /** Imperative one-liner, e.g. "Switch to Haiku 4.5". */
  label: string;
  /** Display labels for a model swap, when that is what this is. */
  from?: string;
  to?: string;
  /** The target model id, for a rewriter that needs the real thing. */
  toModelId?: string;
  /** Which traffic the change is for, when the host knows. */
  traffic?: Traffic;
}

export function proposedChange(f: OptimizationFinding, traffic?: Traffic): ProposedChange {
  const t = traffic ? { traffic } : {};
  const c = f.candidate;
  if (c?.kind === "swap-model" && c.to) {
    const from = f.affected.models.map((m) => priceFor(m)?.label ?? m).join(" / ");
    const to = priceFor(c.to)?.label ?? c.to;
    return { kind: "swap-model", label: `Switch to ${to}`, from, to, toModelId: c.to, ...t };
  }
  if (c?.kind === "lower-effort")
    return { kind: "lower-effort", label: "Lower reasoning effort", ...t };
  if (c?.kind === "enable-cache")
    return { kind: "enable-cache", label: "Cache the request prefix", ...t };
  if (c?.kind === "trim-prompt")
    return { kind: "trim-prompt", label: "Trim the system prompt", ...t };
  // Rules with no mechanical rewrite still have an action; it just isn't one a
  // rewriter could ever perform.
  return { kind: "manual", label: f.fix, ...t };
}

export interface InstallResult {
  ok: boolean;
  detail: string;
  /**
   * `ok: false` because the rewriter judged the change wrong for this traffic,
   * not because anything broke. The decision is still recorded, the same as
   * when no rewriter applies at all.
   */
  declined?: boolean;
  /** Something the user can do by hand to have the change take effect right now. */
  now?: string;
}

/**
 * Something that can alter an outbound request, or the config the next one is
 * built from. Typed by `ProposedChange`, not by model, so other kinds of change
 * need no new plumbing.
 */
export interface RequestRewriter {
  /** How this rewriter reaches requests, for display: "sdk wrapper", say. */
  readonly kind: string;
  supports(change: ProposedChange, finding: OptimizationFinding): boolean;
  /** Install the change. Must not throw; report failure in the result. */
  install(change: ProposedChange, finding: OptimizationFinding): InstallResult;
}

/** What one rewriter did, beside the one an `applied` outcome leads with. */
export interface RewriterResult {
  via: string;
  applied: boolean;
  detail: string;
}

export type ApplyOutcome =
  /** A rewriter really took the change. Only ever returned when one exists. */
  | {
      kind: "applied";
      via: string;
      detail: string;
      /** A manual step that makes it take effect sooner than the rewriter can. */
      now?: string;
      /** Every other rewriter that was tried, applied or not. */
      also?: RewriterResult[];
    }
  /**
   * Recorded, not applied. `reason` says why, `next` is the command that does.
   * `declined` when a rewriter could have acted and chose not to.
   */
  | { kind: "queued"; reason: string; next: string; declined?: boolean; now?: string }
  | { kind: "failed"; detail: string };

/** The command that actually settles this finding, given how it can be verified. */
export function nextCommandFor(f: OptimizationFinding): string {
  switch (verificationModeOf(f)) {
    case "replay":
      return `optimaizr verify ${f.rule}`;
    case "manual":
      return `optimaizr show ${f.rule}`;
    default:
      return `optimaizr apply ${f.rule}`;
  }
}

export interface AcceptOptions {
  /** Every pre-request integration wired up. Each one that supports the change is tried. */
  rewriters?: RequestRewriter[];
  /** A single rewriter; shorthand for `rewriters: [r]`. */
  rewriter?: RequestRewriter;
  /** Where the affected calls came from, so each rewriter acts only on its own. */
  traffic?: Traffic;
  /** Change nothing at all (`--dry-run`). */
  dryRun?: boolean;
}

/**
 * Accept a live recommendation. Records `viewed`, never `applied`: `applied` is
 * what `apply` writes after verification, and the verify/apply gate relies on it.
 */
export function accept(f: OptimizationFinding, opts: AcceptOptions = {}): ApplyOutcome {
  const change = proposedChange(f, opts.traffic);
  const rewriters = [...(opts.rewriters ?? []), ...(opts.rewriter ? [opts.rewriter] : [])];

  // A dry run must never write, so check it before any rewriter runs.
  const results: Array<InstallResult & { via: string }> = [];
  if (!opts.dryRun) {
    for (const r of rewriters) {
      let supported = false;
      try {
        supported = r.supports(change, f);
      } catch {
        /* a rewriter that cannot say is one that does not apply */
      }
      if (!supported) continue;
      try {
        results.push({ via: r.kind, ...r.install(change, f) });
      } catch (err) {
        results.push({ via: r.kind, ok: false, detail: errorText(err) });
      }
    }
  }

  const now = results.find((r) => r.now)?.now;
  const [lead, ...rest] = results.filter((r) => r.ok);
  if (lead) {
    const also = [...rest, ...results.filter((r) => !r.ok)].map((r) => ({
      via: r.via,
      applied: r.ok,
      detail: r.detail,
    }));
    return {
      kind: "applied",
      via: lead.via,
      detail: lead.detail,
      ...(now ? { now } : {}),
      ...(also.length > 0 ? { also } : {}),
    };
  }

  // Every rewriter that tried failed: report a failure, not "recorded".
  if (results.length > 0 && results.every((r) => !r.declined)) {
    return { kind: "failed", detail: results.map((r) => r.detail).join("; ") };
  }

  if (!opts.dryRun) setStatus(f.rule, "viewed", "accepted from optimaizr live");

  if (results.length > 0) {
    return {
      kind: "queued",
      declined: true,
      reason: results.map((r) => r.detail).join("; "),
      next: nextCommandFor(f),
      ...(now ? { now } : {}),
    };
  }

  const sources = new Set(change.traffic?.slices.map((s) => s.source));
  if (change.kind === "swap-model" && sources.size === 1 && sources.has("codex")) {
    return {
      kind: "queued",
      reason:
        "it had already completed when optimAIzr saw it, and Codex reads its model " +
        "when a session starts, so nothing outside it can switch the one running",
      next: nextCommandFor(f),
      now: "type /model in Codex to switch this session",
    };
  }

  return {
    kind: "queued",
    reason:
      "it had already completed when optimAIzr saw it, and no pre-request " +
      "integration is installed, so nothing was changed",
    next: nextCommandFor(f),
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
