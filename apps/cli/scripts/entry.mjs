#!/usr/bin/env node
// The bin, copied to dist/cli.js. It checks the Node version before loading the
// bundle, so an old Node says how to upgrade instead of failing deep inside it.
// Keep it to syntax Node 12 can parse.

const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 20 || (major === 20 && minor < 11)) {
  console.error(`optimaizr needs Node 20.11 or later, and this is Node ${process.versions.node}.`);
  console.error("Get a newer one from https://nodejs.org, or with nvm: nvm install 20");
  process.exitCode = 1;
} else {
  import("./main.js");
}
