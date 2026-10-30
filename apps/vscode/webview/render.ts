import {
  ago,
  clip,
  clock,
  day,
  duration,
  money,
  multiple,
  percent,
  tokens,
} from "../src/format.js";
import type { FixItem, LiveConvo, LiveState, Snapshot, ViewState } from "../src/types.js";
import { icons } from "./icons.js";

/**
 * The sidebar and the report as HTML strings, one per section, so the script
 * only swaps the sections that changed. No inline styles: widths ride on
 * data-w and the script sets them, which keeps the CSP strict.
 */

export interface Ui {
  mode: "sidebar" | "report";
  /** Fix rows the user opened. */
  open: string[];
}

export type Sections = Array<[id: string, html: string]>;

const COMPACT_AT = 200_000;
const TIER_NAME = { fix: "Fix", try: "Try", test: "Test" } as const;

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const w = (share: number) => Math.max(0, Math.min(100, share * 100)).toFixed(1);

export function render(v: ViewState, ui: Ui): Sections {
  const s = v.snapshot;
  const out: Sections = [["top", top(v, ui)]];
  if (v.error && !s) {
    out.push(["hero", errorCard(v.error)]);
  } else if (!s) {
    out.push(["hero", loadingHero()]);
  } else if (s.empty) {
    out.push(["hero", welcome(s)]);
  } else {
    out.push(["hero", hero(s, ui)]);
  }
  out.push(["now", now(v.live, s)]);
  out.push(["guard", guard(v, ui)]);
  if (s && !s.empty) {
    if (ui.mode === "report" && s.allIn && s.allIn.parts.length > 0) out.push(["parts", parts(s)]);
    if (ui.mode === "report" && s.biggestWin) out.push(["win", win(s)]);
    out.push(["fixes", fixes(v, s, ui)]);
    if (s.results.length > 0 || s.week) out.push(["results", results(s)]);
    out.push(["where", where(s)]);
  }
  out.push(["foot", foot(v, ui)]);
  return out;
}

/* Header */

function top(v: ViewState, ui: Ui): string {
  const s = v.snapshot;
  const when = v.loading ? "Reading your history…" : s ? `Updated ${ago(s.at, v.live.now)}` : "";
  return `<header class="top">
    <div class="brand">${icons.logo}<span class="word">optim<b>AI</b>zr</span>${ui.mode === "report" ? '<span class="crumb">report</span>' : ""}</div>
    <div class="top-r"><span class="muted small" data-ago="${esc(s?.at ?? "")}">${esc(when)}</span>
    <button class="icon-btn${v.loading ? " spinning" : ""}" data-action="refresh" title="Refresh" aria-label="Refresh">${icons.refresh}</button></div>
  </header>`;
}

/* Hero: the one number worth remembering */

function hero(s: Snapshot, ui: Ui): string {
  const a = s.allIn;
  const planLine = s.plan
    ? `<p class="hero-foot">${icons.spark}<span>Your <b>${esc(s.plan.label)}</b> did <b>${money(s.plan.valueMonthlyUsd)}/mo</b> of work at API prices, <b class="accent">${multiple(s.plan.multiple)}</b> what you pay.</span></p>`
    : `<p class="hero-foot">${icons.spark}<span><b>${money(s.spend.perMonthUsd)}/mo</b> of AI at list prices, ${s.spend.calls.toLocaleString("en-US")} calls in ${Math.max(1, Math.round(s.window.days))} days.</span></p>`;

  if (a && a.share >= 0.05) {
    const pct = Math.round(a.share * 100);
    const gain =
      a.moreWork > 1.01
        ? `of your usage can go. That is about <b>${a.moreWork.toFixed(1)}x the work</b> per 5-hour window and per week.`
        : `of your usage can go, about <b>${money(a.monthlyUsd)}/mo</b> at API prices.`;
    const shown = a.parts.slice(0, ui.mode === "report" ? 6 : 3);
    const rest = a.parts.length - shown.length;
    const legend = shown
      .map(
        (p, i) =>
          `<li><i class="sw seg-${i}"></i><span>${esc(p.label)}</span><b>${percent(p.share)}</b></li>`,
      )
      .join("");
    return `<section class="card hero glow" aria-label="What you could save">
      <p class="eyebrow">You could save</p>
      <div class="big"><span class="big-pre">up to</span><span class="big-num" data-count="${pct}" data-suffix="%">${pct}%</span></div>
      <p class="lead">${gain}</p>
      <div class="stack" role="img" aria-label="Where the ${pct}% comes from">${a.parts
        .map(
          (p, i) =>
            `<i class="seg seg-${Math.min(i, 5)}" data-w="${w(p.share / a.share)}" title="${esc(p.label)} ${percent(p.share)}"></i>`,
        )
        .join("")}</div>
      <ul class="legend">${legend}${rest > 0 ? `<li class="muted"><i class="sw seg-5"></i><span>${rest} more</span></li>` : ""}</ul>
      ${planLine}
    </section>`;
  }
  if (s.plan) {
    return `<section class="card hero glow" aria-label="What your plan is worth">
      <p class="eyebrow">Your plan is worth</p>
      <div class="big"><span class="big-num" data-count="${s.plan.multiple.toFixed(1)}" data-suffix="x">${multiple(s.plan.multiple)}</span><span class="big-post">what you pay</span></div>
      <p class="lead">Your <b>${esc(s.plan.label)}</b> did <b>${money(s.plan.valueMonthlyUsd)}/mo</b> of work at API prices.</p>
      <p class="hero-foot good">${icons.check}<span>No big waste found. Nice and lean.</span></p>
    </section>`;
  }
  const clear = s.savings.clearMonthlyUsd;
  return `<section class="card hero glow" aria-label="Your usage">
    <p class="eyebrow">You use</p>
    <div class="big"><span class="big-num">${money(s.spend.perMonthUsd)}</span><span class="big-post">/mo of AI</span></div>
    <p class="lead">${clear >= 0.25 ? `<b class="good">${money(clear)}/mo</b> of it is clear waste you can stop.` : "No clear waste found. Nice and lean."}</p>
    ${planLine}
  </section>`;
}

function loadingHero(): string {
  return `<section class="card hero" aria-busy="true">
    <p class="eyebrow">Counting</p>
    <div class="skel skel-big"></div>
    <div class="skel"></div><div class="skel short"></div>
    <p class="muted small">Reading the last month of Claude Code on this machine. It takes a few seconds the first time.</p>
  </section>`;
}

function welcome(s: Snapshot): string {
  return `<section class="card hero welcome">
    <p class="eyebrow">Welcome</p>
    <h2>Your savings show up here.</h2>
    <p class="lead">${esc(s.emptyReason ?? "No history yet.")} Use Claude Code for a bit, and optimAIzr works out where the tokens go and what to change.</p>
    <p class="hero-foot">${icons.lock}<span>It reads <code>~/.claude</code> on this machine. Nothing is uploaded.</span></p>
  </section>`;
}

function errorCard(message: string): string {
  return `<section class="card hero">
    <p class="eyebrow bad">Something got in the way</p>
    <p class="lead">${esc(message)}</p>
    <button class="btn" data-action="refresh">${icons.refresh}Try again</button>
  </section>`;
}

/* Right now: the conversation in this folder */

export function convoState(
  c: Pick<LiveConvo, "expiresAt">,
  now: number,
): "warm" | "soon" | "cold" | "unknown" {
  if (c.expiresAt === null) return "unknown";
  const left = c.expiresAt - now;
  if (left <= 0) return "cold";
  return left <= 5 * 60_000 ? "soon" : "warm";
}

/** The cache's whole life, for the ring: about 55 minutes for 1h writes, 4.6 for 5m. */
function ttlOf(c: LiveConvo): number {
  const span = (c.expiresAt ?? 0) - c.lastAt;
  return span > 10 * 60_000 ? 55 * 60_000 : (55 / 12) * 60_000;
}

function ring(c: LiveConvo, now: number): string {
  const state = convoState(c, now);
  const ttl = ttlOf(c);
  // The seconds are left empty: the script fills them every second, so a new
  // render only differs when something real changed.
  const label = state === "cold" ? icons.snow : state === "unknown" ? "?" : "";
  const count = state === "warm" || state === "soon" ? ` data-countdown="${c.expiresAt}"` : "";
  return `<div class="ring ${state}" data-expires="${c.expiresAt ?? ""}" data-ttl="${ttl}" role="timer" aria-label="${state === "cold" ? "Cache expired" : "Time left on the cache"}">
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-bg" cx="22" cy="22" r="19"/><circle class="ring-fg" cx="22" cy="22" r="19" pathLength="100"/></svg>
    <span class="ring-t"${count}>${label}</span>
  </div>`;
}

function cacheLine(c: LiveConvo, now: number, guardOn: boolean): string {
  switch (convoState(c, now)) {
    case "warm":
      return `<b>Cache warm.</b> Reply in time and the next message re-reads it for ${money(c.readUsd)}.`;
    case "soon":
      return `<b class="warn">Expiring soon.</b> Reply now, or coming back costs ${money(c.rewriteUsd)} to write it again.`;
    case "cold":
      return `<b>Cache expired.</b> Your next message writes ${tokens(c.context)} again: ${money(c.rewriteUsd)}.${guardOn ? " Guard will hold it first." : ""}`;
    default:
      return "<b>Cache:</b> the provider decides how long it stays.";
  }
}

function contextLine(context: number): string {
  if (context < 100_000) return "Light. Plenty of room.";
  if (context < COMPACT_AT) return "Getting big. A /compact between tasks keeps it cheap.";
  return "Past 200K: every message re-reads all of it. Compact between tasks.";
}

function modelName(id: string): string {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(id);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}`;
  return id.replace(/^claude-/, "");
}

function now(live: LiveState, s: Snapshot | null): string {
  const c = live.convo;
  const guardOn = Boolean(s?.guard.on);
  const t = live.now;
  const five = live.fiveHour;
  const fiveRow = five
    ? `<div class="row">
        <div class="row-h"><span>${icons.gauge}5-hour window</span><b class="num">${Math.round(five.percent)}%</b></div>
        <div class="bar ${five.percent >= 90 ? "hot" : five.percent >= 70 ? "warm" : ""}"><i data-w="${w(five.percent / 100)}"></i></div>
        <p class="cap">${five.resetsAt ? `Resets ${esc(clock(five.resetsAt))}` : "Used so far"}${five.basis === "estimate" ? ' · <span class="chip" title="Worked out from what your 5-hour windows have held before. Install the optimAIzr mod for Claude\'s own reading.">estimate</span>' : ""}</p>
      </div>`
    : "";
  const last = live.lastTurn
    ? `<p class="cap last">Last turn <b>${duration(live.lastTurn.workMs)}</b> · <b>${money(live.lastTurn.costUsd)}</b>${live.lastTurn.percent !== null && live.lastTurn.percent >= 0.5 ? ` · ${Math.round(live.lastTurn.percent)}% of 5h` : ""}</p>`
    : "";
  const warm = live.warm.length
    ? `<div class="warm-list"><p class="label">Warm elsewhere</p>${live.warm
        .map(
          (x) =>
            `<div class="warm-row"><span class="dot ${convoState(x, t)}"></span><span class="ellipsis">${esc(clip(x.title, 40))}</span><span class="chip num" data-countdown="${x.expiresAt ?? ""}"></span></div>`,
        )
        .join("")}</div>`
    : "";

  if (!c) {
    return `<section class="card now" aria-label="Right now">
      <h3 class="card-h"><span class="pulse off"></span>Right now</h3>
      <p class="muted">Nothing running in this folder. Start Claude Code here and the cache countdown shows up.</p>
      ${fiveRow}${warm}
    </section>`;
  }
  const state = convoState(c, t);
  const over = c.context >= COMPACT_AT;
  return `<section class="card now ${state}" aria-label="Right now">
    <h3 class="card-h"><span class="pulse ${state}"></span>Right now<span class="chip model">${esc(modelName(c.model))}</span></h3>
    <p class="convo ellipsis" title="${esc(c.title)}">${esc(c.title)}</p>
    <div class="cache">${ring(c, t)}<p class="cache-t">${cacheLine(c, t, guardOn)}</p></div>
    <div class="row">
      <div class="row-h"><span>${icons.layers}Context</span><b class="num">${tokens(c.context)}</b></div>
      <div class="bar ctx ${over ? "hot" : c.context >= 100_000 ? "warm" : ""}"><i data-w="${w(Math.min(1, c.context / COMPACT_AT))}"></i><span class="mark" title="200K: where compacting starts to pay"></span></div>
      <p class="cap">${contextLine(c.context)}</p>
    </div>
    ${fiveRow}${last}${warm}
  </section>`;
}

/* Guard */

function guard(v: ViewState, ui: Ui): string {
  const g = v.snapshot?.guard ?? { on: false, catches: 0, savedUsd: 0, recent: [] };
  const busy = v.busy === "guard";
  const toggle = `<button class="switch${g.on ? " on" : ""}${busy ? " busy" : ""}" role="switch" aria-checked="${g.on}" data-action="guard" data-on="${!g.on}" ${busy ? "disabled" : ""} aria-label="Guard"><i></i></button>`;
  // Saved counts only holds that were not sent anyway; the list shows every hold.
  const held = Math.max(g.catches, g.recent.length);
  const catches = `${held} ${held === 1 ? "catch" : "catches"}`;
  const body = g.on
    ? g.savedUsd >= 0.01
      ? `<p class="kept"><b class="good num">${money(g.savedUsd)}</b> kept this week <span class="muted">· ${catches}</span></p>`
      : held > 0
        ? `<p class="kept"><b class="good">${catches}</b> this week</p>`
        : `<p class="muted">On and watching. Nothing needed holding this week.</p>`
    : `<p class="muted">Holds the one message that would rewrite an expired cache, a whole read of a huge file, and a third try of a failing command. Send it again and it goes through.</p>${
        v.cli === "missing"
          ? `<p class="cap">${icons.bolt}Runs through the optimAIzr CLI. Turning it on offers to install it.</p>`
          : ""
      }`;
  const list = g.recent.slice(0, ui.mode === "report" ? 5 : 3);
  const recent =
    g.on && list.length
      ? `<ul class="catches">${list
          .map(
            (c) =>
              `<li><span class="catch-i">${c.kind === "handoff-used" ? icons.check : icons.pause}</span><div><p><b>${esc(c.title)}</b> <span class="muted small">${esc(ago(c.at, v.live.now))}</span></p><p class="cap">${esc(c.text)}</p></div></li>`,
          )
          .join("")}</ul>`
      : "";
  return `<section class="card guard ${g.on ? "is-on" : ""}" aria-label="Guard">
    <h3 class="card-h">${g.on ? icons.shieldCheck : icons.shield}Guard${toggle}</h3>
    ${body}${recent}
  </section>`;
}

/* Fixes */

function fixAction(f: FixItem, s: Snapshot, busy: string | null): string {
  if (f.kind === "compaction") {
    const at = s.compaction.at;
    if (at) {
      return `<span class="chip ok">${icons.check}On at ${Math.round(at / 1000)}K</span>`;
    }
    return `<button class="btn sm primary" data-action="compact" data-on="true" ${busy === "compact" ? "disabled" : ""}>${busy === "compact" ? "Applying…" : "Apply"}</button>`;
  }
  return f.doneAt ? `<span class="chip ok">${icons.check}Done</span>` : "";
}

function fixUndo(f: FixItem, s: Snapshot, busy: string | null): string {
  if (f.kind === "compaction" && s.compaction.at) {
    return `<button class="link" data-action="compact" data-on="false">${icons.undo}Undo, compact where Claude Code did before</button>`;
  }
  if (f.kind === "habit" && f.doneAt) {
    return `<button class="link" data-action="undoDone" data-rule="${esc(f.rule)}">${icons.undo}Recorded ${esc(day(f.doneAt))}. Undo</button>`;
  }
  if (f.kind === "habit") {
    // Asked for after the story, not before it.
    return `<div class="done-row"><button class="btn sm primary" data-action="done" data-rule="${esc(f.rule)}" ${busy === `done:${f.rule}` ? "disabled" : ""}>${icons.check}I did this</button><p class="cap">optimAIzr measures what it changed from today.</p></div>`;
  }
  return `<p class="cap">One click writes the setting to Claude Code. Undo puts it back.</p>`;
}

function fixRow(f: FixItem, s: Snapshot, ui: Ui, busy: string | null): string {
  const open = ui.mode === "report" || ui.open.includes(f.rule);
  const amount =
    f.tier === "test" ? `up to ${money(f.monthlyUsd)}/mo` : `${money(f.monthlyUsd)}/mo`;
  const share = s.plan && f.usageShare >= 0.005 ? ` · ${percent(f.usageShare)} of usage` : "";
  return `<details class="fix" data-id="${esc(f.rule)}" ${open ? "open" : ""}>
    <summary>
      <span class="tier ${f.tier}">${TIER_NAME[f.tier]}</span>
      <span class="fix-t"><b>${esc(f.label)}</b><span class="muted small">${amount}${share}</span></span>
      <span class="fix-a">${fixAction(f, s, busy)}</span>
      ${icons.chevron}
    </summary>
    <div class="fix-b">
      ${f.happened ? `<p><span class="label">What happened</span>${esc(f.happened)}</p>` : ""}
      ${f.fix ? `<p><span class="label">The fix</span>${esc(f.fix)}</p>` : ""}
      ${ui.mode === "report" && f.why ? `<p><span class="label">Why it works</span>${esc(f.why)}</p>` : ""}
      <div class="fix-u">${fixUndo(f, s, busy)}</div>
    </div>
  </details>`;
}

/** The biggest money first; the ones already done sink to the bottom. */
function byMoney(list: FixItem[]): FixItem[] {
  return list
    .slice()
    .sort(
      (a, b) =>
        Number(Boolean(a.doneAt)) - Number(Boolean(b.doneAt)) || b.monthlyUsd - a.monthlyUsd,
    );
}

function fixes(v: ViewState, s: Snapshot, ui: Ui): string {
  if (s.fixes.length === 0) {
    return `<section class="card" aria-label="Fixes"><h3 class="card-h">${icons.bolt}Your fixes</h3><p class="muted">Nothing worth changing right now. Check back after a busy week.</p></section>`;
  }
  const total = s.fixes.filter((f) => !f.doneAt).reduce((t, f) => t + f.monthlyUsd, 0);
  const smaller =
    s.smaller > 0
      ? `<p class="cap more">+${s.smaller} smaller, under $0.25/mo each. <code>optimaizr recommend</code> lists them.</p>`
      : "";
  return `<section class="card fixes" aria-label="Fixes">
    <h3 class="card-h">${icons.bolt}Your fixes<span class="muted small right">${s.fixes.length} · ${money(total)}/mo</span></h3>
    <div class="fix-list">${byMoney(s.fixes)
      .map((f) => fixRow(f, s, ui, v.busy))
      .join("")}</div>
    ${smaller}
  </section>`;
}

/* Report-only: where the all-in comes from, and the biggest win in full */

function parts(s: Snapshot): string {
  const a = s.allIn!;
  return `<section class="card" aria-label="Where it comes from">
    <h3 class="card-h">Where the ${percent(a.share)} comes from</h3>
    <div class="parts">${a.parts
      .map(
        (p, i) =>
          `<div class="part"><span class="ellipsis"><i class="sw seg-${Math.min(i, 5)}"></i>${esc(p.label)}</span><span class="tier ${p.tier}">${TIER_NAME[p.tier]}</span><b class="num">${percent(p.share)}</b></div>`,
      )
      .join("")}</div>
    <p class="cap">Each is taken from what the ones above leave, so nothing counts twice.</p>
  </section>`;
}

function win(s: Snapshot): string {
  const b = s.biggestWin!;
  const head =
    b.tier === "test"
      ? `Up to ${percent(b.share)} less usage (about ${money(b.monthlyUsd)}/mo)`
      : `${money(b.monthlyUsd)}/mo, ${percent(b.share)} of your usage`;
  return `<section class="card win" aria-label="Biggest win">
    <p class="eyebrow">Biggest win</p>
    <h3 class="win-t"><span class="tier ${b.tier}">${TIER_NAME[b.tier]}</span>${esc(b.label)}</h3>
    <p class="lead">${head}${b.moreWork > 1.01 ? `, about ${b.moreWork.toFixed(1)}x the work per 5-hour window` : ""}.</p>
    ${b.happened ? `<p><span class="label">What happened</span>${esc(b.happened)}</p>` : ""}
    ${b.why ? `<p><span class="label">Why it works</span>${esc(b.why)}</p>` : ""}
    ${b.fix ? `<p><span class="label">The fix</span>${esc(b.fix)}</p>` : ""}
  </section>`;
}

/* Results: what the changes you made are doing */

function results(s: Snapshot): string {
  const rows = s.results
    .map(
      (r) =>
        `<li><div><b>${esc(r.name.replace(/ -> /g, " → "))}</b><span class="muted small"> since ${esc(day(r.since))}</span></div><span class="verdict ${r.verdict}">${esc(r.text.charAt(0).toUpperCase() + r.text.slice(1))}</span></li>`,
    )
    .join("");
  return `<section class="card" aria-label="Your changes">
    <h3 class="card-h">${icons.check}Your changes</h3>
    ${rows ? `<ul class="results">${rows}</ul>` : ""}
    ${s.week ? `<p class="cap week">${esc(s.week)}</p>` : ""}
  </section>`;
}

/* Where it goes */

const WHERE: Array<[keyof Snapshot["breakdown"], string]> = [
  ["reread", "Re-reading the conversation"],
  ["output", "Answers, code and thinking"],
  ["cacheWrite", "Loading context into cache"],
  ["input", "New input"],
  ["tools", "Web search and tools"],
];

function where(s: Snapshot): string {
  const rows = WHERE.map(([k, label]) => ({ k, label, v: s.breakdown[k] }))
    .filter((r) => r.v >= 0.005)
    .sort((a, b) => b.v - a.v);
  return `<section class="card" aria-label="Where it goes">
    <h3 class="card-h">Where it goes</h3>
    <div class="stack thin">${rows.map((r, i) => `<i class="seg where-${i}" data-w="${w(r.v)}" title="${esc(r.label)} ${percent(r.v)}"></i>`).join("")}</div>
    <ul class="legend col">${rows
      .map(
        (r, i) =>
          `<li><i class="sw where-${i}"></i><span>${esc(r.label)}</span><b>${percent(r.v)}</b></li>`,
      )
      .join("")}</ul>
    ${s.breakdown.reread >= 0.3 ? `<p class="cap">Re-reading is billed at the cheapest rate there is. It is big because every call does it, so shorter conversations are the lever.</p>` : ""}
  </section>`;
}

/* Footer */

function foot(v: ViewState, ui: Ui): string {
  const s = v.snapshot;
  const span = s && !s.empty ? `${esc(s.window.from)} to ${esc(s.window.to)} · ` : "";
  return `<footer class="foot">
    ${ui.mode === "sidebar" && s && !s.empty ? `<button class="btn wide" data-action="openReport">${icons.report}Open the full report</button>` : ""}
    <p class="cap center">${icons.lock}${span}Read on this machine. Nothing is uploaded.</p>
    <p class="cap center links"><button class="link" data-action="openSettings">${icons.gear}Settings</button><button class="link" data-action="link" data-url="https://github.com/blendbunjaku/optimaizr">${icons.star}Star on GitHub</button></p>
  </footer>`;
}
