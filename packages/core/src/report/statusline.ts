import { type CacheState, COUNTDOWN_MS } from "../analyze/cache-watch.js";
import { COLD_MIN_CONTEXT } from "../analyze/cold.js";
import { tokens as fmtTokens, usd } from "../pricing.js";
import { minutesLabel } from "./terminal.js";

/**
 * The line `optimaizr statusline` prints under Claude Code's prompt: how big the
 * conversation is, what each call pays to read it, and how long its cache stays
 * warm. Claude Code's output is a pipe, so colour is decided here, not by isTTY.
 */

export interface StatuslineMeter {
  usedPercent: number;
  /** Unix seconds, as Claude Code sends it. */
  resetsAt: number | null;
}

export interface StatuslineInput {
  /** The session's last call, read from its transcript. */
  state: CacheState | null;
  /** Claude Code's own context count, used when the transcript gave nothing. */
  contextTokens?: number | null;
  fiveHour?: StatuslineMeter | null;
  sevenDay?: StatuslineMeter | null;
  now: number;
  color?: boolean;
}

const ESC = String.fromCharCode(27);

export function renderStatusline(i: StatuslineInput): string {
  const paint = (code: string) => (s: string) =>
    i.color === false ? s : `${ESC}[${code}m${s}${ESC}[0m`;
  const dim = paint("2");
  const yellow = paint("33");
  const blue = paint("36");

  const parts: string[] = [`${blue("◉")} optimAIzr`];
  const s = i.state;
  const context = s?.context ?? i.contextTokens ?? 0;

  if (context > 0) {
    const long = context >= COLD_MIN_CONTEXT;
    parts.push(
      long && s && s.readUsd > 0
        ? `${fmtTokens(context)} context, ${usd(s.readUsd)}/call to re-read`
        : `${fmtTokens(context)} context`,
    );
    if (long && s && s.expiresAt !== null) {
      const left = s.expiresAt - i.now;
      if (left <= 0) {
        parts.push(
          yellow(`cache expired, next message writes it all again (${usd(s.rewriteUsd)})`),
        );
        parts.push(dim("new task? /clear first"));
      } else if (left <= COUNTDOWN_MS) {
        parts.push(
          yellow(`cache warm ${minutesLabel(left)}, then ${usd(s.rewriteUsd)} to write again`),
        );
        parts.push(dim("leaving? handoff note, then /clear"));
      } else {
        parts.push(dim(`cache warm ${minutesLabel(left)}`));
      }
    }
  }

  const meter = (label: string, m: StatuslineMeter | null | undefined, always: boolean) => {
    if (!m || (!always && m.usedPercent < 75)) return;
    const pct = Math.round(m.usedPercent);
    const text = `${label} ${pct}%`;
    parts.push(pct >= 80 ? yellow(text) : dim(text));
  };
  meter("5h", i.fiveHour, true);
  meter("week", i.sevenDay, false);

  return parts.join(dim(" · "));
}
