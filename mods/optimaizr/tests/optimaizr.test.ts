import type { On, RenderInput, SessionUsage } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

const DIR = "/home/me/.optimaizr";
const CWD = "/work/shop-api";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const MINUTE = 60_000;
// Far after the mock clock's start, so the window never resets mid-test.
const RESETS = "2030-01-01T01:00:00.000Z";

type Usage = { usd: number; pct?: number; ctx?: number };

/**
 * A session in /work/shop-api: files in a map, usage the test sets, and a
 * model that answers every request unless `refuses` names it.
 */
type Tokens = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const TOKENS: Tokens = {
  input_tokens: 10,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function world(
  on: On,
  opts: { files?: Record<string, string>; refuses?: string; tokens?: Tokens } = {},
) {
  const files = new Map(Object.entries(opts.files ?? {}));
  const sent: string[] = [];
  const efforts: unknown[] = [];
  const tools: string[] = [];
  const logs: string[] = [];
  const toasts: string[] = [];
  const opened: string[] = [];
  const now: Usage = { usd: 1, pct: 58 };
  const usage = (): SessionUsage => ({
    context: { window: 1_000_000, ...(now.ctx !== undefined ? { tokens: now.ctx } : {}) },
    rateLimits:
      now.pct === undefined ? [] : [{ kind: "five_hour", percentUsed: now.pct, resetsAt: RESETS }],
    cost: { usd: now.usd },
  });

  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.id", () => ({ value: "s1" }));
  on("session.root", () => ({ value: CWD }));
  on("session.usage", () => ({ value: usage() }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("fs.read", ($, e) =>
    files.has(e.path) ? { value: files.get(e.path)! } : { deny: `ENOENT ${e.path}` },
  );
  on("fs.write", ($, e) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", ($, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.open", ($, e) => {
    opened.push(e.id);
    return { value: undefined };
  });
  on("ui.log", ($, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("session.measure", ($, e) => ({ changed: e.changed }));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", ($, e) => ({ text: e.answer }));
  // A model that answers whole, with nothing to stream.
  // eslint-disable-next-line require-yield
  on("turn.step", async function* ($, e) {
    sent.push(e.model);
    efforts.push(e.effort);
    const refused = e.model === opts.refuses;
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: refused ? null : "end_turn",
      usage: refused ? null : { ...(opts.tokens ?? TOKENS), model: e.model },
    };
  });
  // `npm test` always fails; every other tool call succeeds.
  on("tool.call", ($, e) => {
    const a = e as unknown as Record<string, string>;
    tools.push(`${e.tool} ${a.command ?? a.pattern ?? a.url ?? a.file_path ?? ""}`);
    return e.tool === "Bash" && a.command === "npm test"
      ? { isError: true as const, result: "1 failing" }
      : { result: "ok" as never };
  });
  on("ui.render", { component: "Spinner" }, ($, e) => ({
    type: "Text",
    children: [`${e.props.word}${e.props.suffix}`],
  }));
  on("ui.render", { component: "AbovePrompt" }, () => ({ type: "Box", children: [] }));
  mock.store(on, {});
  mock.env(on, { HOME: "/home/me" });
  const clock = mock.clock(on, { now: 0 });

  return { files, sent, efforts, tools, logs, toasts, opened, now, usage, clock };
}

const SESSION = { surface: "terminal", isInteractive: true, cwd: CWD } as const;

const overrides = (...list: object[]) =>
  JSON.stringify({
    version: 1,
    overrides: list.map((o) => ({ rule: "model-fit", at: "x", ...o })),
  });

async function step($: Engine, model = OPUS, agentId?: string, effort?: "low" | "xhigh") {
  const stream = $.turn.step({
    turnId: "t1",
    index: 0,
    model,
    messageCount: 3,
    ...(agentId ? { agentId } : {}),
    ...(effort ? { effort } : {}),
  });
  // Read to the end by hand: the return value is the step's result.
  for (;;) {
    const n = await stream.next();
    if (n.done) return n.value;
  }
}

function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (typeof tree !== "object" || !tree) return "";
  return textOf(Reflect.get(tree, "children") ?? []);
}

const spinner: RenderInput<"Spinner"> = {
  component: "Spinner",
  surface: "terminal",
  requestId: "main",
  props: { word: "Thinking", message: null, suffix: "…", mode: "thinking" },
};

const band = (bodyColumns = 120): RenderInput<"AbovePrompt"> => ({
  component: "AbovePrompt",
  surface: "terminal",
  requestId: "band",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
});

test("the session file tells optimaizr live the mod is running", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  const file = `${DIR}/mod/sessions/s1.json`;
  const beat = JSON.parse(w.files.get(file)!);
  expect(beat).toMatchObject({ id: "s1", version: "0.10.1", cwd: CWD });
  expect(beat.endedAt).toBeUndefined();

  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  expect(JSON.parse(w.files.get(file)!).endedAt).toBeUndefined();

  await $.session.end({ reason: "prompt_input_exit", sessionId: "s1", resume: { id: "s1" } });
  expect(typeof JSON.parse(w.files.get(file)!).endedAt).toBe("string");
});

test("the session file carries Claude Code's meters, rewritten when they move", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  const file = `${DIR}/mod/sessions/s1.json`;
  expect(JSON.parse(w.files.get(file)!).windows).toMatchObject({
    fiveHour: { percentUsed: 58, resetsAt: RESETS },
  });

  await $.session.measure({
    ...w.usage(),
    rateLimits: [
      { kind: "five_hour", percentUsed: 61, resetsAt: RESETS },
      { kind: "seven_day", percentUsed: 30 },
    ],
    changed: ["rateLimits"],
  });
  const beat = JSON.parse(w.files.get(file)!);
  expect(beat.windows.fiveHour.percentUsed).toBe(61);
  expect(beat.windows.sevenDay).toEqual({ percentUsed: 30 });
  expect(typeof beat.windows.at).toBe("string");
});

test("off a plan the session file has no meters", async ($, on) => {
  const w = world(on);
  w.now.pct = undefined;
  await $.session.start(SESSION);
  expect(JSON.parse(w.files.get(`${DIR}/mod/sessions/s1.json`)!).windows).toBeUndefined();
});

test("a switch moves the next request in its project, and nothing else", async ($, on) => {
  const w = world(on, {
    files: {
      [`${DIR}/overrides.json`]: overrides(
        { source: "claude-code", project: CWD, from: OPUS, to: SONNET },
        // wrap() entries and other projects are not Claude Code's to apply here.
        { project: CWD, from: "claude-haiku-4-5", to: SONNET },
        { source: "claude-code", project: "/work/other", from: "claude-opus-5", to: SONNET },
      ),
    },
  });
  await $.session.start(SESSION);

  await step($, OPUS);
  await step($, `${OPUS}[1m]`);
  await step($, "claude-haiku-4-5");
  await step($, "claude-opus-5");
  expect(w.sent).toEqual([SONNET, SONNET, "claude-haiku-4-5", "claude-opus-5"]);
});

test("a switch for subagents leaves the main conversation alone", async ($, on) => {
  const w = world(on, {
    files: {
      [`${DIR}/overrides.json`]: overrides({
        source: "claude-code",
        project: CWD,
        subagent: true,
        from: OPUS,
        to: SONNET,
      }),
    },
  });
  await $.session.start(SESSION);

  await step($, OPUS);
  await step($, OPUS, "agent-1");
  expect(w.sent).toEqual([OPUS, SONNET]);
});

test("a refused model falls back to the original and is not tried again", async ($, on) => {
  const w = world(on, {
    refuses: SONNET,
    files: {
      [`${DIR}/overrides.json`]: overrides({
        source: "claude-code",
        project: CWD,
        from: OPUS,
        to: SONNET,
      }),
    },
  });
  await $.session.start(SESSION);

  const r = await step($, OPUS);
  expect(r.stopReason).toBe("end_turn");
  await step($, OPUS);
  expect(w.sent).toEqual([SONNET, OPUS, OPUS]);
});

test("optimaizr undo reaches a running session within seconds", async ($, on) => {
  const file = `${DIR}/overrides.json`;
  const w = world(on, {
    files: { [file]: overrides({ source: "claude-code", project: CWD, from: OPUS, to: SONNET }) },
  });
  await $.session.start(SESSION);
  await step($, OPUS);

  w.files.set(file, overrides());
  await w.clock.advance(5_000);
  await step($, OPUS);
  expect(w.sent).toEqual([SONNET, OPUS]);
});

test("the spinner shows the turn so far and the 5-hour window", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  await $.turn.start({ text: "add rate limiting", turnId: "t1" });
  w.now.usd = 1.18;
  w.now.pct = 61;
  await step($);

  expect(textOf(await $.ui.render(spinner))).toBe("Thinking · $0.18 · 61% of 5h…");
});

test("the band shows the window, the pace and when it resets", async ($, on) => {
  const w = world(on);
  w.now.pct = 40;
  await $.session.start(SESSION);
  await w.clock.advance(30 * MINUTE);
  await $.session.measure({
    ...w.usage(),
    rateLimits: [{ kind: "five_hour", percentUsed: 50, resetsAt: RESETS }],
    changed: ["rateLimits"],
  });

  const wide = textOf(await $.ui.render(band()));
  expect(wide).toContain("optimAIzr");
  expect(wide).toContain("50% of 5h");
  // 10 points in 30 minutes leaves 50 points: 2h 30m.
  expect(wide).toContain("~2h 30m left at this pace");
  expect(wide).toContain("resets ");

  const narrow = textOf(await $.ui.render(band(60)));
  expect(narrow).toContain("50% of 5h");
  expect(narrow).not.toContain("left at this pace");
});

test("off a plan the band shows what the session has cost", async ($, on) => {
  const w = world(on);
  w.now.pct = undefined;
  w.now.usd = 3.5;
  await $.session.start(SESSION);

  expect(textOf(await $.ui.render(band()))).toContain("$3.50 this session");
});

test("each answer gets one line with what the turn cost", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  await $.turn.start({ text: "add rate limiting", turnId: "t1" });
  w.now.usd = 1.42;
  w.now.pct = 61;
  await step($);

  const done = await $.turn.complete({
    answer: "Done.",
    durationMs: 14_000,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  expect(done.text).toBe("this turn $0.42 · 1 request · 5h 58% → 61%");

  const sub = await $.turn.complete({
    answer: "Subagent done.",
    durationMs: 1_000,
    isAborted: false,
    turnId: "t2",
    agentId: "agent-1",
    reason: "answer",
  });
  expect(sub.text).toBe("Subagent done.");
});

test("/optimaizr prints the session's figures and its switches", async ($, on) => {
  world(on, {
    files: {
      [`${DIR}/overrides.json`]: overrides({
        source: "claude-code",
        project: CWD,
        subagent: true,
        from: OPUS,
        to: SONNET,
      }),
    },
  });
  await $.session.start(SESSION);
  await step($);

  const out = await $.command.run({
    command: "optimaizr",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
  expect(out.text).toContain("Spend      $1.00 at API rates over 1 request since");
  expect(out.text).toContain("5h window  58%");
  expect(out.text).toContain(
    "Switch     shop-api subagents: Opus 5.5 → Sonnet 5.5 · /optimaizr off here, optimaizr undo model-fit everywhere",
  );
});

const command = (args: string) => ({
  command: "optimaizr",
  args,
  origin: { kind: "composer" } as const,
  presentation: { isFullscreen: false, columns: 120 },
});

test("/optimaizr off sends this session back to its own model, on resumes", async ($, on) => {
  const w = world(on, {
    files: {
      [`${DIR}/overrides.json`]: overrides({
        source: "claude-code",
        project: CWD,
        from: OPUS,
        to: SONNET,
      }),
    },
  });
  await $.session.start(SESSION);
  await step($);

  const off = await $.command.run(command("off"));
  expect(off.text).toBe(
    "Switches are off for this session: requests go to Opus 5.5 again. /optimaizr on switches back to Sonnet 5.5; optimaizr undo model-fit removes it everywhere.",
  );
  await step($);
  expect(textOf(await $.ui.render(band()))).toContain("paused    shop-api: Opus 5.5 → Sonnet 5.5");

  await $.command.run(command("on"));
  await step($);
  expect(w.sent).toEqual([SONNET, OPUS, SONNET]);
});

test("the first switched request leaves one note on how to go back", async ($, on) => {
  const w = world(on, {
    files: {
      [`${DIR}/overrides.json`]: overrides({
        source: "claude-code",
        project: CWD,
        from: OPUS,
        to: SONNET,
      }),
    },
  });
  await $.session.start(SESSION);
  await step($);
  await step($);
  expect(w.logs).toEqual([
    "Switched this session from Opus 5.5 to Sonnet 5.5 (model-fit). Harder task? /optimaizr off goes back to Opus 5.5.",
  ]);
  expect(textOf(await $.ui.render(band()))).toContain(
    "switched  shop-api: Opus 5.5 → Sonnet 5.5 · harder task? /optimaizr off",
  );
});

test("after an undo the band stops saying switched", async ($, on) => {
  const file = `${DIR}/overrides.json`;
  const w = world(on, {
    files: { [file]: overrides({ source: "claude-code", project: CWD, from: OPUS, to: SONNET }) },
  });
  await $.session.start(SESSION);
  await step($);
  expect(textOf(await $.ui.render(band()))).toContain("switched");

  w.files.set(file, overrides());
  await w.clock.advance(61_000);
  expect(textOf(await $.ui.render(band()))).not.toContain("switched");
});

const switchTo = (to: string, more: object = {}) => ({
  [`${DIR}/overrides.json`]: overrides({
    source: "claude-code",
    project: CWD,
    from: OPUS,
    to,
    ...more,
  }),
});

const answered = ($: Engine) =>
  $.turn.complete({
    answer: "Done.",
    durationMs: 9_000,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });

test("a switched turn leads with what it saved", async ($, on) => {
  // 1,000 in and 10,000 out: $0.204 on Opus 5.5, $0.102 on Sonnet 5.5.
  const w = world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, input_tokens: 1_000, output_tokens: 10_000 },
  });
  await $.session.start(SESSION);
  await $.turn.start({ text: "rename the helpers", turnId: "t1" });
  w.now.usd = 1.1;
  await step($);

  expect(textOf(await $.ui.render(spinner))).toBe(
    "Thinking · Sonnet 5.5 · $0.10 · saved $0.10 · 58% of 5h…",
  );
  expect((await answered($)).text).toBe(
    "saved $0.10 vs Opus 5.5 · this turn $0.10 on Sonnet 5.5 · 1 request · 5h 58% → 58%",
  );
  expect(textOf(await $.ui.render(band()))).toContain(
    "switched  shop-api: Opus 5.5 → Sonnet 5.5 · saved $0.10 · harder task? /optimaizr off",
  );
});

test("the first request on a new model says when it costs more, and why", async ($, on) => {
  // The main conversation caches for an hour: 100,000 tokens written to Sonnet's
  // cache cost $0.40, where Opus would have read them for $0.02.
  const w = world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, cache_creation_input_tokens: 100_000 },
  });
  await $.session.start(SESSION);
  await $.turn.start({ text: "keep going", turnId: "t1" });
  w.now.usd = 1.4;
  await step($);
  expect((await answered($)).text).toBe(
    "this turn $0.40 on Sonnet 5.5 · 1 request · $0.38 more than Opus 5.5 once, to load the conversation · 5h 58% → 58%",
  );
});

test("a subagent has no reload to pay: both models write its cache, at the 5-minute rate", async ($, on) => {
  // 100,000 tokens written fresh: $0.50 on Opus 5.5, $0.25 on Sonnet 5.5.
  const w = world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, cache_creation_input_tokens: 100_000 },
  });
  await $.session.start(SESSION);
  await $.turn.start({ text: "keep going", turnId: "t1" });
  w.now.usd = 1.25;
  await step($, OPUS, "agent-1");
  expect((await answered($)).text).toContain("saved $0.25 vs Opus 5.5");
});
test("an effort switch lowers effort, and never raises it", async ($, on) => {
  const w = world(on, { files: switchTo(OPUS, { effort: "low" }) });
  await $.session.start(SESSION);
  await $.turn.start({ text: "tidy up", turnId: "t1" });
  w.now.usd = 1.08;
  await step($, OPUS, undefined, "xhigh");
  await step($, OPUS, undefined, "low");
  expect(w.sent).toEqual([OPUS, OPUS]);
  expect(w.efforts).toEqual(["low", "low"]);
  expect((await answered($)).text).toBe(
    "this turn $0.08 at low effort · 2 requests · 5h 58% → 58%",
  );
  expect(w.logs).toEqual([
    "Lowered this session to low effort on Opus 5.5 (model-fit). Harder task? /optimaizr off goes back to its own effort.",
  ]);
});

test("a command that failed twice unchanged is held once", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  const run = (command: string) => $.tool.call({ tool: "Bash", command });

  await run("npm test");
  await run("npm test");
  const held = await run("npm test");
  expect(held.deny).toContain("optimAIzr held this retry");
  expect(w.logs).toEqual([
    "Held a retry of `npm test`: it failed twice in a row with nothing changed in between.",
  ]);

  // Asked again, it goes through; after an edit the count starts over.
  await run("npm test");
  await $.tool.call({
    tool: "Edit",
    file_path: "/work/shop-api/a.ts",
    old_string: "a",
    new_string: "b",
  });
  await run("npm test");
  expect(w.tools.filter((t) => t === "Bash npm test")).toHaveLength(4);
});

test("after compaction a failing command starts its count over", async ($, on) => {
  const w = world(on);
  on("session.compact", () => ({ skip: "not in a test" }));
  await $.session.start(SESSION);
  const run = () => $.tool.call({ tool: "Bash", command: "npm test" });
  await run();
  await run();
  await $.session.compact({ trigger: "manual", messages: [] });
  await run();
  expect(w.tools.filter((t) => t === "Bash npm test")).toHaveLength(3);
});

test("/optimaizr adds up what was saved and held", async ($, on) => {
  world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, input_tokens: 1_000, output_tokens: 10_000 },
  });
  await $.session.start(SESSION);
  await step($);
  await step($);
  await $.tool.call({ tool: "Bash", command: "npm test" });
  await $.tool.call({ tool: "Bash", command: "npm test" });
  await $.tool.call({ tool: "Bash", command: "npm test" });

  const out = await $.command.run(command(""));
  expect(out.text).toContain(
    "Saved      $0.20 by switching models: the same tokens at the original model's rates, less what they cost",
  );
  expect(out.text).toContain("Guard      1 retry held");
});

test("a long conversation waits for its switch, and subagents switch now", async ($, on) => {
  // Reloading 100,000 tokens into Sonnet costs $0.38; an average request saves
  // about $0.009, so it would take over 40 requests to win back.
  const w = world(on, { files: switchTo(SONNET) });
  w.now.ctx = 100_000;
  await $.session.start(SESSION);
  await step($);
  await step($, OPUS, "agent-1");
  expect(w.sent).toEqual([OPUS, SONNET]);

  const drawn = textOf(await $.ui.render(band()));
  expect(drawn).toContain(
    "waiting   shop-api: Opus 5.5 → Sonnet 5.5 · reload $0.38 pays back in ~",
  );
  expect(drawn).toContain("subagents switch now");
});

test("a short conversation switches at once", async ($, on) => {
  const w = world(on, { files: switchTo(SONNET) });
  w.now.ctx = 2_000;
  await $.session.start(SESSION);
  await step($);
  expect(w.sent).toEqual([SONNET]);
});

test("the window warns once as it passes 80%", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  const at = (pct: number) =>
    $.session.measure({
      ...w.usage(),
      rateLimits: [{ kind: "five_hour", percentUsed: pct, resetsAt: RESETS }],
      changed: ["rateLimits"],
    });
  await at(81);
  await at(83);
  expect(w.toasts).toHaveLength(1);
  expect(w.toasts[0]).toContain("optimAIzr: 5h window at 81%");
});

test("a savings milestone gets a toast", async ($, on) => {
  // 50,000 output tokens: $1.00 on Opus 5.5, $0.50 on Sonnet 5.5.
  const w = world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, input_tokens: 0, output_tokens: 50_000 },
  });
  await $.session.start(SESSION);
  await step($);
  expect(w.toasts).toEqual(["optimAIzr: saved $0.50 this session by switching"]);
});

test("/optimaizr hud opens the HUD with the session at a glance", async ($, on) => {
  const w = world(on);
  await $.session.start(SESSION);
  for (const usd of [1.1, 1.3]) {
    await $.turn.start({ text: "go", turnId: "t1" });
    w.now.usd = usd;
    await step($);
    await answered($);
  }
  expect((await $.command.run(command("hud"))).text).toBe(
    "Opened the optimAIzr HUD. Esc closes it.",
  );
  expect(w.opened).toEqual(["optimaizr"]);

  const pane = textOf(
    await $.ui.render({
      component: "Pane",
      surface: "terminal",
      requestId: "optimaizr",
      props: {
        title: "optimAIzr",
        isFocused: true,
        bodyColumns: 80,
        placement: "dock",
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    }),
  );
  for (const part of [
    "● watching",
    "no switch yet",
    "spent $1.30",
    "2 requests",
    "5h",
    "priciest #2",
  ]) {
    expect(pane).toContain(part);
  }
});

test("after an hour idle the cache has expired, so a long conversation switches at once", async ($, on) => {
  const w = world(on, { files: switchTo(SONNET) });
  w.now.ctx = 100_000;
  await $.session.start(SESSION);
  await step($);
  await w.clock.advance(61 * MINUTE);
  await step($);
  expect(w.sent).toEqual([OPUS, SONNET]);
  expect(textOf(await $.ui.render(band()))).not.toContain("waiting");
});

test("the HUD's pause button stops and resumes the switch", async ($, on) => {
  const w = world(on, { files: switchTo(SONNET) });
  await $.session.start(SESSION);
  await step($);
  const pane = await $.ui.mount({
    plugin: "optimaizr",
    surface: "terminal",
    component: "Pane",
    requestId: "optimaizr",
    props: {
      title: "optimAIzr",
      isFocused: true,
      bodyColumns: 44,
      placement: "dock",
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  });
  expect(textOf(await pane.drawn())).toContain("● on Sonnet 5.5");

  await pane.press({ key: "pause" });
  await step($);
  await pane.press({ key: "pause" });
  await step($);
  expect(w.sent).toEqual([SONNET, OPUS, SONNET]);
});

test("before a switch has paid for its reload, the pane and /optimaizr say so", async ($, on) => {
  // 100,000 tokens reloaded into Sonnet: $0.38 more than Opus reading them.
  const w = world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, cache_creation_input_tokens: 100_000 },
  });
  await $.session.start(SESSION);
  await step($);
  const pane = textOf(
    await $.ui.render({
      component: "Pane",
      surface: "terminal",
      requestId: "optimaizr",
      props: {
        title: "optimAIzr",
        isFocused: true,
        bodyColumns: 44,
        placement: "dock",
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    }),
  );
  expect(pane).toContain("reload $0.38 not won back yet");
  expect((await $.command.run(command(""))).text).toContain(
    "Saved      not yet: reloading the conversation cost $0.38 more than the switch has saved so far",
  );
  expect(w.sent).toEqual([SONNET]);
});

test("an automatic switch says so, once, and can be undone the same way", async ($, on) => {
  const w = world(on, { files: switchTo(SONNET, { auto: true }) });
  await $.session.start(SESSION);
  await step($);
  await step($);
  expect(w.toasts).toEqual([
    "optimAIzr: switched to Sonnet 5.5 automatically · p or /optimaizr off undoes",
  ]);
  expect(w.logs[0]).toContain("(model-fit, automatically)");
  expect(textOf(await $.ui.render(band()))).toContain("Opus 5.5 → Sonnet 5.5 (auto)");
});

test("when only subagents switch, the note says so, and the main conversation gets its own", async ($, on) => {
  const w = world(on, { files: switchTo(SONNET) });
  w.now.ctx = 100_000;
  await $.session.start(SESSION);
  await step($);
  await step($, OPUS, "agent-1");
  await w.clock.advance(61 * MINUTE);
  await step($);
  expect(w.sent).toEqual([OPUS, SONNET, SONNET]);
  expect(w.logs).toEqual([
    "Switched this session's subagents from Opus 5.5 to Sonnet 5.5 (model-fit). Harder task? /optimaizr off goes back to Opus 5.5.",
    "Switched this session from Opus 5.5 to Sonnet 5.5 (model-fit). Harder task? /optimaizr off goes back to Opus 5.5.",
  ]);
});

test("the HUD shows a saving as a share of the 5-hour window too", async ($, on) => {
  // 50,000 output tokens: $1.00 on Opus, $0.50 on Sonnet, so $0.50 saved.
  // The session spent $2.00 while the window moved from 58% to 62%: $0.50 a point.
  const w = world(on, {
    files: switchTo(SONNET),
    tokens: { ...TOKENS, input_tokens: 0, output_tokens: 50_000 },
  });
  await $.session.start(SESSION);
  w.now.usd = 3;
  w.now.pct = 62;
  await step($);
  const hud = textOf(
    await $.ui.render({
      component: "Pane",
      surface: "terminal",
      requestId: "optimaizr",
      props: {
        title: "optimAIzr HUD",
        isFocused: true,
        bodyColumns: 60,
        placement: "dock",
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    }),
  );
  expect(hud).toContain("saved $0.50");
  expect(hud).toContain("≈1.0% of your 5h window");
});

test("a long idle conversation counts down to its cache expiring, then says what coming back costs", async ($, on) => {
  const w = world(on);
  w.now.ctx = 300_000;
  await $.session.start(SESSION);
  await step($);
  // 300,000 tokens re-read at $0.20 a million, or written again at the 1-hour rate, $8.
  expect(textOf(await $.ui.render(band()))).toContain(
    "context   300K · each request re-reads it ($0.06) · fresh start: /optimaizr handoff",
  );

  await w.clock.advance(45 * MINUTE);
  expect(textOf(await $.ui.render(band()))).toContain(
    "cache     warm 10m more, then 300K is written again ($2.40) · leaving? /optimaizr handoff",
  );

  await w.clock.advance(11 * MINUTE);
  expect(textOf(await $.ui.render(band()))).toContain(
    "cache     expired · the next message writes 300K again ($2.40)",
  );
  const warned = w.toasts.filter((t) => t.includes("the cache expires"));
  expect(warned).toHaveLength(1);
  expect(warned[0]).toContain(
    "writes 300K again ($2.40). Leaving? /optimaizr handoff, then /clear.",
  );
});

test("a short conversation gets no cache line: starting over costs about the same", async ($, on) => {
  const w = world(on);
  w.now.ctx = 20_000;
  await $.session.start(SESSION);
  await step($);
  await w.clock.advance(56 * MINUTE);
  const drawn = textOf(await $.ui.render(band()));
  expect(drawn).not.toContain("cache");
  expect(drawn).not.toContain("context");
  expect(w.toasts).toEqual([]);
});

test("a conversation past 200K is told once what each request re-reads", async ($, on) => {
  const w = world(on);
  w.now.ctx = 250_000;
  await $.session.start(SESSION);
  for (let i = 0; i < 2; i++) {
    await $.turn.start({ text: "go", turnId: "t1" });
    await step($);
    await answered($);
  }
  expect(w.toasts).toEqual([
    "optimAIzr: this conversation is past 200K. Each request re-reads all 250K ($0.05). At a natural break, /optimaizr handoff, then /clear.",
  ]);
});

const NOTE = "Changed: src/limit.ts adds a token bucket.\nOpen: a test for the burst case.";
const HANDOFFS = `${DIR}/mod/handoffs/work-shop-api.json`;

test("/optimaizr handoff saves Claude's note, and the next conversation starts from it once", async ($, on) => {
  const forks: string[] = [];
  on("model.fork", ($, e) => {
    forks.push(e.prompt);
    return {
      value: {
        isAnswered: true as const,
        text: NOTE,
        usage: {
          input_tokens: 10,
          output_tokens: 400,
          cache_read_input_tokens: 300_000,
          cache_creation_input_tokens: 300,
        },
      },
    };
  });
  on("prompt.context", ($, e) => ({ blocks: e.blocks }));
  const w = world(on);
  w.now.ctx = 300_000;
  await $.session.start(SESSION);
  await step($);

  // 300,000 tokens read from cache, 400 written out: $0.07 on Opus 5.5.
  const saved = await $.command.run(command("handoff"));
  expect(saved.text).toBe(
    `Handoff saved for shop-api, written from the warm cache for $0.07.\n\n${NOTE}\n\n` +
      "/clear now and the next conversation in this project starts from this note. It is used once, within 12 hours.",
  );
  expect(forks).toHaveLength(1);
  expect(JSON.parse(w.files.get(HANDOFFS)!).text).toBe(NOTE);

  // The conversation that wrote it never reads it back.
  expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([]);

  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  const fresh = await $.prompt.context({ blocks: [] });
  expect(fresh.blocks.map((b) => b.name)).toEqual(["optimaizrHandoff"]);
  expect(fresh.blocks[0]!.text).toContain(NOTE);
  expect(JSON.parse(w.files.get(HANDOFFS)!).usedAt).toBeDefined();
  expect(w.toasts).toContain("optimAIzr: this conversation starts from your handoff note");
  // A re-read of the same conversation keeps the block; the next conversation has none.
  expect((await $.prompt.context({ blocks: [] })).blocks).toHaveLength(1);
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([]);
});

test("a handoff note from another session is used within 12 hours, not after", async ($, on) => {
  const note = (hoursAgo: number) =>
    JSON.stringify({
      version: 1,
      root: CWD,
      session: "s0",
      conversation: 0,
      at: new Date(-hoursAgo * 60 * MINUTE).toISOString(),
      text: NOTE,
    });
  on("prompt.context", ($, e) => ({ blocks: e.blocks }));
  const w = world(on, { files: { [HANDOFFS]: note(13) } });
  await $.session.start(SESSION);
  expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([]);

  w.files.set(HANDOFFS, note(1));
  await $.session.end({ reason: "clear", sessionId: "s1", resume: { id: "s1" } });
  expect((await $.prompt.context({ blocks: [] })).blocks).toHaveLength(1);
});

test("/optimaizr handoff waits for the turn to end, and needs an answer to hand off", async ($, on) => {
  on("model.fork", () => ({
    value: { isAnswered: false as const, reason: "nothing-to-fork" as const },
  }));
  world(on);
  await $.session.start(SESSION);
  expect((await $.command.run(command("handoff"))).text).toBe(
    "Nothing to hand off yet: Claude hasn't answered in this conversation.",
  );
  await $.turn.start({ text: "go", turnId: "t1" });
  expect((await $.command.run(command("handoff"))).text).toBe(
    "Claude is still working. Run /optimaizr handoff once the turn ends.",
  );
});
