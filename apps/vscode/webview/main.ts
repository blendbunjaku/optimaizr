import { ago, countdown } from "../src/format.js";
import type { FromView, ToView, ViewState } from "../src/types.js";
import { icons } from "./icons.js";
import { convoState, render, type Ui } from "./render.js";

// The page inside the sidebar and the report. It renders what the host sends,
// swaps only the sections that changed and keeps the clocks ticking itself.

declare function acquireVsCodeApi(): {
  postMessage(m: FromView): void;
  getState(): { open?: string[] } | undefined;
  setState(s: { open: string[] }): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;
const mode = document.body.dataset.mode === "report" ? "report" : "sidebar";
const ui: Ui = { mode, open: vscode.getState()?.open ?? [] };
const still = window.matchMedia("(prefers-reduced-motion: reduce)");

let state: ViewState | null = null;
const shown = new Map<string, string>();
const widths = new Map<string, string>();
const counted = new Set<string>();

const send = (m: FromView) => vscode.postMessage(m);

function draw(): void {
  if (!state) return;
  const sections = render({ ...state, live: { ...state.live, now: Date.now() } }, ui);
  const ids = new Set(sections.map(([id]) => id));
  for (const [id] of shown) {
    if (ids.has(id)) continue;
    app.querySelector(`[data-s="${id}"]`)?.remove();
    shown.delete(id);
  }
  if (cols && !sections.some(([id]) => LEFT.has(id) || RIGHT.has(id))) cols.root.remove();
  const prev = new Map<Element, Element | null>();
  for (const [id, html] of sections) {
    const parent = parentOf(id, prev);
    let el = app.querySelector<HTMLElement>(`[data-s="${id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.dataset.s = id;
    }
    put(parent, el, prev);
    if (shown.get(id) !== html) {
      el.innerHTML = html;
      shown.set(id, html);
      settle(id, el);
    }
  }
  tick();
}

// The report sets the live cards and the story side by side in two columns
// that grow on their own, so a short card leaves no hole next to a tall one.
const LEFT = new Set(["now", "parts", "where"]);
const RIGHT = new Set(["guard", "results", "win"]);
let cols: { root: HTMLElement; left: HTMLElement; right: HTMLElement } | null = null;

function parentOf(id: string, prev: Map<Element, Element | null>): Element {
  if (mode !== "report" || (!LEFT.has(id) && !RIGHT.has(id))) return app;
  if (!cols) {
    const root = document.createElement("div");
    root.className = "cols";
    const left = document.createElement("div");
    const right = document.createElement("div");
    left.className = right.className = "col";
    root.append(left, right);
    cols = { root, left, right };
  }
  if (!cols.root.isConnected || !prev.has(cols.root)) {
    put(app, cols.root, prev);
    prev.set(cols.root, null);
  }
  return LEFT.has(id) ? cols.left : cols.right;
}

/** Keep each child right after the one placed before it in the same parent. */
function put(parent: Element, el: Element, prev: Map<Element, Element | null>): void {
  const before = prev.get(parent) ?? null;
  if (before ? before.nextElementSibling !== el : parent.firstElementChild !== el) {
    if (before) before.after(el);
    else parent.prepend(el);
  }
  prev.set(parent, el);
}

/** Bars grow from where they were, and the big number counts up once. */
function settle(id: string, root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-w]").forEach((el, i) => {
    const key = `${id}:${i}`;
    const to = `${el.dataset.w}%`;
    const from = widths.get(key);
    widths.set(key, to);
    if (still.matches) {
      el.style.width = to;
      return;
    }
    if (from) {
      el.style.transition = "none";
      el.style.width = from;
      void el.offsetWidth;
      el.style.transition = "";
    }
    requestAnimationFrame(() => (el.style.width = to));
  });
  root.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const target = Number(el.dataset.count);
    const key = `${el.dataset.count}${el.dataset.suffix ?? ""}`;
    if (!Number.isFinite(target) || counted.has(key) || still.matches) return;
    counted.add(key);
    countUp(el, target, el.dataset.suffix ?? "");
  });
}

function countUp(el: HTMLElement, target: number, suffix: string): void {
  const decimals = Number.isInteger(target) ? 0 : 1;
  const start = performance.now();
  const ms = 900;
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = `${(target * eased).toFixed(decimals)}${suffix}`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Every second: the countdowns, the rings, and a fresh render when a cache turns. */
function tick(): void {
  const now = Date.now();
  let turned = false;
  app.querySelectorAll<HTMLElement>("[data-countdown]").forEach((el) => {
    const at = Number(el.dataset.countdown);
    if (!at) return;
    const text = at > now ? countdown(at - now) : "0:00";
    if (el.textContent !== text) el.textContent = text;
  });
  app.querySelectorAll<HTMLElement>(".ring[data-expires]").forEach((ring) => {
    const at = Number(ring.dataset.expires);
    const ttl = Number(ring.dataset.ttl) || 1;
    const fg = ring.querySelector<SVGCircleElement>(".ring-fg");
    const left = at ? Math.max(0, Math.min(1, (at - now) / ttl)) : 0;
    fg?.style.setProperty("stroke-dashoffset", String(100 - left * 100));
    const was = ["warm", "soon", "cold", "unknown"].find((c) => ring.classList.contains(c));
    if (was !== convoState({ expiresAt: at || null }, now)) turned = true;
  });
  app.querySelectorAll<HTMLElement>(".dot").forEach((dot) => {
    const at = Number(
      dot.parentElement?.querySelector<HTMLElement>("[data-countdown]")?.dataset.countdown,
    );
    if (at && at <= now && !dot.classList.contains("cold")) turned = true;
  });
  app.querySelectorAll<HTMLElement>("[data-ago]").forEach((el) => {
    if (el.dataset.ago && !state?.loading) el.textContent = `Updated ${ago(el.dataset.ago, now)}`;
  });
  if (turned) draw();
}

/* What a click asks for */

app.addEventListener("click", (e) => {
  const el = (e.target as Element).closest<HTMLElement>("[data-action]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  // A button inside a fix's summary should not also open or close it.
  if (el.closest("summary")) e.preventDefault();
  const on = el.dataset.on === "true";
  const rule = el.dataset.rule ?? "";
  switch (el.dataset.action) {
    case "refresh":
      if (state) state.loading = true;
      draw();
      send({ type: "refresh" });
      break;
    case "guard":
      busy("guard");
      send({ type: "guard", on });
      break;
    case "compact":
      busy("compact");
      send({ type: "compact", on });
      break;
    case "done":
      busy(`done:${rule}`);
      send({ type: "done", rule });
      break;
    case "undoDone":
      send({ type: "undoDone", rule });
      break;
    case "openReport":
      send({ type: "openReport" });
      break;
    case "openSettings":
      send({ type: "openSettings" });
      break;
    case "link":
      if (el.dataset.url) send({ type: "link", url: el.dataset.url });
      break;
  }
});

function busy(what: string): void {
  if (!state) return;
  state.busy = what;
  draw();
}

// Remember which fixes are open, across reloads of the view.
app.addEventListener(
  "toggle",
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const id = d.dataset?.id;
    if (!id || mode === "report") return;
    ui.open = d.open ? [...new Set([...ui.open, id])] : ui.open.filter((x) => x !== id);
    vscode.setState({ open: ui.open });
  },
  true,
);

/* What the host says */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(ok: boolean, text: string): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.classList.toggle("bad", !ok);
  el.innerHTML = `${ok ? icons.check : icons.bolt}<span></span>`;
  el.querySelector("span")!.textContent = text;
  requestAnimationFrame(() => el!.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.remove("show"), 4200);
}

window.addEventListener("message", (e: MessageEvent<ToView>) => {
  const m = e.data;
  if (m.type === "state") {
    state = m.state;
    draw();
  } else if (m.type === "live" && state) {
    state.live = m.live;
    state.busy = m.busy;
    draw();
  } else if (m.type === "toast") {
    toast(m.ok, m.text);
  }
});

setInterval(tick, 1000);
send({ type: "ready" });
