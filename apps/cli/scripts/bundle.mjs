// Builds the npm package. @optimaizr/core and @optimaizr/local aren't
// published, so both entry points are bundled with esbuild (otherwise the
// installed package fails with MODULE_NOT_FOUND). Neither has third-party
// deps. Provider SDKs are optional peers and are loaded at runtime.

import { build } from "esbuild";
import { chmod, copyFile, readFile, rm, writeFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
// `optimaizr changelog` works offline, so the notes travel inside the bundle.
const changelog = await readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");

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
  define: {
    __OPTIMAIZR_VERSION__: JSON.stringify(version),
    __OPTIMAIZR_CHANGELOG__: JSON.stringify(changelog),
  },
};

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/main.js",
});

await build({
  ...common,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

// The bundle is imported, not run, so it needs no shebang.
const main = await readFile("dist/main.js", "utf8");
if (main.startsWith("#!")) await writeFile("dist/main.js", main.slice(main.indexOf("\n") + 1));

// The bin checks the Node version, then imports the bundle.
await copyFile("scripts/entry.mjs", "dist/cli.js");
// otherwise `npx optimaizr` fails with EACCES
await chmod("dist/cli.js", 0o755);

console.log("bundled dist/main.js and dist/index.js, with dist/cli.js as the bin");
