// Builds the npm package. @optimaizr/core and @optimaizr/local aren't
// published, so both entry points are bundled with esbuild (otherwise the
// installed package fails with MODULE_NOT_FOUND). Neither has third-party
// deps. Provider SDKs are optional peers and are loaded at runtime.

import { build } from "esbuild";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const SHEBANG = "#!/usr/bin/env node";

// start clean so old files don't end up in the tarball
await rm("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@anthropic-ai/sdk"],
  // Source maps only with OPTIMAIZR_SOURCEMAP=1, for local debugging. They
  // embed the full source (~400KB) and `files` excludes *.map anyway.
  sourcemap: process.env.OPTIMAIZR_SOURCEMAP === "1",
  logLevel: "info",
  // for --version, since there's no package.json next to the bundle
  define: { __OPTIMAIZR_VERSION__: JSON.stringify(version) },
};

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
});

await build({
  ...common,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

// esbuild can move the shebang off line 1, which breaks the bin. Put it back.
const cli = await readFile("dist/cli.js", "utf8");
const body = cli.startsWith(SHEBANG) ? cli.slice(SHEBANG.length).trimStart() : cli;
await writeFile("dist/cli.js", `${SHEBANG}\n${body}`);

// otherwise `npx optimaizr` fails with EACCES
await chmod("dist/cli.js", 0o755);

console.log("bundled dist/cli.js and dist/index.js");
