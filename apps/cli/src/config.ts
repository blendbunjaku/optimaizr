import fs from "node:fs";
import path from "node:path";
import {
  blue,
  dim,
  enableGemini,
  type ModelPrice,
  parsePlan,
  PLAN_IDS,
  type PlanDetection,
  type PlanId,
  planRedirect,
  PLANS,
  type PlanSource,
  type QualityBar,
  type UsageEvent,
  red,
  registerModels,
  yellow,
} from "@optimaizr/core";
import { detectClaudePlan, optimaizrDir } from "@optimaizr/local";
import type { Args } from "./args.js";

export interface Config {
  qualityBar?: Partial<QualityBar>;
  models?: ModelPrice[];
  /** Features that are built but not on by default. */
  experimental?: { gemini?: boolean };
  /** A monthly spend cap in USD, reset on the 1st. `--budget` overrides it. */
  budget?: number;
  /**
   * A Claude subscription: "pro", "max5", "max20", "team" or "team-premium", or
   * "api" for per-token billing. Wins over what Claude Code's sign-in says;
   * `--plan` wins over both.
   */
  plan?: string;
  /** false turns off the once-a-day check for a newer version. */
  updateCheck?: boolean;
  path: string | null;
}

/** The config main() loaded, for commands that read more than models from it. */
let active: Config = { path: null };

export function activeConfig(): Config {
  return active;
}

export function initConfig(): void {
  active = loadConfig();
}

/**
 * The monthly cap to project against, from `--budget` or the config file. A bad
 * value is refused out loud rather than silently dropped.
 */
export function budgetOf(args: Args): number | null {
  const raw = args.flags.budget ?? activeConfig().budget;
  if (raw === undefined || raw === false) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(/^\$/, ""));
  if (raw === true || !Number.isFinite(n) || n <= 0) {
    console.log(`  ${red(`warning: budget must be a positive amount in USD, e.g. --budget 300`)}`);
    return null;
  }
  return n;
}

export interface PlanChoice {
  plan: PlanId | null;
  source: PlanSource | null;
  /** What Claude Code's sign-in says, whatever won. */
  detected: PlanDetection;
  /** True when `--plan api` (or the config) says usage is paid per token. */
  perToken: boolean;
}

// Read once per run: profile, live and card each ask.
let detection: PlanDetection | undefined;

function detectOnce(): PlanDetection {
  detection ??= detectClaudePlan();
  return detection;
}

/**
 * The Claude plan to read usage against: `--plan`, then the config file, then
 * what Claude Code's sign-in says. Explicit settings win so a wrong detection
 * can always be overridden; an unrecognised plan is never guessed.
 */
export function resolvePlan(args: Args): PlanChoice {
  const detected = detectOnce();
  const auto = detected.kind === "plan" ? detected.plan : null;
  for (const [raw, source] of [
    [args.flags.plan, "flag"],
    [activeConfig().plan, "config"],
  ] as const) {
    if (raw === undefined || raw === false) continue;
    if (payingPerToken(raw)) return { plan: null, source: null, detected, perToken: true };
    const plan = typeof raw === "string" ? parsePlan(raw) : null;
    if (plan) return { plan, source, detected, perToken: false };
    const redirect = typeof raw === "string" ? planRedirect(raw) : null;
    console.log(
      `  ${redirect ? yellow(`note: ${redirect}`) : red(`warning: plan must be one of ${PLAN_IDS.join(", ")}, e.g. --plan pro`)}`,
    );
    return { plan: null, source: null, detected, perToken: false };
  }
  return { plan: auto, source: auto ? "detected" : null, detected, perToken: false };
}

/** The Claude subscription to read usage against; see `resolvePlan`. */
export function planOf(args: Args): PlanId | null {
  return resolvePlan(args).plan;
}

/** `--plan api` (or "none"): pays per token, so no plan view and no plan hint. */
export function payingPerToken(raw: string | boolean | undefined): boolean {
  return typeof raw === "string" && /^(api|none|off)$/i.test(raw.trim());
}

/**
 * The one line a Claude Code user sees about their plan when it isn't simply
 * detected: unknown, half-known (Max, but 5x or 20x?), billed per token, or set
 * by hand to something other than what Claude Code reports. Null when there is
 * nothing to say.
 */
export function planNote(choice: PlanChoice, events: readonly UsageEvent[]): string[] | null {
  if (choice.perToken || !events.some((e) => e.source === "claude-code")) return null;
  const d = choice.detected;
  if (choice.plan) {
    if (choice.source === "detected" || d.kind !== "plan" || d.plan === choice.plan) return null;
    const where = choice.source === "flag" ? "--plan" : "your config";
    return [
      `${dim(`Using ${PLANS[choice.plan].label} from ${where}; Claude Code's sign-in says ${d.label}.`)}`,
    ];
  }
  if (d.kind === "plan") return null;
  if (d.kind === "per-token") {
    return [
      `${dim(`Plan: ${d.label}, billed at API rates. Read it against your spend limit: --budget <USD>`)}`,
    ];
  }
  if (d.kind === "partial") {
    return [
      `${dim(`Plan: ${d.label}, tier not reported.`)} ${blue(`--plan ${d.choices.join(" or --plan ")}`)} ${dim("shows your 5-hour sessions.")}`,
    ];
  }
  return [
    `${dim("Plan: unknown. Session and limit estimates are off until it's known.")}`,
    `${dim("On Pro, Max or Team?")} ${blue("--plan pro")} ${dim('(max5, max20, team, team-premium). Paying per token? "plan": "api" hides this.')}`,
  ];
}

/** Gemini is opt-in until its rates are checked. The env var avoids editing a file. */
export function geminiRequested(config: Config): boolean {
  const env = process.env.OPTIMAIZR_GEMINI;
  if (env && env !== "0" && env.toLowerCase() !== "false") return true;
  return config.experimental?.gemini === true;
}

/** Load configuration, then register any custom models, so prices are config, not code. */
export function loadConfig(): Config {
  const candidates = [
    path.resolve(process.cwd(), "optimaizr.config.json"),
    path.resolve(process.cwd(), ".optimaizr.json"),
    path.join(optimaizrDir(), "config.json"),
  ];
  let config: Config = { path: null };

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      config = { ...parsed, path: p };
      break;
    } catch {
      console.log(
        `  ${yellow("warning")} ${dim(`could not parse ${path.basename(p)}; ignoring it`)}`,
      );
    }
  }

  // A standalone catalogue file, so prices can be updated on their own.
  const modelsFile = path.join(optimaizrDir(), "models.json");
  if (fs.existsSync(modelsFile)) {
    try {
      const extra = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
      if (Array.isArray(extra)) registerModels(extra);
    } catch {
      console.log(`  ${yellow("warning")} ${dim("could not parse ~/.optimaizr/models.json")}`);
    }
  }
  // Before any custom models: `registerModels` replaces by id, so a user's own
  // Gemini entry must land after the built-in one to win.
  if (geminiRequested(config)) enableGemini();
  if (Array.isArray(config.models)) registerModels(config.models);

  return config;
}
