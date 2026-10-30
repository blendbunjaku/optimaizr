import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// One CommonJS file per entry, with core and local inlined: the extension host
// loads it as is, so nothing has to be installed next to it.
const root = new URL("..", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
process.chdir(fileURLToPath(root));

const sourcemap = process.env.OPTIMAIZR_SOURCEMAP === "1";
const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "@anthropic-ai/sdk", "openai"],
  sourcemap,
  logLevel: "warning",
  define: { __EXTENSION_VERSION__: JSON.stringify(pkg.version) },
};

await Promise.all([
  build({ ...node, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" }),
  build({ ...node, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" }),
  // The pieces that need no editor, for node:test.
  build({ ...node, entryPoints: ["src/lib.ts"], outfile: "dist/lib.cjs" }),
  build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap,
    logLevel: "warning",
    entryPoints: ["webview/main.ts"],
    outfile: "dist/webview.js",
  }),
]);
fs.copyFileSync("webview/style.css", "dist/webview.css");
console.log(`optimaizr-vscode ${pkg.version} bundled to dist/`);
