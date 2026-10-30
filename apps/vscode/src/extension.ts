import path from "node:path";
import { canNotify, guardApplied, notify } from "@optimaizr/local";
import * as vscode from "vscode";
import {
  type ActionResult,
  compactOff,
  compactOn,
  findCli,
  guardOff,
  markDone,
  setGuard,
  undoDone,
  withLocalState,
} from "./actions.js";
import { clip } from "./format.js";
import { createLiveWatch, type LiveNotice, type LiveWatch } from "./live.js";
import { coldText, doneText, expiringText, guardCatchText, longText } from "./notices.js";
import {
  claim,
  inFolders,
  pruneClaims,
  readCachedSnapshot,
  runWorker,
  writeCachedSnapshot,
} from "./shared.js";
import { statusView } from "./status.js";
import type { FromView, Snapshot, ToView, ViewState } from "./types.js";
import { type Host, openReport, post, SidebarProvider } from "./view.js";

/** A snapshot another window made this recently is used as is. */
const FRESH_MS = 9 * 60_000;
const EVERY_MS = 10 * 60_000;
/** How long a window waits for the one whose folder it is to speak first. */
const OWNER_WAIT_MS = 2_500;

const cfg = () => vscode.workspace.getConfiguration("optimaizr");
const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

const ALERT: Record<LiveNotice["kind"], string> = {
  expiring: "alerts.cacheExpiring",
  cold: "alerts.coldCache",
  long: "alerts.longConversation",
  guard: "alerts.guard",
  done: "alerts.claudeDone",
};

class Hub implements Host {
  snapshot: Snapshot | null = null;
  loading = false;
  error: string | null = null;
  busy: string | null = null;
  cli: ViewState["cli"] = "unknown";
  readonly views = new Set<vscode.Webview>();
  readonly live: LiveWatch;
  private liveTimer: NodeJS.Timeout | undefined;
  private guardWait: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.live = createLiveWatch({
      folders,
      onNotice: (n) => this.notice(n),
      onChange: () => this.liveSoon(),
    });
    this.cli = findCli(cfg().get("cliPath", "")) ? "found" : "missing";
  }

  get root(): vscode.Uri {
    return this.context.extensionUri;
  }

  view(): ViewState {
    return {
      snapshot: this.snapshot,
      live: this.live.state(),
      loading: this.loading,
      error: this.error,
      busy: this.busy,
      cli: this.cli,
    };
  }

  send(m: ToView): void {
    for (const w of this.views) post(w, m);
  }

  postState(): void {
    this.send({ type: "state", state: this.view() });
  }

  postLive(): void {
    this.send({ type: "live", live: this.live.state(), busy: this.busy });
  }

  /** Calls land in bursts while Claude works; one update per burst is plenty. */
  private liveSoon(): void {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.postLive();
    }, 400);
  }

  attach(webview: vscode.Webview): vscode.Disposable {
    this.views.add(webview);
    return new vscode.Disposable(() => this.views.delete(webview));
  }

  /* The analysis: shared with other windows through the cached snapshot */

  async analyze(force: boolean): Promise<void> {
    if (this.loading) return;
    const days = cfg().get<number>("days", 30);
    if (!force) {
      const cached = readCachedSnapshot(days, FRESH_MS);
      if (cached) return this.take(cached);
    }
    this.loading = true;
    this.postState();
    try {
      const s = await runWorker(path.join(this.root.fsPath, "dist", "worker.js"), days);
      writeCachedSnapshot(s);
      this.take(s);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      this.postState();
    }
  }

  private take(s: Snapshot): void {
    const first = !this.snapshot;
    this.snapshot = withLocalState(s);
    this.error = null;
    this.live.seed(s);
    this.postState();
    if (first) void this.hello(s);
  }

  /** Once per install, the one line that says why the sidebar is worth a look. */
  private async hello(s: Snapshot): Promise<void> {
    if (s.empty || this.context.globalState.get("optimaizr.welcomed")) return;
    await this.context.globalState.update("optimaizr.welcomed", true);
    const pitch =
      s.allIn && s.allIn.share >= 0.05
        ? `Up to ${Math.round(s.allIn.share * 100)}% of your Claude Code usage can be saved.`
        : s.plan
          ? `Your ${s.plan.label} did ${Math.round(s.plan.multiple * 10) / 10}x its price in work this month.`
          : "Your Claude Code savings are ready.";
    const pick = await vscode.window.showInformationMessage(
      `${pitch} Read on this machine, nothing uploaded.`,
      "Show me",
    );
    if (pick) void vscode.commands.executeCommand("optimaizr.home.focus");
  }

  /* What the views ask for */

  handle(m: FromView): void {
    switch (m.type) {
      case "ready":
        this.postState();
        break;
      case "refresh":
        void this.analyze(true);
        break;
      case "guard":
        void (m.on ? this.guardOn(true) : this.run(true, "guard", guardOff));
        break;
      case "compact":
        void this.run(true, "compact", m.on ? () => compactOn() : compactOff);
        break;
      case "done": {
        const fix = this.snapshot?.fixes.find((f) => f.rule === m.rule);
        if (fix) void this.run(true, `done:${fix.rule}`, () => markDone(fix));
        break;
      }
      case "undoDone":
        void this.run(true, `done:${m.rule}`, () => undoDone(m.rule));
        break;
      case "openReport":
        openReport(this.root, this);
        break;
      case "openSettings":
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `@ext:${this.context.extension.id}`,
        );
        break;
      case "link":
        if (/^https:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
    }
  }

  /** Run one change, lay the files' new state over the snapshot and say how it went. */
  async run(
    fromView: boolean,
    what: string,
    act: () => ActionResult | Promise<ActionResult>,
  ): Promise<void> {
    this.busy = what;
    this.postLive();
    let r: ActionResult;
    try {
      r = await act();
    } catch (err) {
      r = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    this.busy = null;
    if (this.snapshot) this.snapshot = withLocalState(this.snapshot);
    this.postState();
    this.say(fromView, r);
  }

  private say(fromView: boolean, r: ActionResult): void {
    if (fromView && this.views.size > 0) this.send({ type: "toast", ok: r.ok, text: r.message });
    else if (r.ok) void vscode.window.showInformationMessage(r.message);
    else void vscode.window.showErrorMessage(r.message);
  }

  /** Guard's hooks run the CLI, so without it the first step is installing it. */
  async guardOn(fromView: boolean): Promise<void> {
    const bin = findCli(cfg().get("cliPath", ""));
    this.cli = bin ? "found" : "missing";
    if (bin) return this.run(fromView, "guard", () => setGuard(bin, true));
    this.busy = null;
    this.postState();
    const install = "Install and turn on";
    const pick = await vscode.window.showInformationMessage(
      "Guard runs through the optimAIzr CLI, which is not on this machine yet. Install it with npm and turn guard on?",
      install,
      "Not now",
    );
    if (pick !== install) return;
    const term = vscode.window.createTerminal({ name: "optimAIzr" });
    term.show();
    term.sendText("npm i -g optimaizr && optimaizr guard on");
    this.waitForGuard(fromView);
  }

  private waitForGuard(fromView: boolean): void {
    clearInterval(this.guardWait);
    const until = Date.now() + 5 * 60_000;
    this.guardWait = setInterval(() => {
      if (guardApplied()) {
        clearInterval(this.guardWait);
        this.cli = "found";
        if (this.snapshot) this.snapshot = withLocalState(this.snapshot);
        this.postState();
        this.say(fromView, {
          ok: true,
          message: "Guard is on. New Claude Code conversations pick it up.",
        });
      } else if (Date.now() > until) {
        clearInterval(this.guardWait);
      }
    }, 2_000);
  }

  /* Heads-ups: one window says each, the one whose folder it is if it is open */

  notice(n: LiveNotice): void {
    if (!cfg().get<boolean>(ALERT[n.kind], true)) return;
    if (n.kind === "guard" && this.snapshot) {
      this.snapshot = withLocalState(this.snapshot);
      this.postState();
    }
    const go = () => {
      if (claim(n.key)) void this.speak(n);
    };
    if (n.project && inFolders(n.project, folders())) go();
    else setTimeout(go, OWNER_WAIT_MS);
  }

  private async speak(n: LiveNotice): Promise<void> {
    const open = "Open savings";
    const title = clip(n.title, 48);
    switch (n.kind) {
      case "expiring": {
        const mute = "Mute cache warnings";
        const pick = await vscode.window.showWarningMessage(
          expiringText(n.title, n.leftMs, n.rewriteUsd),
          open,
          mute,
        );
        if (pick === mute)
          await cfg().update("alerts.cacheExpiring", false, vscode.ConfigurationTarget.Global);
        if (pick === open) this.focus();
        return;
      }
      case "cold": {
        const on = "Turn on guard";
        const guarded = guardApplied();
        const text =
          coldText(n.title, n.rewriteTokens, n.rewriteUsd) +
          (guarded ? "" : " Guard can hold that message next time.");
        const pick = await vscode.window.showInformationMessage(
          text,
          ...(guarded ? [open] : [on, open]),
        );
        if (pick === on) await this.guardOn(false);
        if (pick === open) this.focus();
        return;
      }
      case "long": {
        const compact = "Compact at 200K";
        const set = Boolean(this.snapshot?.compaction.at);
        const pick = await vscode.window.showInformationMessage(
          longText(n.title, n.context, n.rereadUsd),
          ...(set ? [open] : [compact, open]),
        );
        if (pick === compact) await this.run(false, "compact", () => compactOn());
        if (pick === open) this.focus();
        return;
      }
      case "guard": {
        const t = guardCatchText(n.receipt);
        const pick = await vscode.window.showInformationMessage(
          `${t.title} in "${title}". ${t.text}`,
          open,
        );
        if (pick === open) this.focus();
        return;
      }
      case "done": {
        const body = doneText(n.workMs, n.costUsd, n.percent);
        if (vscode.window.state.focused) {
          vscode.window.setStatusBarMessage(
            `$(check) Claude finished "${clip(n.title, 32)}". ${body}`,
            8_000,
          );
        } else if (canNotify()) {
          notify(`Claude is done: ${title}`, body);
        } else {
          void vscode.window.showInformationMessage(`Claude finished "${title}". ${body}`);
        }
        return;
      }
    }
  }

  focus(): void {
    void vscode.commands.executeCommand("optimaizr.home.focus");
  }
}

/* The status bar: context, cache countdown and the 5-hour window, every second */

function statusBar(hub: Hub): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    "optimaizr.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = "optimAIzr";
  item.command = "optimaizr.focus";
  let tip = "";
  const paint = () => {
    if (!cfg().get<boolean>("statusBar.enabled", true)) {
      item.hide();
      return;
    }
    const v = statusView(hub.live.state(), hub.snapshot, hub.loading);
    item.text = v.text;
    item.backgroundColor =
      v.level === "hot"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : v.level === "warn"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    if (v.tooltip !== tip) {
      tip = v.tooltip;
      const md = new vscode.MarkdownString(v.tooltip, true);
      md.isTrusted = { enabledCommands: ["optimaizr.focus"] };
      item.tooltip = md;
    }
    item.show();
  };
  paint();
  const timer = setInterval(paint, 1_000);
  return new vscode.Disposable(() => {
    clearInterval(timer);
    item.dispose();
  });
}

export function activate(context: vscode.ExtensionContext): void {
  pruneClaims();
  const hub = new Hub(context);
  const sub = (...d: vscode.Disposable[]) => context.subscriptions.push(...d);

  sub(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.id,
      new SidebarProvider(hub.root, hub),
    ),
    statusBar(hub),
    vscode.commands.registerCommand("optimaizr.focus", () => hub.focus()),
    vscode.commands.registerCommand("optimaizr.refresh", () => hub.analyze(true)),
    vscode.commands.registerCommand("optimaizr.openReport", () => openReport(hub.root, hub)),
    vscode.commands.registerCommand("optimaizr.guardOn", () => hub.guardOn(false)),
    vscode.commands.registerCommand("optimaizr.guardOff", () => hub.run(false, "guard", guardOff)),
    vscode.commands.registerCommand("optimaizr.compactOn", () =>
      hub.run(false, "compact", () => compactOn()),
    ),
    vscode.commands.registerCommand("optimaizr.compactOff", () =>
      hub.run(false, "compact", compactOff),
    ),
    vscode.commands.registerCommand("optimaizr.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id}`,
      ),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("optimaizr.days")) void hub.analyze(true);
      if (e.affectsConfiguration("optimaizr.cliPath")) {
        hub.cli = findCli(cfg().get("cliPath", "")) ? "found" : "missing";
        hub.postState();
      }
    }),
  );

  hub.live.start();
  const every = setInterval(() => void hub.analyze(false), EVERY_MS);
  // The 5-hour reading and the warm list move without new calls.
  const liveEvery = setInterval(() => hub.postLive(), 15_000);
  sub(
    new vscode.Disposable(() => {
      clearInterval(every);
      clearInterval(liveEvery);
      hub.live.stop();
    }),
  );
  void hub.analyze(false);
}

export function deactivate(): void {}
