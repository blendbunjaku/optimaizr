import fs from "node:fs";
import path from "node:path";
import {
  type Dataset,
  dim,
  enableGemini,
  type ModelPrice,
  parsePlan,
  PLAN_IDS,
  type PlanId,
  planRedirect,
  type QualityBar,
  red,
  registerModels,
  yellow,
} from "@optimaizr/core";
import { optimaizrDir } from "@optimaizr/local";
import type { Args } from "./args.js";

export interface Config {
  qualityBar?: Partial<QualityBar>;
  models?: ModelPrice[];
  /** Features that are built but not on by default. */
  experimental?: { gemini?: boolean };
  /** A monthly spend cap in USD, reset on the 1st. `--budget` overrides it. */
  budget?: number;
  /** A Claude subscription: "pro", "max5", "max20", "team" or "team-premium". `--plan` overrides it. */
  plan?: string;
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

/** The Claude subscription to read usage against, from `--plan` or the config file. */
export function planOf(args: Args): PlanId | null {
  const raw = args.flags.plan ?? activeConfig().plan;
  if (raw === undefined || raw === false || payingPerToken(raw)) return null;
  const plan = typeof raw === "string" ? parsePlan(raw) : null;
  if (!plan) {
    const redirect = typeof raw === "string" ? planRedirect(raw) : null;
    console.log(
      `  ${redirect ? yellow(`note: ${redirect}`) : red(`warning: plan must be one of ${PLAN_IDS.join(", ")}, e.g. --plan pro`)}`,
    );
    return null;
  }
  return plan;
}

/** `--plan api` (or "none"): pays per token, so no plan view and no plan hint. */
export function payingPerToken(raw: string | boolean | undefined): boolean {
  return typeof raw === "string" && /^(api|none|off)$/i.test(raw.trim());
}

/**
 * Whether to tell a Claude Code user that `--plan` exists. Transcripts don't
 * say which plan someone is on, so without the hint the session view goes
 * unnoticed. Silent once any plan (including `api`) is set.
 */
export function shouldHintPlan(args: Args, data: Dataset): boolean {
  if (args.flags.plan !== undefined || activeConfig().plan !== undefined) return false;
  return data.events.some((e) => e.source === "claude-code");
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
