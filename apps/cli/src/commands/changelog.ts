import { bold, dim } from "@optimaizr/core";
import type { Args } from "../args.js";
import { VERSION } from "../version.js";

// Injected by scripts/bundle.mjs, so the notes work offline.
declare const __OPTIMAIZR_CHANGELOG__: string;
const CHANGELOG = typeof __OPTIMAIZR_CHANGELOG__ === "string" ? __OPTIMAIZR_CHANGELOG__ : "";

/** Each `## x.y.z` section of the changelog, newest first. */
export function changelogSections(text = CHANGELOG): Array<{ version: string; body: string }> {
  const out: Array<{ version: string; body: string }> = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head = "", ...rest] = part.split("\n");
    out.push({ version: head.trim(), body: rest.join("\n").trim() });
  }
  return out;
}

/** Markdown made readable in a terminal: bold kept, the rest plain. */
function terminal(md: string): string[] {
  return md.split("\n").map((line) => {
    const plain = line.replace(/`([^`]+)`/g, "$1");
    return `  ${plain.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => bold(t))}`;
  });
}

/**
 * `optimaizr changelog`: what changed in the version you run. A version, or
 * `--all`, shows others.
 */
export function cmdChangelog(args: Args): void {
  const sections = changelogSections();
  const want = args.positional[0];
  const shown = args.flags.all
    ? sections
    : sections.filter((s) => s.version === (want ?? VERSION)).slice(0, 1);
  console.log("");
  if (shown.length === 0) {
    const known = sections.map((s) => s.version).join(", ");
    console.log(`  ${dim(`No notes for ${want ?? VERSION}.${known ? ` Known: ${known}.` : ""}`)}`);
    console.log("");
    return;
  }
  for (const s of shown) {
    console.log(`  ${bold(`optimAIzr ${s.version}`)}`);
    console.log("");
    for (const line of terminal(s.body)) console.log(line);
    console.log("");
  }
  if (!args.flags.all) {
    console.log(`  ${dim("Every version: optimaizr changelog --all")}`);
    console.log("");
  }
}
