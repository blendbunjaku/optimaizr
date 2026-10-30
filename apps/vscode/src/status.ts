import { clock, countdown, money, multiple, tokens } from "./format.js";
import type { LiveState, Snapshot } from "./types.js";

// What the status bar item says. Plain strings with codicons, worked out
// apart from the editor so it can be tested.

const COMPACT_AT = 200_000;
const SOON_MS = 5 * 60_000;

export interface StatusView {
  text: string;
  /** Markdown, codicons allowed. */
  tooltip: string;
  level: "ok" | "warn" | "hot";
}

export function statusView(live: LiveState, s: Snapshot | null, loading: boolean): StatusView {
  const c = live.convo;
  const five = live.fiveHour;
  const fiveText = five ? `5h ${Math.round(five.percent)}%` : "";
  const level: StatusView["level"] =
    five && five.percent >= 90
      ? "hot"
      : c?.expiresAt && c.expiresAt > live.now && c.expiresAt - live.now <= SOON_MS
        ? "warn"
        : "ok";

  if (!c) {
    const pitch =
      !s || s.empty
        ? loading
          ? "$(sync~spin) optimAIzr"
          : "$(sparkle) optimAIzr"
        : s.allIn && s.allIn.share >= 0.05
          ? `$(sparkle) Save up to ${Math.round(s.allIn.share * 100)}%`
          : s.plan
            ? `$(sparkle) ${s.plan.label} ${multiple(s.plan.multiple)}`
            : "$(sparkle) optimAIzr";
    return {
      text: [pitch, fiveText].filter(Boolean).join(" · "),
      tooltip: tooltip(live, s),
      level,
    };
  }

  const parts = [`$(layers) ${tokens(c.context)}`];
  if (c.expiresAt !== null) {
    const left = c.expiresAt - live.now;
    parts.push(left > 0 ? `$(watch) ${countdown(left)}` : "$(watch) cold");
  }
  if (fiveText) parts.push(fiveText);
  return { text: parts.join(" · "), tooltip: tooltip(live, s), level };
}

/** Changes at most once a minute, so it does not flicker while hovered. */
export function tooltip(live: LiveState, s: Snapshot | null): string {
  const lines: string[] = [];
  const c = live.convo;
  if (c) {
    lines.push(`**optimAIzr** · ${escape(c.title)}`);
    const ctx =
      c.context >= COMPACT_AT
        ? "past 200K, compact between tasks"
        : `of ${tokens(COMPACT_AT)}, where compacting starts to pay`;
    lines.push(`$(layers) Context **${tokens(c.context)}** ${ctx}`);
    if (c.expiresAt !== null) {
      const left = c.expiresAt - live.now;
      lines.push(
        left > 0
          ? `$(watch) Cache warm for about **${Math.max(1, Math.round(left / 60_000))} min**. Replying in time costs ${money(c.readUsd)}, after costs ${money(c.rewriteUsd)}.`
          : `$(watch) Cache expired. The next message writes it again for ${money(c.rewriteUsd)}.`,
      );
    }
  } else {
    lines.push("**optimAIzr**", "No Claude Code conversation in this folder right now.");
  }
  const five = live.fiveHour;
  if (five) {
    const reset = five.resetsAt ? `, resets ${clock(five.resetsAt)}` : "";
    lines.push(
      `$(dashboard) 5-hour window **${Math.round(five.percent)}%**${reset}${five.basis === "estimate" ? " (estimate)" : ""}`,
    );
  }
  if (s && !s.empty) {
    lines.push("---");
    if (s.allIn && s.allIn.share >= 0.05) {
      lines.push(
        `$(sparkle) Up to **${Math.round(s.allIn.share * 100)}%** of your usage can be saved.`,
      );
    } else if (s.plan) {
      lines.push(
        `$(sparkle) Your ${escape(s.plan.label)} did **${money(s.plan.valueMonthlyUsd)}/mo** of work, ${multiple(s.plan.multiple)} what you pay.`,
      );
    }
    if (s.guard.on)
      lines.push(
        `$(check) Guard is on${s.guard.savedUsd >= 0.01 ? `, kept ${money(s.guard.savedUsd)} this week` : ""}.`,
      );
  }
  lines.push("[Open savings](command:optimaizr.focus)");
  return lines.join("\n\n");
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>$]/g, "\\$&");
}
