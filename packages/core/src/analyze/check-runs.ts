import type { CheckKind, CheckOutcome, CheckRun, ToolCall } from "../domain/types.js";
import { commandOf, commandParts } from "./tasks.js";

/**
 * Check runs: a test, typecheck, build or lint command, and whether it passed.
 * The outcome comes from the runner's own summary line. Exit codes can't decide
 * it: most runs are piped into tail, which exits 0 either way.
 *
 * Only the outcome is kept. The output is read once, here, and dropped.
 */

/** Wrappers that run the command after them. */
const PREFIX =
  /^(?:(?:timeout|gtimeout)\s+\S+\s+|time\s+|env\s+(?:\w+=\S*\s+)*|nice\s+|caffeinate\s+(?:-\w+\s+)*)+/;
/** Package runners in front of a tool: npx vitest, pnpm exec jest, uv run pytest. */
const RUNNER =
  /^(?:npx(?:\s+--?\w[\w-]*)*|pnpm\s+(?:exec|dlx)|yarn(?:\s+exec)?|bunx|bun\s+x|uv\s+run|poetry\s+run|pipenv\s+run|bundle\s+exec|\S*node_modules\/\.bin\/)\s+/;
/**
 * `npm run test`, `yarn build`, `npm -w apps/cli test`, `pnpm -w test`: the
 * script's name. npm's -w names a workspace, pnpm's takes nothing.
 */
const SCRIPT =
  /^(?:npm|pnpm|yarn|bun)(?:\s+(?:-w|-C|--workspace|--filter|--prefix)(?:=|\s+)\S+|\s+--(?:silent|workspaces|if-present|recursive)|\s+-[rsw])*\s+(?:run(?:-script)?\s+)?([\w:.@/-]+)/;

const SCRIPT_KIND: Array<[RegExp, CheckKind]> = [
  [/^(?:test|tests|e2e)(?::.*)?$|^.*:test$/, "test"],
  [/^(?:typecheck|type-check|types|check-types|tsc)(?::.*)?$/, "typecheck"],
  [/^build(?::.*)?$|^.*:build$/, "build"],
  [/^(?:lint|check|format:check|check:format|prettier:check)(?::.*)?$/, "lint"],
];

const TOOL_KIND: Array<[RegExp, CheckKind]> = [
  [
    /^(?:vitest|jest|mocha|ava|tap|pytest|rspec|phpunit|playwright\s+test|cypress\s+run|go\s+test|cargo\s+(?:test|nextest)|deno\s+test|bun\s+test|swift\s+test|mix\s+test|dotnet\s+test|make\s+(?:test|check)|rails\s+test|python[\d.]*\s+-m\s+(?:pytest|unittest)|node\s+(?:\S+\s+)*--test)\b/,
    "test",
  ],
  [/^(?:mvn|\.?\/?gradlew?)\b.*\stest\b/, "test"],
  [/^(?:tsc|vue-tsc|mypy|pyright|cargo\s+check|go\s+vet)\b/, "typecheck"],
  [
    /^(?:(?:vite|next|nuxt|astro|remix|svelte-kit)\s+build|webpack|rollup|tsup|cargo\s+build|go\s+build|swift\s+build|dotnet\s+build|turbo\s+(?:run\s+)?build|make)\b/,
    "build",
  ],
  [
    /^(?:eslint|oxlint|stylelint|flake8|pylint|rubocop|shellcheck|golangci-lint|cargo\s+clippy|markdownlint|ruff(?:\s+check)?(?:\s|$)|biome\s+(?:check|lint|ci))/,
    "lint",
  ],
  [/^(?:prettier|ruff\s+format|cargo\s+fmt|black)\b.*\s--?(?:check|list-different|c|l)\b/, "lint"],
];

/** Tests decide most, then types, the build and lint. */
const RANK: Record<CheckKind, number> = { test: 0, typecheck: 1, build: 2, lint: 3 };

/** Heredoc bodies are data, not commands: a script mentioning pytest runs nothing. */
function withoutHeredocs(command: string): string {
  const at = command.indexOf("<<");
  return at === -1 ? command : command.slice(0, at);
}

/** What a command line checks, or null when it checks nothing. */
export function checkKindOf(command: string): CheckKind | null {
  let best: CheckKind | null = null;
  for (const raw of commandParts(withoutHeredocs(command))) {
    const part = raw.replace(PREFIX, "");
    let kind: CheckKind | null = null;
    const script = SCRIPT.exec(part);
    if (script) {
      kind = SCRIPT_KIND.find(([re]) => re.test(script[1]!))?.[1] ?? null;
    } else {
      const tool = part.replace(RUNNER, "");
      kind = TOOL_KIND.find(([re]) => re.test(tool))?.[1] ?? null;
    }
    if (kind && (!best || RANK[kind] < RANK[best])) best = kind;
  }
  return best;
}

/** The check a shell tool call ran, or null. */
export function checkKindOfTool(t: Pick<ToolCall, "name" | "signature">): CheckKind | null {
  const command = commandOf(t as ToolCall);
  return command ? checkKindOf(command) : null;
}

const FAIL: RegExp[] = [
  /^\s*(?:#|ℹ)\s*fail\s+[1-9]/m, // node --test
  /^\s*not ok\b/m, // TAP
  /\b[1-9]\d*\s+(?:failed|failing|failures?)\b/i, // vitest, jest, pytest, mocha, cargo
  /^(?:FAIL|FAILED)\b/m, // jest file lines, go, pytest
  /^--- FAIL:/m, // go
  /test result: FAILED/, // cargo
  /\berror TS\d+:/, // tsc
  /\bFound [1-9]\d* errors?\b/, // tsc --build, mypy, ruff
  /\b[1-9]\d* errors?, \d+ warnings?/, // pyright
  /\b[1-9]\d* problems? \([1-9]\d* errors?/, // eslint
  /^npm (?:ERR!|error)\s/m,
  /\bELIFECYCLE\b/,
  /\bCode style issues (?:were )?found\b/, // prettier --check
  /\bFailed to compile\b|\bBuild failed\b|\berror during build\b|^ERROR in /m,
  /\bCommand failed with exit code [1-9]/, // yarn
  /^error(?:\[E\d+\])?:/m, // cargo, rustc
  /\bBUILD FAILURE\b|\bBUILD FAILED\b/, // maven, gradle
];

const PASS: RegExp[] = [
  /^\s*(?:#|ℹ)\s*(?:pass\s+\d+|fail\s+0\b)/m, // node --test
  /\b\d+\s+(?:passed|passing)\b/i,
  /^ok\s/m, // go, TAP
  /test result: ok\./, // cargo
  /All matched files use Prettier code style/,
  /\b0 problems\b|\(0 errors?,/, // eslint
  /\bAll checks passed!/, // ruff
  /\bSuccess: no issues found\b/, // mypy
  /\b0 errors?, \d+ warnings?/, // pyright
  /\bFound 0 errors\b/,
  /\bCompiled successfully\b|\bbuilt in [\d.]+\s*m?s\b|\bBuild succeeded\b|\bBUILD SUCCESS(?:FUL)?\b/i,
  /\bFinished `?\w+`? (?:profile|target)/, // cargo build
  /^Done in [\d.]+m?s\b/m, // yarn, tsup
  /prerendered as static content/, // next build's route table
];

/** `exit 1`, `exited with code 0`, `EXIT=2`, `Process exited with code 1` (Codex). */
const EXIT = /\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?\s*[:=]?\s*(\d{1,3})\b/gi;
const NAMES = "tsc|types|typecheck|lint|eslint|prettier|format|tests?|build|checks?";
/**
 * `tsc:0`, `lint=1`, `build 0`: a check's name with its exit code on a line of
 * its own. "tests 44" is a count, so the bare space form skips test and check.
 */
const NAMED_EXIT = new RegExp(
  `^(?:(?:${NAMES})\\s*[:=]\\s*|(?:tsc|typecheck|lint|eslint|prettier|format|build)\\s+)(\\d{1,3})\\s*$`,
  "gim",
);
/** `TSC_OK`, `build ok`, `TESTS FAILED`: what an `&& echo` printed after the check. */
const NAMED_OK = new RegExp(`^(?:${NAMES})[ _-]?ok$`, "im");
const NAMED_FAIL = new RegExp(`^(?:${NAMES})[ _-]?fail(?:ed|ure)?$`, "im");

/** The agent never ran it: the user said no, or stopped it first. */
const REJECTED =
  /^(?:The user doesn't want to (?:proceed|take this action)|\[Request interrupted by user)/;

/** Lines the agent's own shell adds, and npm's script echo, which say nothing about the run. */
const NOISE =
  /^(?:Shell cwd was reset to .*|\[This command modified .*\]|> .*|\(No content\)|\(no output\)|Now using node .*)$/gm;

/** Long output: the summary is at the end, the first errors at the start. */
function window(text: string): string {
  return text.length <= 20_000 ? text : `${text.slice(0, 2_000)}\n${text.slice(-8_000)}`;
}

/**
 * Pass or fail from what a check printed. A failure anywhere wins, and so does
 * `tsc:2` on a line of its own. A loose "exit 1" in the text counts only when
 * no summary line said anything. Tools that print nothing on success (tsc,
 * eslint) pass on empty output.
 */
export function checkOutcomeOf(
  output: string,
  opts: { kind: CheckKind; isError?: boolean },
): CheckOutcome {
  const text = window(output);
  const named = [...text.matchAll(NAMED_EXIT)].map((m) => Number(m[1]));
  if (FAIL.some((re) => re.test(text)) || NAMED_FAIL.test(text) || named.some((n) => n !== 0)) {
    return "fail";
  }
  if (PASS.some((re) => re.test(text)) || NAMED_OK.test(text)) return "pass";
  const exits = [...named, ...[...text.matchAll(EXIT)].map((m) => Number(m[1]))];
  if (exits.some((n) => n !== 0)) return "fail";
  if (exits.length > 0) return "pass";
  if (opts.isError) return "fail";
  const quiet = opts.kind === "typecheck" || opts.kind === "lint" || opts.kind === "build";
  if (quiet && text.replace(NOISE, "").trim() === "") return "pass";
  return "unknown";
}

/** The text of a tool result: a string, or text blocks. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/** The check a result shows, or null when the command never ran. */
export function checkRunOf(kind: CheckKind, output: string, isError?: boolean): CheckRun | null {
  if (REJECTED.test(output.trimStart())) return null;
  return { kind, outcome: checkOutcomeOf(output, { kind, isError }) };
}
