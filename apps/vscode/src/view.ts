import crypto from "node:crypto";
import * as vscode from "vscode";
import type { FromView, ToView } from "./types.js";

/** The page both the sidebar and the report load; the script fills it in. */
export function pageHtml(
  webview: vscode.Webview,
  root: vscode.Uri,
  mode: "sidebar" | "report",
): string {
  const nonce = crypto.randomBytes(18).toString("base64");
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, "dist", "webview.css"));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, "dist", "webview.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>optimAIzr</title>
</head>
<body class="${mode}" data-mode="${mode}">
<main id="app"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

export interface Host {
  attach(webview: vscode.Webview): vscode.Disposable;
  handle(m: FromView): void;
}

function wire(webview: vscode.Webview, root: vscode.Uri, mode: "sidebar" | "report", host: Host) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(root, "dist"), vscode.Uri.joinPath(root, "media")],
  };
  webview.html = pageHtml(webview, root, mode);
  return [host.attach(webview), webview.onDidReceiveMessage((m: FromView) => host.handle(m))];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly id = "optimaizr.home";
  constructor(
    private readonly root: vscode.Uri,
    private readonly host: Host,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const subs = wire(view.webview, this.root, "sidebar", this.host);
    view.onDidDispose(() => subs.forEach((d) => d.dispose()));
  }
}

let report: vscode.WebviewPanel | null = null;

/** One report tab; asking again brings it forward. */
export function openReport(root: vscode.Uri, host: Host): void {
  if (report) {
    report.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "optimaizr.report",
    "optimAIzr report",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
    },
  );
  panel.iconPath = vscode.Uri.joinPath(root, "media", "icon.png");
  const subs = wire(panel.webview, root, "report", host);
  panel.onDidDispose(() => {
    subs.forEach((d) => d.dispose());
    report = null;
  });
  report = panel;
}

export function post(webview: vscode.Webview, m: ToView): void {
  void webview.postMessage(m);
}
