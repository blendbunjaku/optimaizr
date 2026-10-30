import { clip, duration, folder, money, tokens } from "./format.js";

// What each heads-up says. Kept apart from the editor so the wording is tested
// and the sidebar's guard list reads the same as the notification did.

export interface GuardReceiptLike {
  at: string;
  session: string;
  kind: string;
  usd?: number;
  tokens?: number;
  detail?: string;
}

/** The kinds worth telling someone about; the rest are bookkeeping. */
export const GUARD_SAID = new Set(["cold-hold", "big-read", "retry", "handoff-used"]);

export function guardCatchText(r: GuardReceiptLike): { title: string; text: string } {
  const tok = r.tokens ? tokens(r.tokens) : "all of it";
  switch (r.kind) {
    case "cold-hold":
      return {
        title: "Held a message",
        text: `Its cache had expired, so sending it would write ${tok} again (${money(r.usd ?? 0)}). Send it again and it goes through.`,
      };
    case "big-read":
      return {
        title: "Held a big read",
        text: `${r.detail ? folder(r.detail) : "A file"} is about ${tok} tokens whole, so Claude was asked to read just the part it needs.`,
      };
    case "retry":
      return {
        title: "Held a retry",
        text: `${r.detail ? `"${clip(r.detail, 40)}"` : "A command"} failed twice with nothing changed, so it was not run a third time.`,
      };
    case "handoff-used":
      return {
        title: "Started from the note",
        text: `After /clear the new conversation started from guard's note: ${money(r.usd ?? 0)} of rewrite not spent.`,
      };
    case "compact":
      return { title: "Suggested /compact", text: `At ${tok}, near where it compacts anyway.` };
    default:
      return { title: "Guard", text: r.kind };
  }
}

const quoted = (title: string) => `"${clip(title, 48)}"`;

export function expiringText(title: string, leftMs: number, rewriteUsd: number): string {
  const min = Math.max(1, Math.round(leftMs / 60_000));
  return `${min} min left on the cache for ${quoted(title)}. Reply before then to skip a ${money(rewriteUsd)} rewrite.`;
}

export function coldText(title: string, rewriteTokens: number, rewriteUsd: number): string {
  return `${quoted(title)} came back after its cache expired: ${money(rewriteUsd)} to write ${tokens(rewriteTokens)} again.`;
}

export function longText(title: string, context: number, rereadUsd: number): string {
  const per = rereadUsd >= 0.01 ? ` (${money(rereadUsd)} a call)` : "";
  return `${quoted(title)} passed ${tokens(context)} tokens. Every message now re-reads all of it${per}, so compacting between tasks pays.`;
}

export function doneText(workMs: number, costUsd: number, percent: number | null): string {
  const share =
    percent !== null && percent >= 0.5 ? `, ${Math.round(percent)}% of your 5h window` : "";
  return `Worked ${duration(workMs)}, ${money(costUsd)}${share}.`;
}
