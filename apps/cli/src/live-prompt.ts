import {
  accept,
  proposedChange,
  nextCommandFor,
  usd,
  bold,
  callActivity,
  callSession,
  dim,
  green,
  projectName,
  red,
  yellow,
  blue,
  wrap as wrapText,
  type ApplyOutcome,
  type LiveRecommendation,
  type OptimizationFinding,
  type RequestRewriter,
} from "@optimaizr/core";

/**
 * The interactive half of `optimaizr live`. It must never overstate what Y did
 * (the call on screen is already billed; `accept()` says `queued` when nothing
 * took the change), must not nag (low-confidence findings are printed, not
 * prompted, and each rule/route is raised once per session), and must
 * serialise prompts while events keep arriving.
 */

export interface PromptOptions {
  /** False for --json, a non-TTY, or --no-prompt: print instead of asking. */
  interactive: boolean;
  /** Was --jev passed? Changes what the "Why?" screen can claim. */
  jevEnabled: boolean;
  /** --dry-run: change nothing, record nothing. */
  dryRun: boolean;
  /** The pre-request integrations Y can use. Each acts only on its own traffic. */
  rewriters?: RequestRewriter[];
  /** A single rewriter; shorthand for `rewriters: [r]`. */
  rewriter?: RequestRewriter;
  /** How to print a recommendation when not prompting. */
  render: (rec: LiveRecommendation) => string;
  /** Called on Ctrl-C from inside a prompt. */
  onExit: () => void;
  /**
   * Terminal I/O, injectable so the Y / N / D paths can be driven in tests
   * without a pty. Defaults to a real keypress read and `console.log`.
   */
  io?: { read: () => Promise<string>; write: (line: string) => void };
  /** Around every question, so a status line can step aside while one is open. */
  onAsk?: () => void;
  onAnswered?: () => void;
}

export interface LivePrompt {
  /** Queue a recommendation for display. Never rejects. */
  offer: (rec: LiveRecommendation) => void;
  /**
   * Ask a yes/no question in turn with the recommendations, run `act` on Y and
   * print what it returns. Printed without asking when not interactive.
   */
  confirm: (card: string, act: () => string) => void;
  /** Resolves once every queued prompt has been answered. */
  drain: () => Promise<void>;
}

/**
 * Prompt only for findings worth interrupting for. Confidence is the gate, not
 * money: a finding climbs from `low` to `medium` as the window fills, so early
 * provisional findings are printed instead. `--min-usd` is applied upstream.
 */
function worthPrompting(f: OptimizationFinding): boolean {
  return f.savings.confidence !== "low";
}

/** Stable identity for "the same recommendation about the same traffic". */
function keyOf(rec: LiveRecommendation): string {
  return `${rec.finding.rule}::${rec.trigger.route ?? rec.trigger.model}`;
}

/** Read one keypress, restoring terminal state whatever happens. */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* not a tty after all */
    }
    stdin.resume();
    const done = (key: string) => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        /* ignore */
      }
      stdin.pause();
      resolve(key);
    };
    const onData = (buf: Buffer) => done(buf.toString("utf8"));
    stdin.on("data", onData);
  });
}

const CONFIDENCE_WORD = { high: "high confidence", medium: "likely", low: "possible" } as const;

/** A labelled line with a hanging indent, the way every card in optimAIzr reads. */
function line(out: string[], label: string, value: string, width = 52): void {
  const lines = wrapText(value, width);
  out.push(`  ${dim(label.padEnd(15))} ${lines[0] ?? ""}`);
  for (const rest of lines.slice(1)) out.push(`  ${" ".repeat(15)} ${rest}`);
}

function renderCard(rec: LiveRecommendation): string {
  const f = rec.finding;
  const change = proposedChange(f);
  const out: string[] = [];
  const mins = Math.max(1, Math.round(rec.windowMs / 60_000));

  out.push("");
  out.push(
    `  ${yellow("⚡")} ${bold("optimAIzr")} ${dim("·")} ${bold(rec.recommendation.action)} ${dim("·")} ${CONFIDENCE_WORD[f.savings.confidence]}`,
  );
  out.push("");
  line(out, "What happened", f.title);
  line(out, "Why it matters", f.why);
  if (change.from && change.to) {
    out.push(`  ${dim("Change".padEnd(15))} ${change.from} ${dim("->")} ${green(change.to)}`);
  } else {
    line(out, "Change", change.label);
  }
  out.push(
    `  ${dim("Saving".padEnd(15))} ${bold(green(usd(rec.observedUsd)))} ${dim(`could have been saved on ${f.affected.calls} call${f.affected.calls === 1 ? "" : "s"} in the last ${mins} min`)}`,
  );
  const latest = rec.examples[0];
  if (latest) {
    const more = rec.sessions > 1 ? dim(` (+${rec.sessions - 1} more sessions)`) : "";
    out.push(
      `  ${dim("Latest".padEnd(15))} ${callSession(latest)} ${dim(projectName(latest.project))} ${callActivity(latest, 36)}${more}`,
    );
  }
  out.push("");
  out.push(`  ${bold("[Y]")} Apply   ${bold("[N]")} Not now   ${bold("[D]")} Why?`);
  return out.join("\n");
}

/** The "Why?" screen: the local evidence, and Jev's part in it if it had one. */
function renderWhy(rec: LiveRecommendation, jevEnabled: boolean): string {
  const f = rec.finding;
  const s = f.savings;
  const out: string[] = [];

  /** A labelled field, wrapped with a hanging indent so long values stay readable. */
  const field = (label: string, value: string) => {
    const lines = wrapText(value, 52);
    out.push(`  ${dim(label.padEnd(12))} ${lines[0] ?? ""}`);
    for (const line of lines.slice(1)) out.push(`  ${" ".repeat(12)} ${dim(line)}`);
  };

  out.push("");
  out.push(`  ${bold("Why optimAIzr flagged this")}`);
  out.push("");
  field("Rule", `${f.rule} - a local rule, on ${rec.windowEvents} calls in the live window`);
  field("Basis", `${s.evidence.kind} - ${s.evidence.basis}`);
  field(
    "Affected",
    `${f.affected.calls} calls, ${(f.affected.share * 100).toFixed(0)}% of window spend`,
  );
  field("Confidence", `${s.confidence} - ${s.confidenceBasis}`);
  out.push("");

  for (const line of wrapText(s.calculation, 64)) out.push(`  ${dim(line)}`);

  if (f.observations.length > 0) {
    out.push("");
    for (const o of f.observations.slice(0, 3)) out.push(`  ${dim("-")} ${o}`);
  }

  if (s.assumptions.length > 0) {
    out.push("");
    out.push(`  ${bold("Assuming")}`);
    for (const a of s.assumptions.slice(0, 3)) {
      const lines = wrapText(a, 62);
      out.push(`  ${dim("-")} ${dim(lines[0] ?? "")}`);
      for (const line of lines.slice(1)) out.push(`    ${dim(line)}`);
    }
  }

  out.push("");
  out.push(`  ${bold("Semantic judgment")}`);
  if (rec.judged) {
    const pct = (rec.judged.needsFrontierShare * 100).toFixed(0);
    out.push(
      `  ${blue("Jev")} ${dim("judged this traffic:")} ${pct}% ${dim(`likely it needs its current model (${rec.judged.sampled} calls judged).`)}`,
    );
    out.push(`  ${dim("Jev agreed the work is mechanical, so the suggestion stands.")}`);
    out.push(`  ${dim("Jev saw route names and token counts only - never prompts or outputs.")}`);
  } else if (jevEnabled) {
    out.push(`  ${dim("Jev had no verdict for this traffic yet. This is a local rules-only")}`);
    out.push(`  ${dim("detection; Jev changes nothing unless it has an opinion.")}`);
  } else {
    out.push(`  ${dim("Not used. This is a local rules-only detection.")}`);
  }

  out.push("");
  out.push(`  ${dim("Next if you accept:")} ${nextCommandFor(f)}`);
  return out.join("\n");
}

/** A step the user can take by hand to make the change reach the running session. */
function renderNow(now: string | undefined): string[] {
  if (!now) return [];
  const [first = "", ...rest] = wrapText(now, 60);
  return ["", `  ${bold("Now:")} ${first}`, ...rest.map((line) => `       ${line}`)];
}

function renderOutcome(outcome: ApplyOutcome, dryRun: boolean): string {
  const out: string[] = [];
  out.push("");
  switch (outcome.kind) {
    case "applied":
      out.push(`  ${green("Applied")} ${dim(`via ${outcome.via}`)}`);
      for (const line of wrapText(outcome.detail, 66)) out.push(`  ${dim(line)}`);
      for (const r of outcome.also ?? []) {
        out.push(
          r.applied
            ? `  ${green("Applied")} ${dim(`via ${r.via}`)}`
            : `  ${yellow("Not applied")} ${dim(`via ${r.via}`)}`,
        );
        for (const line of wrapText(r.detail, 66)) out.push(`  ${dim(line)}`);
      }
      out.push(...renderNow(outcome.now));
      break;
    case "queued":
      // Say what did not happen, first.
      if (outcome.declined) {
        out.push(`  ${yellow("Not applied")} ${dim("-")} ${dim(outcome.reason)}.`);
      } else {
        out.push(`  ${yellow("Not applied to that call")} ${dim("-")} ${dim(outcome.reason)}.`);
        for (const line of wrapText(
          "optimaizr live watches the ledger, which is written after a response returns, " +
            "so it reports on calls that have already been billed.",
          66,
        )) {
          out.push(`  ${dim(line)}`);
        }
      }
      out.push(...renderNow(outcome.now));
      out.push("");
      out.push(
        dryRun
          ? `  ${dim("Dry run: nothing was recorded.")} ${dim("Next would be:")} ${bold(outcome.next)}`
          : `  ${green("Recorded.")} ${dim("Next:")} ${bold(outcome.next)}`,
      );
      break;
    case "failed":
      out.push(`  ${red("Could not apply")}`);
      for (const line of wrapText(outcome.detail, 66)) out.push(`  ${dim(line)}`);
      break;
  }
  return out.join("\n");
}

export function createLivePrompt(opts: PromptOptions): LivePrompt {
  /** rule::route already raised this session, whatever the answer was. */
  const seen = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  const read = opts.io?.read ?? readKey;
  const write = opts.io?.write ?? ((line: string) => console.log(line));

  /** Run one question with the status line out of the way. */
  async function asking(q: () => Promise<void>): Promise<void> {
    opts.onAsk?.();
    try {
      await q();
    } finally {
      opts.onAnswered?.();
    }
  }

  async function yesNo(card: string, act: () => string): Promise<void> {
    write(card);
    for (;;) {
      write(`\n  ${dim("[Y/N]")} `);
      const key = await read();
      const k = key.toLowerCase();
      if (key === "\u0003") {
        opts.onExit();
        return;
      }
      if (k === "y") {
        write(act());
        return;
      }
      if (k === "n" || key === "\r" || key === "\n") {
        write(`  ${dim("Not now. It won't be asked again this session.")}`);
        return;
      }
      write(`  ${dim("Press Y or N.")}`);
    }
  }

  async function ask(rec: LiveRecommendation): Promise<void> {
    write(renderCard(rec));

    for (;;) {
      write(`\n  ${dim("[Y/N/D]")} `);
      const key = await read();
      const k = key.toLowerCase();

      if (key === "") {
        // Ctrl-C inside a prompt must behave like Ctrl-C anywhere else.
        opts.onExit();
        return;
      }

      if (k === "d") {
        write(renderWhy(rec, opts.jevEnabled));
        continue; // and straight back to the same choice
      }

      if (k === "y") {
        const outcome = accept(rec.finding, {
          ...(opts.rewriters ? { rewriters: opts.rewriters } : {}),
          ...(opts.rewriter ? { rewriter: opts.rewriter } : {}),
          traffic: rec.traffic,
          dryRun: opts.dryRun,
        });
        write(renderOutcome(outcome, opts.dryRun));
        return;
      }

      if (k === "n" || key === "\r" || key === "\n") {
        // Dismissal lasts for this session only. Writing `rejected` would hide
        // the finding from `optimaizr recommend` too, a bigger decision.
        write(`  ${dim("Continuing. This one won't be raised again this session.")}`);
        return;
      }

      write(`  ${dim("Press Y, N or D.")}`);
    }
  }

  return {
    offer(rec: LiveRecommendation): void {
      const key = keyOf(rec);
      if (seen.has(key)) return; // never twice for the same rule and route
      // A withheld finding is news, not a proposal: there is nothing to accept.
      if (rec.withheld) {
        seen.add(key);
        write(opts.render(rec));
        return;
      }
      if (!opts.interactive || !worthPrompting(rec.finding)) {
        // Print but don't prompt. `seen` isn't set, so it can still earn a
        // prompt once its confidence climbs.
        write(opts.render(rec));
        return;
      }
      seen.add(key);
      chain = chain.then(() => asking(() => ask(rec))).catch(() => undefined);
    },
    confirm(card: string, act: () => string): void {
      if (!opts.interactive) {
        write(card);
        return;
      }
      chain = chain.then(() => asking(() => yesNo(card, act))).catch(() => undefined);
    },
    drain(): Promise<void> {
      return chain;
    },
  };
}
