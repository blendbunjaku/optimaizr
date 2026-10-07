/**
 * @optimaizr/local: the Node host (local storage, the SDK wrapper, replay).
 * Everything that touches a filesystem, network or process lives here, so
 * @optimaizr/core stays pure.
 */

export * from "./ledger.js";
export * from "./samples.js";
export * from "./decisions.js";
export * from "./verifications.js";
export * from "./wrap.js";
export * from "./live.js";
export * from "./rewriters.js";
export * from "./overrides.js";
export * from "./claude-mod.js";
export * from "./claude-account.js";
export * from "./compaction.js";
export * from "./statusline.js";
// Optional, opt-in, and the only outbound path in this package.
export * from "./jev.js";
export * from "./verify/replay.js";

// Registering an adapter is a side effect of importing it.
export * from "./providers/anthropic.js";
export * from "./providers/openai.js";
export * from "./providers/exports.js";
export * from "./providers/shapes.js";
