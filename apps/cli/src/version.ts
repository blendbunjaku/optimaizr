// Injected by scripts/bundle.mjs: the published CLI is a bundle with no
// package.json beside it to read.
declare const __OPTIMAIZR_VERSION__: string;

export const VERSION = typeof __OPTIMAIZR_VERSION__ === "string" ? __OPTIMAIZR_VERSION__ : "dev";
