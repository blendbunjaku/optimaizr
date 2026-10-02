import type {
  EngineInterface,
  Register,
  SessionUsage,
  TurnStepInput,
  TurnStepResult,
} from "claude-code";
import {
  bar,
  describeSwitch,
  effortFor,
  fiveHour,
  inProject,
  isWindow,
  meterText,
  modelLabel,
  type Override,
  parseOverrides,
  percent,
  record,
  savedBy,
  sevenDay,
  summary,
  switchFor,
  turnLine,
  usd,
  type Window,
  windowNote,
} from "./meter.ts";

// The optimAIzr mod: this turn's cost and the 5-hour window while Claude works,
// one line under each answer, the model and effort switches `optimaizr live`
// accepts, and a guard against retry loops. It reads usage figures and the
// commands Claude runs, never prompt text or file contents.

const VERSION = "0.8.0";
// overrides.json is read again at most this often, so `optimaizr undo` lands fast.
const REREAD_MS = 3_000;
// `optimaizr live` counts a session as gone after three missed beats.
const BEAT_MS = 60_000;
// A command that failed this many times in a row, unchanged, is held once.
const RETRY_LIMIT = 2;

// Tools whose success can change what a retried command sees.
const MUTATING = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

type Api = EngineInterface;

type Turn = {
  startUsd: number;
  startPct?: number;
  calls: number;
  switched?: Override;
  saved?: number;
  effort?: string;
  held: number;
};

// One session's figures, shared by the hooks below.
const state = {
  dir: "",
  file: "",
  id: "",
  // The project root: where the session started. A shell `cd` doesn't move it.
  root: "",
  startedAt: 0,
  requests: 0,
  usage: null as SessionUsage | null,
  window: undefined as Window | undefined,
  turn: null as Turn | null,
  overrides: [] as Override[],
  readAt: -Infinity,
  // Switches that moved at least one request in this session, by slot.
  applied: new Map<string, Override>(),
  // Targets the API refused here; the session keeps its own setting for them.
  refused: new Set<string>(),
  // `/optimaizr off`: this session goes back to its own model until `/optimaizr on`.
  paused: false,
  // Switches the person has been told about, so the note shows once.
  told: new Set<string>(),
  // Net saving of the switched requests, once one has been priced.
  saved: undefined as number | undefined,
  held: 0,
  // What this conversation has seen; compaction and /clear forget it.
  convo: {
    // Models that already wrote this conversation to their cache.
    loaded: new Set<string>(),
    fails: new Map<string, number>(),
    // Held once already: the next identical command goes through.
    waived: new Set<string>(),
  },
};

function forget(): void {
  state.convo = { loaded: new Set(), fails: new Map(), waived: new Set() };
}

async function optimaizrDir($: Api): Promise<string> {
  const set = await $.env.get("OPTIMAIZR_DIR");
  if (set) return set;
  const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE")) ?? ".";
  return `${home}/.optimaizr`;
}

/** Keep the latest usage, add a 5-hour reading to the shared history, redraw. */
async function take($: Api, u: SessionUsage): Promise<void> {
  state.usage = u;
  const five = fiveHour(u.rateLimits);
  if (five) {
    const stored = await $.store.get("window");
    const prev = isWindow(stored) ? stored : state.window;
    const next = record(prev, five, await $.clock.now());
    state.window = next;
    if (next !== prev) await $.store.set("window", next);
  }
  void $.ui.invalidate("ui.render");
}

async function measure($: Api): Promise<void> {
  await take($, await $.session.usage());
}

/** The session file `optimaizr live` and `optimaizr mod` read. */
async function beat($: Api, ended = false): Promise<void> {
  if (!state.file) return;
  const now = new Date(await $.clock.now()).toISOString();
  const body = {
    id: state.id,
    version: VERSION,
    cwd: state.root,
    startedAt: new Date(state.startedAt).toISOString(),
    seenAt: now,
    ...(ended ? { endedAt: now } : {}),
  };
  await $.fs.write(state.file, `${JSON.stringify(body)}\n`);
}

/** Once a minute: tell the CLI the session is alive, and notice an undo while idle. */
async function refresh($: Api): Promise<void> {
  await beat($).catch(() => undefined);
  await switches($).catch(() => undefined);
  void $.ui.invalidate("ui.render");
}

async function switches($: Api): Promise<Override[]> {
  const now = await $.clock.now();
  if (now - state.readAt < REREAD_MS) return state.overrides;
  state.readAt = now;
  const text = await $.fs.read(`${state.dir}/overrides.json`).catch(() => "");
  state.overrides = parseOverrides(typeof text === "string" ? text : "");
  return state.overrides;
}

/** Count a finished request and refresh the figures the spinner shows. */
async function counted($: Api): Promise<void> {
  state.requests += 1;
  if (state.turn) state.turn.calls += 1;
  await measure($).catch(() => undefined);
}

const slotOf = (o: Override) =>
  `${o.project}\u0000${o.subagent ?? ""}\u0000${o.from}\u0000${o.effort ?? ""}`;

// No response and no usage, and not because the person interrupted: the request failed.
const failed = (r: TurnStepResult, aborted: boolean) =>
  !aborted && r.stopReason === null && r.usage === null;

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

const commandKey = (agent: string, command: string) =>
  `${agent}\u0000${command.trim().replace(/\s+/g, " ")}`;

export const register: Register = (on, options) => {
  const showTurnLine = options.turnLine !== false;
  const retryGuard = options.retryGuard !== false;

  on("session.start", async ($, e, next) => {
    state.dir = await optimaizrDir($);
    state.id = await $.session.id();
    state.root = await $.session.root();
    state.startedAt = await $.clock.now();
    state.file = `${state.dir}/mod/sessions/${state.id}.json`;
    await $.command.register({
      name: "optimaizr",
      description: "This session's spend, savings and plan windows; off or on pauses a switch here",
      argumentHint: "[off|on]",
      immediate: true,
    });
    await beat($).catch(() => undefined);
    $.clock.every(BEAT_MS, () => void refresh($));
    await measure($).catch(() => undefined);
    return next(e);
  });

  // /clear and /resume end a conversation, not the session the mod runs in.
  on("session.end", async ($, e, next) => {
    forget();
    if (e.reason !== "clear" && e.reason !== "resume") await beat($, true).catch(() => undefined);
    return next(e);
  });

  // After compaction the conversation is new to every model's cache.
  on("session.compact", async ($, e, next) => {
    forget();
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    await take($, { context: e.context, rateLimits: e.rateLimits, cost: e.cost }).catch(
      () => undefined,
    );
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    await measure($).catch(() => undefined);
    state.turn = {
      startUsd: state.usage?.cost?.usd ?? 0,
      startPct: fiveHour(state.usage?.rateLimits)?.percentUsed,
      calls: 0,
      held: 0,
    };
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    const req = {
      cwd: state.root,
      model: e.model,
      subagent: e.agentId !== undefined,
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
    };
    const list = state.paused ? [] : await switches($).catch(() => []);
    const sw = switchFor(list, req);
    const model = sw && !state.refused.has(sw.to) ? sw : undefined;
    const ef = model ? undefined : effortFor(list, req);
    const effort = ef && !state.refused.has(`effort:${ef.effort}`) ? ef : undefined;
    const o = model ?? effort;
    if (!o) {
      const r = yield* next(e);
      await counted($);
      return r;
    }

    // Stream the switched request through by hand, to know whether any of it
    // arrived before deciding it failed.
    const stream = next(
      model ? { ...e, model: model.to } : { ...e, effort: o.effort as TurnStepInput["effort"] },
    );
    let arrived = false;
    let result: TurnStepResult | undefined;
    try {
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          result = step.value;
          break;
        }
        arrived = true;
        yield step.value;
      }
    } catch (err) {
      if (arrived || next.signal.aborted) throw err;
    }
    if (result && (arrived || !failed(result, next.signal.aborted))) {
      state.applied.set(slotOf(o), o);
      if (model && result.usage) {
        const first = !state.convo.loaded.has(model.to);
        state.convo.loaded.add(model.to);
        const saved = savedBy(model, result.usage, first);
        if (saved !== null) state.saved = (state.saved ?? 0) + saved;
        if (state.turn && saved !== null) state.turn.saved = (state.turn.saved ?? 0) + saved;
      }
      if (state.turn && model) state.turn.switched = model;
      if (state.turn && !model) state.turn.effort = o.effort;
      if (!state.told.has(slotOf(o))) {
        state.told.add(slotOf(o));
        $.ui.log(switchNote(o));
      }
      await counted($);
      return result;
    }

    // Refused before a word came back: send the request as it was, and leave
    // this target alone for the rest of the session.
    state.refused.add(model ? model.to : `effort:${o.effort}`);
    void $.ui.toast(
      model
        ? `optimAIzr: ${modelLabel(model.to)} was refused, staying on ${modelLabel(e.model)}`
        : `optimAIzr: ${o.effort} effort was refused, staying at ${String(e.effort)}`,
    );
    const r = yield* next(e);
    await counted($);
    return r;
  });

  on("tool.call", async ($, e, next) => {
    const agent = e.agentId ?? "main";
    const c = state.convo;

    if (retryGuard && e.tool === "Bash") {
      const key = commandKey(agent, e.command);
      if ((c.fails.get(key) ?? 0) >= RETRY_LIMIT && !c.waived.has(key)) {
        c.waived.add(key);
        state.held += 1;
        if (state.turn) state.turn.held += 1;
        $.ui.log(
          `Held a retry of \`${clip(e.command.trim())}\`: it failed twice in a row with nothing changed in between.`,
        );
        return {
          deny:
            "optimAIzr held this retry: the same command failed twice in a row and nothing has changed since. " +
            "Change something first (the command, the code or the setup), or tell the user what is blocking you. " +
            "If it must run unchanged, run it again and it will go through.",
        };
      }
    }

    const ran = await next(e);
    const ok = ran.deny === undefined && ran.isError !== true;
    if (e.tool === "Bash" && ran.isError === true) {
      const key = commandKey(agent, e.command);
      c.fails.set(key, (c.fails.get(key) ?? 0) + 1);
    }
    if (ok && MUTATING.has(e.tool)) {
      c.fails.clear();
      c.waived.clear();
    }
    return ran;
  });

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId !== undefined) return r;
    const t = state.turn;
    state.turn = null;
    void $.ui.invalidate("ui.render");
    if (!showTurnLine || !t || e.reason !== "answer") return r;

    await measure($).catch(() => undefined);
    const spent = (state.usage?.cost?.usd ?? 0) - t.startUsd;
    if (spent < 0.005) return r;
    const after = fiveHour(state.usage?.rateLimits)?.percentUsed;
    const line = turnLine({
      usd: spent,
      calls: t.calls,
      ...(t.switched
        ? {
            switched: {
              from: modelLabel(t.switched.from),
              to: modelLabel(t.switched.to),
              saved: t.saved ?? null,
            },
          }
        : {}),
      ...(t.effort ? { effort: t.effort } : {}),
      held: t.held,
      ...(t.startPct !== undefined ? { before: t.startPct } : {}),
      ...(after !== undefined ? { after } : {}),
    });
    return { ...r, text: line };
  });

  on("ui.render", { component: "Spinner" }, async ($, e, next) => {
    const t = state.turn;
    const extra = meterText({
      usd: t ? (state.usage?.cost?.usd ?? 0) - t.startUsd : null,
      five: fiveHour(state.usage?.rateLimits),
      ...(t?.switched ? { model: modelLabel(t.switched.to) } : {}),
      ...(t?.saved !== undefined ? { saved: t.saved } : {}),
    });
    if (!extra) return next(e);
    return next({ ...e, props: { ...e.props, suffix: `${extra}${e.props.suffix}` } });
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const u = state.usage;
    if (e.props.hasSurvey || !u) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const five = fiveHour(u.rateLimits);
    const lines = switchLines(activeSwitches());
    const wide = e.props.bodyColumns >= 72;

    // Off a plan there is no window: the session's spend is the real bill.
    if (!five) {
      const spent = u.cost?.usd ?? 0;
      if (spent < 0.01 && lines.length === 0) return next(e);
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="blue" bold>
              optimAIzr
            </Text>
            <Text dimColor>{`  ${usd(spent)} this session`}</Text>
          </Box>
          {lines[0] !== undefined && <Text dimColor>{lines[0]}</Text>}
          {lines[1] !== undefined && <Text dimColor>{lines[1]}</Text>}
        </Box>
      );
    }

    const [filled, empty] = bar(five.percentUsed, 16);
    const week = sevenDay(u.rateLimits);
    const note = wide ? windowNote(five, state.window, await $.clock.now()) : "";
    const weekNote = week && week.percentUsed >= 75 ? ` · 7d ${percent(week.percentUsed)}` : "";
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="blue" bold>
            optimAIzr
          </Text>
          <Text>{"  "}</Text>
          {wide && <Text color="blue">{filled}</Text>}
          {wide && <Text dimColor>{`${empty}  `}</Text>}
          <Text>{`${percent(five.percentUsed)} of 5h`}</Text>
          <Text dimColor>{`${note}${weekNote}`}</Text>
        </Box>
        {lines[0] !== undefined && <Text dimColor>{lines[0]}</Text>}
        {lines[1] !== undefined && <Text dimColor>{lines[1]}</Text>}
      </Box>
    );
  });

  on("command.run", { command: "optimaizr" }, async ($, e) => {
    const list = await switches($).catch(() => []);
    const here = list.filter((o) => inProject(state.root, o.project));
    const arg = e.args.trim().toLowerCase();
    if (arg === "off" || arg === "on") {
      state.paused = arg === "off";
      void $.ui.invalidate("ui.render");
      return { text: pauseText(here, state.paused) };
    }
    if (arg) return { text: "Use /optimaizr, /optimaizr off or /optimaizr on." };

    await measure($).catch(() => undefined);
    const u = state.usage;
    return {
      text: summary({
        ...(u?.cost ? { usd: u.cost.usd } : {}),
        requests: state.requests,
        startedAt: state.startedAt,
        limits: u?.rateLimits ?? [],
        ...(state.window ? { window: state.window } : {}),
        now: await $.clock.now(),
        switches: here,
        paused: state.paused,
        ...(state.saved !== undefined ? { saved: state.saved } : {}),
        held: state.held,
      }),
    };
  });
};

/** Switches that moved a request here and are still in overrides.json. */
function activeSwitches(): Override[] {
  return [...state.applied.values()].filter((a) =>
    state.overrides.some((o) => slotOf(o) === slotOf(a) && o.to === a.to),
  );
}

/** The band's lines under the window: the model switch, then the effort switch. */
function switchLines(applied: readonly Override[]): string[] {
  const back = state.paused ? "/optimaizr on to switch again" : "harder task? /optimaizr off";
  const saved =
    !state.paused && state.saved !== undefined && state.saved >= 0.005
      ? ` · saved ${usd(state.saved)}`
      : "";
  const lines: string[] = [];
  const model = applied.find((o) => !o.effort);
  if (model) {
    lines.push(
      `${state.paused ? "paused  " : "switched"}  ${describeSwitch(model)}${saved} · ${back}`,
    );
  }
  const effort = applied.find((o) => o.effort);
  if (effort) {
    lines.push(`${state.paused ? "paused  " : "effort  "}  ${describeSwitch(effort)} · ${back}`);
  }
  return lines;
}

/** The line left in the conversation the first time a switch moves a request. */
function switchNote(o: Override): string {
  const who = o.subagent === true ? "this session's subagents" : "this session";
  if (o.effort) {
    return (
      `Lowered ${who} to ${o.effort} effort on ${modelLabel(o.from)} (${o.rule}). ` +
      `Harder task? /optimaizr off goes back to its own effort.`
    );
  }
  return (
    `Switched ${who} from ${modelLabel(o.from)} to ${modelLabel(o.to)} (${o.rule}). ` +
    `Harder task? /optimaizr off goes back to ${modelLabel(o.from)}.`
  );
}

function pauseText(here: readonly Override[], paused: boolean): string {
  const o = here.find((x) => !x.effort) ?? here[0];
  if (!o) return "No switch is active in this project.";
  if (o.effort) {
    return paused
      ? `Switches are off for this session: requests use their own effort again. ` +
          `/optimaizr on lowers it to ${o.effort} again; optimaizr undo ${o.rule} removes it everywhere.`
      : `Switches are on again for this session: requests use ${o.effort} effort.`;
  }
  return paused
    ? `Switches are off for this session: requests go to ${modelLabel(o.from)} again. ` +
        `/optimaizr on switches back to ${modelLabel(o.to)}; ` +
        `optimaizr undo ${o.rule} removes it everywhere.`
    : `Switches are on again for this session: requests go to ${modelLabel(o.to)}.`;
}
