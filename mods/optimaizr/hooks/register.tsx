import type {
  EngineInterface,
  Register,
  SessionUsage,
  TurnStepInput,
  TurnStepResult,
} from "claude-code";
import {
  bar,
  costAt,
  crossed,
  describeSwitch,
  effortFor,
  fiveHour,
  inProject,
  isWindow,
  meterColor,
  meterText,
  modelLabel,
  type Override,
  parseOverrides,
  PAYBACK_REQUESTS,
  paybackRequests,
  percent,
  record,
  reloadCost,
  SAVED_MILESTONES,
  savedBy,
  sevenDay,
  share,
  sparkline,
  summary,
  switchFor,
  turnLine,
  usd,
  type Tokens,
  type Window,
  WINDOW_ALERTS,
  windowNote,
  windowShare,
  windowsOf,
} from "./meter.ts";

// The optimAIzr mod: this turn's cost and the 5-hour window while Claude works,
// one line under each answer, the model and effort switches `optimaizr live`
// accepts, and a guard against retry loops. It reads usage figures and the
// commands Claude runs, never prompt text or file contents.

const VERSION = "0.9.0";
// The HUD /optimaizr hud opens beside the conversation.
const PANE = "optimaizr";
// overrides.json is read again at most this often, so `optimaizr undo` lands fast.
const REREAD_MS = 3_000;
// `optimaizr live` counts a session as gone after three missed beats.
const BEAT_MS = 60_000;
// Claude Code caches the main conversation for an hour; after that a reload is paid either way.
const CACHE_TTL_MS = 55 * 60_000;
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
  // The session's average unswitched main request, which a switch is weighed against.
  avg: { n: 0, input: 0, output: 0, read: 0, write: 0 },
  // When the main conversation last made a request; past the cache's lifetime, it reloads anyway.
  lastMainAt: null as number | null,
  // A main-conversation switch held back because its reload wouldn't pay back yet.
  waiting: null as { o: Override; reload: number; payback: number } | null,
  // Token totals since the mod loaded, for the cache-hit share.
  tokens: { input: 0, read: 0, write: 0 },
  // What switched requests cost, and what they would have cost unswitched.
  switchedWas: 0,
  switchedIs: 0,
  // Session cost and 5-hour reading when the mod loaded, for the burn rate and window share.
  startUsd: null as number | null,
  startPct: null as number | null,
  // What each finished turn cost, newest last, for the pane's sparkline.
  turnCosts: [] as number[],
  // Window levels already toasted, by reset time.
  warned: new Set<string>(),
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
  const was = fiveHour(state.usage?.rateLimits)?.percentUsed;
  state.usage = u;
  const five = fiveHour(u.rateLimits);
  if (five && was !== undefined) {
    const level = crossed(WINDOW_ALERTS, was, five.percentUsed);
    const key = `${five.resetsAt ?? ""}:${level}`;
    if (level !== null && !state.warned.has(key)) {
      state.warned.add(key);
      void $.ui.toast(
        `optimAIzr: 5h window at ${percent(five.percentUsed)}${windowNote(five, state.window, await $.clock.now())}`,
        { timeoutMs: 8_000 },
      );
    }
  }
  // The CLI reads the meters from the session file, so a move is written at once.
  if (five && five.percentUsed !== was) await beat($).catch(() => undefined);
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
  const at = await $.clock.now();
  const now = new Date(at).toISOString();
  const windows = windowsOf(state.usage?.rateLimits, at);
  const body = {
    id: state.id,
    version: VERSION,
    cwd: state.root,
    startedAt: new Date(state.startedAt).toISOString(),
    seenAt: now,
    ...(ended ? { endedAt: now } : {}),
    ...(windows ? { windows } : {}),
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

/** Fold an unswitched main request into the session's average. */
function learn(u: Tokens): void {
  const a = state.avg;
  a.n += 1;
  a.input += (u.input_tokens - a.input) / a.n;
  a.output += (u.output_tokens - a.output) / a.n;
  a.read += (u.cache_read_input_tokens - a.read) / a.n;
  a.write += (u.cache_creation_input_tokens - a.write) / a.n;
}

/** The average request, or a modest one before there is any to go on. */
function average(contextTokens: number): Tokens {
  const a = state.avg;
  return a.n > 0
    ? {
        input_tokens: a.input,
        output_tokens: a.output,
        cache_read_input_tokens: a.read,
        cache_creation_input_tokens: a.write,
      }
    : {
        input_tokens: 0,
        output_tokens: 500,
        cache_read_input_tokens: contextTokens,
        cache_creation_input_tokens: 1_000,
      };
}

/** Count a finished request and refresh the figures the spinner shows. */
async function counted($: Api, u?: Tokens | null): Promise<void> {
  if (u) {
    state.tokens.input += u.input_tokens;
    state.tokens.read += u.cache_read_input_tokens;
    state.tokens.write += u.cache_creation_input_tokens;
  }
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
      description:
        "This session's spend, savings and plan windows; hud opens the HUD, off or on pauses a switch",
      argumentHint: "[off|on]",
      immediate: true,
    });
    await beat($).catch(() => undefined);
    $.clock.every(BEAT_MS, () => void refresh($));
    await measure($).catch(() => undefined);
    state.startUsd = state.usage?.cost?.usd ?? null;
    state.startPct = fiveHour(state.usage?.rateLimits)?.percentUsed ?? null;
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
    let model = sw && !state.refused.has(sw.to) ? sw : undefined;

    // A conversation under way switches only once reloading it pays back soon.
    // Subagents start with an empty cache, so they always switch.
    const now = await $.clock.now();
    const cold = state.lastMainAt !== null && now - state.lastMainAt > CACHE_TTL_MS;
    if (model && e.agentId === undefined && !state.convo.loaded.has(model.to) && !cold) {
      const context = state.usage?.context.tokens ?? 0;
      const payback = paybackRequests(model, context, average(context));
      if (payback > PAYBACK_REQUESTS) {
        state.waiting = { o: model, reload: reloadCost(model, context) ?? 0, payback };
        model = undefined;
      } else {
        state.waiting = null;
      }
    }
    if (e.agentId === undefined) state.lastMainAt = now;
    const ef = model ? undefined : effortFor(list, req);
    const effort = ef && !state.refused.has(`effort:${ef.effort}`) ? ef : undefined;
    const o = model ?? effort;
    if (!o) {
      const r = yield* next(e);
      // A request that rewrote an expired cache would make every request look costly.
      if (e.agentId === undefined && r.usage && !cold) learn(r.usage);
      await counted($, r.usage);
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
        // Only a warm main conversation has a cache to reload; a subagent, or a
        // conversation idle past the cache's lifetime, writes it on either model.
        const main = e.agentId === undefined;
        const first = main && !cold && !state.convo.loaded.has(model.to);
        if (main) state.convo.loaded.add(model.to);
        const saved = savedBy(model, result.usage, first, e.agentId === undefined);
        const was = costAt(model.from, result.usage, { warm: first, hour: main });
        const is = costAt(model.to, result.usage, { hour: main });
        if (was !== null && is !== null) {
          state.switchedWas += was;
          state.switchedIs += is;
        }
        const before = state.saved ?? 0;
        if (saved !== null) state.saved = before + saved;
        const milestone = crossed(SAVED_MILESTONES, before, state.saved ?? 0);
        if (milestone !== null) {
          void $.ui.toast(`optimAIzr: saved ${usd(state.saved ?? 0)} this session by switching`, {
            timeoutMs: 6_000,
          });
        }
        if (state.turn && saved !== null) state.turn.saved = (state.turn.saved ?? 0) + saved;
      }
      if (state.turn && model) state.turn.switched = model;
      if (state.turn && !model) state.turn.effort = o.effort;
      // Subagents and the main conversation are told apart: either can switch first.
      const sub = e.agentId !== undefined;
      const told = `${slotOf(o)}\u0000${sub ? "sub" : "main"}`;
      if (!state.told.has(told)) {
        state.told.add(told);
        $.ui.log(switchNote(o, sub));
        if (o.auto) {
          void $.ui.toast(
            `optimAIzr: ${o.effort ? `lowered effort to ${o.effort}` : `switched to ${modelLabel(o.to)}`} automatically · p or /optimaizr off undoes`,
            { timeoutMs: 8_000 },
          );
        }
      }
      await counted($, result.usage);
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
    if (!t || e.reason !== "answer") return r;

    await measure($).catch(() => undefined);
    const spent = (state.usage?.cost?.usd ?? 0) - t.startUsd;
    state.turnCosts = [...state.turnCosts, Math.max(0, spent)].slice(-24);
    if (!showTurnLine || spent < 0.005) return r;
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
    const waiting = waitingNote();
    const lines = [...switchLines(activeSwitches()), ...(waiting ? [waiting] : [])];
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
          {wide && <Text color={meterColor(five.percentUsed)}>{filled}</Text>}
          {wide && <Text dimColor>{`${empty}  `}</Text>}
          <Text color={meterColor(five.percentUsed)} bold>
            {percent(five.percentUsed)}
          </Text>
          <Text>{" of 5h"}</Text>
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
    // "pane" was its first name; it still works.
    if (arg === "hud" || arg === "pane") {
      await $.ui.open({ id: PANE, title: "optimAIzr HUD", focus: true });
      return { text: "Opened the optimAIzr HUD. Esc closes it." };
    }
    if (arg) return { text: "Use /optimaizr, /optimaizr hud, /optimaizr off or /optimaizr on." };

    await measure($).catch(() => undefined);
    const u = state.usage;
    const waiting = waitingNote();
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
        turns: state.turnCosts,
        ...(waiting ? { note: waiting } : {}),
      }),
    };
  });

  // The session at a glance: /optimaizr hud.
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const u = state.usage;
    const five = fiveHour(u?.rateLimits);
    const week = sevenDay(u?.rateLimits);
    const now = await $.clock.now();
    const cols = e.props.bodyColumns;
    const width = Math.max(8, Math.min(24, cols - 22));

    const status = hudStatus();
    const saved = state.saved !== undefined && state.saved > 0 ? state.saved : 0;
    const cheaper =
      state.switchedWas > 0 ? Math.round((1 - state.switchedIs / state.switchedWas) * 100) : null;
    const spent = u?.cost ? u.cost.usd : null;
    // The rate covers what this mod has watched, from when it loaded.
    const hours = (now - state.startedAt) / 3_600_000;
    const rate =
      spent !== null && state.startUsd !== null && hours >= 1 / 30
        ? (spent - state.startUsd) / hours
        : null;
    const t = state.tokens;
    const ofWindow =
      five && spent !== null && state.startUsd !== null && state.startPct !== null
        ? windowShare(saved, {
            usd: spent - state.startUsd,
            pct: five.percentUsed - state.startPct,
          })
        : null;
    const cacheHits = t.input + t.read + t.write > 0 ? t.read / (t.input + t.read + t.write) : null;

    const gauge = (label: string, pct: number, note: string) => (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{`${label}  `}</Text>
          <Text color={meterColor(pct)}>{bar(pct, width)[0]}</Text>
          <Text dimColor>{bar(pct, width)[1]}</Text>
          <Text color={meterColor(pct)} bold>{`  ${percent(pct)}`}</Text>
        </Box>
        {note && <Text dimColor>{`    ${note}`}</Text>}
      </Box>
    );
    const turns = state.turnCosts;
    const top = Math.max(...turns, 0);
    const priciest = turns.indexOf(top) + 1;
    const lines = switchLines(activeSwitches());
    const waiting = waitingNote();
    const switchable = activeSwitches().length > 0 || waiting !== null;

    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text color="blue" bold>
            optimAIzr
          </Text>
          <Text color={status.color} bold>{`   ● ${status.text}`}</Text>
        </Box>

        <Box flexDirection="column">
          {state.switchedWas === 0 ? (
            <Text dimColor>no switch yet · press Y in optimaizr live</Text>
          ) : (state.saved ?? 0) < 0 ? (
            <Text color="yellow">{`reload ${usd(-(state.saved ?? 0))} not won back yet`}</Text>
          ) : (
            <Box>
              <Text color="green" bold>{`saved ${usd(saved)}`}</Text>
              {cheaper !== null && cheaper > 0 && (
                <Text color="green">{`  ${cheaper}% cheaper`}</Text>
              )}
              {ofWindow !== null && (
                <Text color="green">{`  ≈${share(ofWindow)} of your 5h window`}</Text>
              )}
            </Box>
          )}
          <Text dimColor>
            {[
              spent !== null ? `spent ${usd(spent)}` : null,
              rate !== null ? `${usd(rate)}/h` : null,
              `${state.requests} requests`,
              cacheHits !== null ? `cache ${percent(cacheHits * 100)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </Box>

        {five && gauge("5h", five.percentUsed, paceNote(five, now))}
        {week && gauge("7d", week.percentUsed, "")}

        {turns.length > 1 && (
          <Box flexDirection="column">
            <Box>
              <Text dimColor>{"turns  "}</Text>
              {turns.map((v) => (
                <Text
                  color={v / (top || 1) > 0.66 ? "red" : v / (top || 1) > 0.33 ? "yellow" : "green"}
                >
                  {sparkline([v, top]).charAt(0)}
                </Text>
              ))}
            </Box>
            <Text dimColor>{`    priciest #${priciest} ${usd(top)} · last ${turns.length}`}</Text>
          </Box>
        )}

        {lines[0] !== undefined && <Text>{lines[0]}</Text>}
        {lines[1] !== undefined && <Text>{lines[1]}</Text>}
        {waiting && <Text color="yellow">{waiting}</Text>}
        {state.held > 0 && (
          <Text
            dimColor
          >{`guard  ${state.held} ${state.held === 1 ? "retry" : "retries"} held`}</Text>
        )}

        <Box gap={2}>
          {switchable && (
            <Button
              key="pause"
              label={state.paused ? "resume switch" : "pause switch"}
              hotkey="p"
              onPress={() => {
                state.paused = !state.paused;
                void $.ui.invalidate("ui.render");
              }}
            />
          )}
          <Text dimColor>Esc closes</Text>
        </Box>
      </Box>
    );
  });
};

/** The pill at the top of the HUD: what the mod is doing right now. */
function hudStatus(): { text: string; color: string } {
  if (state.paused) return { text: "paused", color: "yellow" };
  if (waitingNote()) return { text: "waiting", color: "yellow" };
  const model = activeSwitches().find((o) => !o.effort);
  if (model) {
    return { text: `on ${modelLabel(model.to)}${model.auto ? " (auto)" : ""}`, color: "green" };
  }
  const effort = activeSwitches().find((o) => o.effort);
  if (effort) return { text: `${effort.effort} effort`, color: "green" };
  return { text: "watching", color: "blue" };
}

/** The 5-hour window's outlook: when it runs out at this pace, or that it lasts. */
function paceNote(
  five: { resetsAt?: string; percentUsed: number; kind: string },
  now: number,
): string {
  const note = windowNote(five, state.window, now).replace(/^ · /, "");
  return note.startsWith("lasts") ? `${note} ✓` : note;
}

/** Why a switch for this conversation is waiting, if one is. */
function waitingNote(): string | null {
  const w = state.waiting;
  if (!w || state.paused || state.convo.loaded.has(w.o.to)) return null;
  const back = Number.isFinite(w.payback)
    ? `pays back in ~${Math.ceil(w.payback)} requests`
    : "would not pay back";
  return `waiting   ${describeSwitch(w.o)} · reload ${usd(w.reload)} ${back} · subagents switch now`;
}

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
  // While the main conversation waits, the waiting line says what subagents do.
  const model = waitingNote() ? undefined : applied.find((o) => !o.effort);
  if (model) {
    lines.push(
      `${state.paused ? "paused  " : "switched"}  ${describeSwitch(model)}${model.auto ? " (auto)" : ""}${saved} · ${back}`,
    );
  }
  const effort = applied.find((o) => o.effort);
  if (effort) {
    lines.push(`${state.paused ? "paused  " : "effort  "}  ${describeSwitch(effort)} · ${back}`);
  }
  return lines;
}

/** The line left in the conversation the first time a switch moves a request. */
function switchNote(o: Override, sub: boolean): string {
  const who = sub || o.subagent === true ? "this session's subagents" : "this session";
  const how = o.auto ? `${o.rule}, automatically` : o.rule;
  if (o.effort) {
    return (
      `Lowered ${who} to ${o.effort} effort on ${modelLabel(o.from)} (${how}). ` +
      `Harder task? /optimaizr off goes back to its own effort.`
    );
  }
  return (
    `Switched ${who} from ${modelLabel(o.from)} to ${modelLabel(o.to)} (${how}). ` +
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
