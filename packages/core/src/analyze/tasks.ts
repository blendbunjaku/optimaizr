import type { TaskKind, ToolCall, UsageEvent } from "../domain/types.js";

/**
 * Tasks: one prompt and every call it set off, for agent transcripts. A single
 * call says little (nearly every agent step is short with one tool, even in the
 * middle of hard debugging), so rules that judge "was this simple work?" judge
 * the task. SDK and imported calls carry no turn and stay per call.
 *
 * Built from shape only: calls, tools, files, failures, tokens. Prompt text is
 * never read.
 */

export interface Task {
  /** The turn id the calls share. */
  id: string;
  sessionId: string;
  source: UsageEvent["source"];
  project: string;
  isSubagent: boolean;
  /** Oldest first. */
  events: UsageEvent[];
  /** The model that carried most of the task's cost. */
  model: string;
  start: string;
  end: string;
  calls: number;
  costUsd: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Visible output of the closing call (its answer): a long one is not a quick job. */
  answerTokens: number;
  edits: number;
  filesEdited: number;
  failures: number;
  /** Spawned a subagent, so part of the work happened elsewhere. */
  delegated: boolean;
  /** Context the task started with: what it carried in from earlier work. */
  firstContext: number;
  maxContext: number;
  /** Finished: replied, followed by another prompt, or quiet for a while. */
  done: boolean;
  kind: TaskKind;
  /** The kind ignoring reasoning, so a quick job that deliberated can be spotted. */
  shape: TaskKind;
}

/** Short jobs a smaller model handles: the only kinds `model-fit` acts on. */
export const MECHANICAL_TASKS: ReadonlySet<TaskKind> = new Set(["quick-edit", "lookup"]);

export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  "quick-edit": "quick edit",
  lookup: "lookup",
  conversation: "conversation",
  "multi-step": "multi-step task",
  debugging: "debugging",
  reasoning: "reasoning",
};

/** A quick job: at most this many calls and files edited. */
export const QUICK_MAX_CALLS = 8;
export const QUICK_MAX_FILES = 2;
/**
 * A closing answer longer than this is an explanation or analysis, not a wrap-up.
 * Claude Code ends most tasks with a short summary, so the bar sits above one.
 */
export const QUICK_MAX_ANSWER = 1_500;
/**
 * Agents think a little before most steps (about 1K tokens over a median task
 * on real Claude Code use), so only a task that thought harder counts as reasoning.
 */
export const TASK_REASONING_TOKENS = 2_000;
/** Two failures make it debugging, which needs the stronger model more, not less. */
const DEBUG_FAILURES = 2;
/** A task with no reply this long after its last call is treated as finished. */
const QUIET_MS = 15 * 60_000;

const TERMINAL_STOPS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
const SHELL_TOOLS = new Set(["Bash", "exec_command", "shell", "local_shell"]);
// Bookkeeping that neither reads nor changes anything.
const NEUTRAL_TOOLS = new Set([
  "TodoWrite",
  "update_plan",
  "write_stdin",
  "BashOutput",
  "ToolSearch",
  "Skill",
  "AskUserQuestion",
]);
const DELEGATE_TOOLS = new Set(["Task", "Agent"]);

const READ_ONLY_COMMAND =
  /^(ls|cat|head|tail|less|grep|egrep|rg|ag|find|fd|pwd|echo|printf|wc|which|type|tree|stat|file|du|df|sort|uniq|cut|tr|awk|diff|cmp|date|env|printenv|basename|dirname|realpath|ps|lsof|sed -n|jq|test|\[|true|git (status|diff|log|show|branch|blame|rev-parse|ls-files|remote|config --get)|gh (api|run (view|list)|pr (view|list|diff|checks)|issue (view|list))|curl)\b/;
// Shell setup and control flow: they neither read nor change the project.
const NEUTRAL_COMMAND =
  /^(cd|export|source|\.|set|unset|nvm use|for|while|until|if|done|fi|esac|\w+=\S*$)(\s|$)/;
const CONTROL_PREFIX = /^(do|then|else|elif)\s+/;

/** The command a shell tool ran, from its signature (`Bash:...` or Codex's JSON args). */
export function commandOf(t: ToolCall): string | null {
  if (!SHELL_TOOLS.has(t.name)) return null;
  const rest = t.signature.slice(t.name.length + 1);
  if (t.name === "Bash") return rest;
  const m = /"(?:cmd|command)":\s*(?:\[\s*)?"((?:[^"\\]|\\.)*)"/.exec(rest);
  return m ? m[1]! : rest;
}

/** A command line's parts, split on `&&`, `||`, `;` and pipes outside quotes. */
function commandParts(command: string): string[] {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q");
  return unquoted
    .split(/&&|\|\||;|\||\n/)
    .map((p) =>
      p
        .trim()
        .replace(CONTROL_PREFIX, "")
        .replace(/^(\w+=\S+\s+)+/, ""),
    )
    .filter(Boolean);
}

/**
 * Every part of a command line only reads (`ls`, `git diff | head`, `cd x && rg y`).
 * A write redirect (`> file`) or a request that sends data (`curl -d`) changes things.
 */
export function isReadOnlyCommand(command: string): boolean {
  const parts = commandParts(command).filter((p) => !NEUTRAL_COMMAND.test(p));
  return (
    parts.length > 0 &&
    parts.every(
      (p) =>
        READ_ONLY_COMMAND.test(p) &&
        !/(^|[^0-9&>])>{1,2}(?!\s*(&|\/dev\/null))/.test(p) &&
        !(/^find\b/.test(p) && /\s-(delete|exec|execdir|ok)\b/.test(p)) &&
        !(/^curl\b/.test(p) && /\s(-d|--data\S*|-X\s*(POST|PUT|PATCH|DELETE)|-T|-F)\b/.test(p)) &&
        !(/^gh api\b/.test(p) && /\s(-X|--method|-f|-F)\b/.test(p)),
    )
  );
}

/** A tool call that changes files or state. */
export function isMutating(t: ToolCall): boolean {
  if (EDIT_TOOLS.has(t.name)) return true;
  const cmd = commandOf(t);
  return cmd !== null && !isReadOnlyCommand(cmd);
}

export function isEdit(t: ToolCall): boolean {
  return EDIT_TOOLS.has(t.name);
}

/** Output tokens that are not thinking. */
function visible(e: UsageEvent): number {
  return Math.max(0, e.outputTokens - e.thinkingTokens);
}

/** Tokens the call carried in: fresh input, cache reads and cache writes. */
export function contextOf(e: UsageEvent): number {
  return e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;
}

function shapeOf(t: Omit<Task, "kind" | "shape" | "done">, tools: ToolCall[]): TaskKind {
  if (t.failures >= DEBUG_FAILURES) return "debugging";
  if (
    t.delegated ||
    t.calls > QUICK_MAX_CALLS ||
    t.filesEdited > QUICK_MAX_FILES ||
    t.answerTokens > QUICK_MAX_ANSWER
  ) {
    return "multi-step";
  }
  const working = tools.filter((x) => !NEUTRAL_TOOLS.has(x.name));
  if (working.length === 0) return "conversation";
  // An edit checked by a command that passed (a test run, a build) is still quick.
  if (t.edits > 0) return "quick-edit";
  const onlyReads = working.every(
    (x) => READ_TOOLS.has(x.name) || (commandOf(x) !== null && !isMutating(x)),
  );
  return onlyReads ? "lookup" : "multi-step";
}

/**
 * Group agent calls into tasks. `now` decides whether a task with no reply is
 * still running; it defaults to the newest call, so a batch read is stable.
 */
export function buildTasks(events: readonly UsageEvent[], opts: { now?: number } = {}): Task[] {
  const byTurn = new Map<string, UsageEvent[]>();
  let newest = -Infinity;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t > newest) newest = t;
    if (!e.turnId) continue;
    const arr = byTurn.get(e.turnId);
    if (arr) arr.push(e);
    else byTurn.set(e.turnId, [e]);
  }
  const now = opts.now ?? newest;

  const tasks: Task[] = [];
  for (const [id, list] of byTurn) {
    const evs = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    const first = evs[0]!;
    const last = evs[evs.length - 1]!;
    const tools = evs.flatMap((e) => e.tools);
    const costByModel = new Map<string, number>();
    for (const e of evs) costByModel.set(e.model, (costByModel.get(e.model) ?? 0) + e.cost.total);
    const model = [...costByModel].sort((a, b) => b[1] - a[1])[0]![0];
    const edited = tools.filter((t) => isEdit(t) && !t.isError);

    const base = {
      id,
      sessionId: first.sessionId,
      source: first.source,
      project: first.project,
      isSubagent: Boolean(first.isSubagent),
      events: evs,
      model,
      start: first.ts,
      end: last.ts,
      calls: evs.length,
      costUsd: evs.reduce((s, e) => s + e.cost.total, 0),
      outputTokens: evs.reduce((s, e) => s + e.outputTokens, 0),
      thinkingTokens: evs.reduce((s, e) => s + e.thinkingTokens, 0),
      answerTokens: visible(last),
      edits: edited.length,
      filesEdited: new Set(edited.map((t) => t.target ?? t.signature)).size,
      failures: tools.filter((t) => t.isError).length,
      delegated: tools.some((t) => DELEGATE_TOOLS.has(t.name)),
      firstContext: contextOf(first),
      maxContext: Math.max(...evs.map(contextOf)),
    };
    const shape = shapeOf(base, tools);
    tasks.push({
      ...base,
      done: TERMINAL_STOPS.has(last.stopReason ?? "") || now - Date.parse(last.ts) > QUIET_MS,
      kind: base.thinkingTokens >= TASK_REASONING_TOKENS ? "reasoning" : shape,
      shape,
    });
  }

  // A later prompt in the same session means the earlier one was answered.
  const bySession = new Map<string, Task[]>();
  for (const t of tasks) {
    const arr = bySession.get(t.sessionId);
    if (arr) arr.push(t);
    else bySession.set(t.sessionId, [t]);
  }
  for (const list of bySession.values()) {
    for (const t of list) {
      if (!t.done) t.done = list.some((o) => o !== t && o.start > t.end);
    }
  }
  return tasks.sort((a, b) => a.start.localeCompare(b.start));
}

/** Stamp each agent call with its task's kind, and index calls by task. */
export function stampTasks(tasks: readonly Task[]): Map<string, Task> {
  const byEvent = new Map<string, Task>();
  for (const t of tasks) {
    for (const e of t.events) {
      e.taskKind = t.kind;
      byEvent.set(e.id, t);
    }
  }
  return byEvent;
}
