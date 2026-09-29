import { modelLabel, usd, tokens as fmtTokens } from "../pricing.js";
import { verificationModeOf } from "../verify/state.js";
import type { OptimizationFinding, Recommendation, VerificationMode } from "../domain/types.js";

/** What the gate badge on a finding says, per verification mode. */
const GATE_LABEL: Record<VerificationMode, string> = {
  "not-required": "Safe to apply",
  replay: "Verify before applying",
  manual: "Needs your sign-off",
};
import type { Summary } from "../analyze/summary.js";

/**
 * Self-contained HTML dashboard: no network requests, so it can be emailed,
 * committed or opened offline. It leads with money; token analytics sit below
 * as evidence. The design tokens mirror the optimaizr.com stylesheet, copied
 * rather than linked so nothing is fetched.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JSON for embedding in a `<script>` block. Model ids, project names and routes
 * come from files we don't control, and a bare JSON.stringify would let
 * `</script>` close the block. Escaping `<`, `>` and `&` as \uXXXX prevents it.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const CATEGORY_LABEL: Record<string, string> = {
  "model-selection": "Model selection",
  "context-bloat": "Context and prompt bloat",
  caching: "Cache opportunities",
  reasoning: "Reasoning effort",
  retries: "Repeated requests",
  pricing: "Rate changes",
};

/** The recommendations block, as a function to keep the template nesting readable. */
function recommendationsSection(recs: Recommendation[]): string {
  if (recs.length === 0) return "";

  const items = recs
    .slice(0, 5)
    .map((r) => {
      const meta = [
        `<span>Impact <b class="impact-${r.impact}">${r.impact}</b></span>`,
        `<span>Confidence <b class="conf-${r.savings.confidence}">${r.savings.confidence}</b></span>`,
        `<span>Basis <b class="ev-${r.savings.evidence.kind}">${r.savings.evidence.kind}</b></span>`,
        `<span>Affects <b>${r.affected.calls.toLocaleString()}</b> requests</span>`,
        `<span>Annual <b>${usd(r.savings.annualUsd)}</b></span>`,
      ].join("");

      return [
        "<li>",
        '<div class="rec-head">',
        `<h3>${esc(r.action)}</h3>`,
        `<span class="rec-amount">${usd(r.savings.monthlyUsd)}<small>/mo</small></span>`,
        "</div>",
        `<p class="rec-why">${esc(r.rationale)}</p>`,
        `<div class="rec-meta">${meta}</div>`,
        "</li>",
      ].join("");
    })
    .join("");

  return `<section class="page-break">
  <h2>Top recommendations</h2>
  <ol class="recs">${items}</ol>
</section>`;
}

/**
 * Cache writes split by TTL: 1h writes bill at 2x input, 5m at 1.25x, and it's
 * the line item other cost tools most often price differently.
 */
function cacheWriteStat(summary: Summary): string {
  const writes = summary.cacheWrite5mTokens + summary.cacheWrite1hTokens;
  if (writes <= 0) return "";
  const share1h = (summary.cacheWrite1hTokens / writes) * 100;
  return `<div class="stat"><div class="stat-val">${share1h.toFixed(0)}%</div><div class="stat-key">Cache writes @1h</div><div class="stat-note">${fmtTokens(writes)} written</div></div>`;
}

function cacheWriteNote(summary: Summary): string {
  const writes = summary.cacheWrite5mTokens + summary.cacheWrite1hTokens;
  const parts: string[] = [];
  if (writes > 0) {
    parts.push(`<p class="est">Cache writes split ${fmtTokens(summary.cacheWrite1hTokens)} at the 1-hour TTL
  (billed at 2&times; the input rate) and ${fmtTokens(summary.cacheWrite5mTokens)} at the 5-minute TTL
  (1.25&times;). Cache reads bill at 0.1&times;. These are the published multipliers; a tool that prices
  every write at the 5-minute rate will report a lower total for the same tokens.</p>`);
  }
  if (summary.webSearches > 0) {
    parts.push(`<p class="est">${summary.webSearches.toLocaleString()} server-side web
  ${summary.webSearches === 1 ? "search" : "searches"} added ${usd(summary.cost.serverTools)} at
  $10 per 1,000. That charge is per search, not per token, so it appears in no token count above.</p>`);
  }
  return parts.join("\n");
}

export function renderHtml(
  summary: Summary,
  findings: OptimizationFinding[],
  extras: { recommendations?: Recommendation[]; org?: string } = {},
): string {
  const actionable = findings.filter((f) => !f.advisory);
  const advisories = findings.filter((f) => f.advisory);
  const monthlySavings = actionable.reduce((s, f) => s + f.savings.monthlyUsd, 0);
  const annualSavings = actionable.reduce((s, f) => s + f.savings.annualUsd, 0);
  const share = summary.perMonth > 0 ? (monthlySavings / summary.perMonth) * 100 : 0;

  // Category totals drive the "why" strip under the hero.
  const byCategory = new Map<string, number>();
  for (const f of actionable) {
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + f.savings.monthlyUsd);
  }
  const categories = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);

  // Data for the metric toggle, rendered client-side.
  const breakdown = {
    model: summary.byModel.map((b) => ({
      key: modelLabel(b.key),
      cost: b.cost.total,
      tokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens,
      requests: b.calls,
    })),
    provider: summary.byProvider.map((b) => ({
      key: b.key,
      cost: b.cost.total,
      tokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens,
      requests: b.calls,
    })),
    project: summary.byProject.slice(0, 8).map((b) => ({
      key: b.key.split("/").slice(-1)[0] || b.key,
      cost: b.cost.total,
      tokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens,
      requests: b.calls,
    })),
    day: summary.byDay.map((b) => ({
      key: b.key,
      cost: b.cost.total,
      tokens: b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens,
      requests: b.calls,
    })),
    savings: categories.map(([key, value]) => ({
      key: CATEGORY_LABEL[key] ?? key,
      cost: value,
      tokens: 0,
      requests: 0,
    })),
  };

  // A finding as its reader meets it: the money, before and after, quality
  // cost and assumptions. The derivation is left out (this report gets
  // forwarded); `optimaizr scan --why` prints it, and the footer says so.
  const findingCards = (list: OptimizationFinding[]) =>
    list
      .map(
        (f) => `<article class="finding ${f.advisory ? "advisory" : ""}">
      <header>
        <span class="cat">${esc(CATEGORY_LABEL[f.category] ?? f.category)}</span>
        <h3>${esc(f.title)}</h3>
        <span class="amount">${usd(f.savings.monthlyUsd)}<small>/mo est.</small></span>
      </header>
      <div class="econ">
        <div class="econ-item"><span>Now</span><b>${usd(f.savings.currentUsd)}</b></div>
        <div class="econ-arrow" aria-hidden="true">&rarr;</div>
        <div class="econ-item"><span>After</span><b>${usd(f.savings.optimizedUsd)}</b></div>
        <div class="econ-item"><span>Annual</span><b>${usd(f.savings.annualUsd)}</b></div>
        <div class="econ-item"><span>Affected</span><b>${f.affected.calls.toLocaleString()} calls</b></div>
      </div>
      <div class="gauges">
        <div class="gauge">
          <span class="gauge-label">Confidence in the figure</span>
          <span class="conf conf-${f.savings.confidence}">${f.savings.confidence}</span>
        </div>
        <div class="impact impact-${f.impact}">Quality impact: ${f.impact}</div>
        <div class="gate gate-${f.risk}">${GATE_LABEL[verificationModeOf(f)]}</div>
      </div>
      <p class="detail">${esc(f.detail)}</p>
      <ul class="evidence">${f.observations.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
      <p class="fix"><strong>Fix</strong> ${esc(f.fix)}</p>
      <details>
        <summary>What this figure assumes</summary>
        <p class="calc dim">Confidence basis: ${esc(f.savings.confidenceBasis)}</p>
        <p class="assume-title">Assumptions</p>
        <ul class="assume">${f.savings.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
      </details>
    </article>`,
      )
      .join("");

  const topRows = summary.topByCost
    .slice(0, 8)
    .map(
      (t) => `<tr>
        <td class="num">${usd(t.costUsd)}</td>
        <td>${esc(modelLabel(t.model))}</td>
        <td class="num dim">${fmtTokens(t.totalTokens)}</td>
        <td class="dim">${esc((t.route ?? t.project.split("/").slice(-1)[0] ?? "").slice(0, 28))}</td>
        <td class="num dim">${esc(t.ts.slice(0, 10))}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>optimAIzr report</title>
<style>
/*
 * The same design tokens as the optimaizr.com app, restated so this file
 * loads nothing over the network. Dark-first, with a light palette for OS
 * preference or the header toggle; print is always light. Baby blue means
 * money and nothing else, the rest is a neutral ramp, and red is failure only.
 */
:root{
  color-scheme:dark;

  /* Ink and Paper, straight off the logo kit. */
  --color-bg:#111110;--color-surface:#1a1917;--surface-2:#201f1c;
  --color-text:#f1efe8;--color-divider:color-mix(in srgb,#f1efe8 11%,transparent);

  /* The one colour. Full strength is for figures and money only. */
  --color-accent:#8ccbff;--color-accent-100:#0e1e2c;--color-accent-300:#1c3b57;
  --color-accent-600:#a8d8ff;--color-accent-800:#d9eeff;

  /* Not a second hue: "settled, not an opportunity" in near-white. */
  --color-accent-2:#b9b5ab;--color-accent-2-100:#1e1d19;--color-accent-2-800:#e8e5dc;

  /* Neutral. -100 is always the chip ground, -900 always Paper. */
  --color-neutral-100:#1c1b18;--color-neutral-200:#252420;--color-neutral-300:#312f2a;
  --color-neutral-400:#6b675e;--color-neutral-500:#9a968c;--color-neutral-600:#b0aca2;
  --color-neutral-700:#c7c3b9;--color-neutral-800:#dedbd3;--color-neutral-900:#f1efe8;

  /* The mark's own colours, which are not the interface's. Only .lockup
     reads them: the cursor is baby blue on ink and deep blue on paper. */
  --brand-cursor:#8ccbff;--brand-ai-bg:#8ccbff;--brand-ai-ink:#111110;

  --ok:var(--color-accent-2);--bad:#ff5f56;

  /* Preferred families first, then system stacks. Nothing is fetched, so the
     report renders the same offline. */
  --font-heading:"Archivo","Helvetica Neue",Helvetica,"Segoe UI",Roboto,Arial,sans-serif;
  --font-body:"Geist",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;

  --radius-sm:3px;--radius-md:5px;--radius-lg:7px;

  /* On a dark ground the hairline ring separates a card from the page; the
     shadow only adds depth. */
  --shadow-sm:0 0 0 1px rgba(241,239,232,.07),0 1px 2px rgba(0,0,0,.6);

  /* Aliases. Every rule below reads these, so a theme only has to restate the
     palette above and the whole sheet follows. */
  --ground:var(--color-bg);--surface:var(--color-surface);--ink:var(--color-text);
  --ink-soft:var(--color-neutral-700);--muted:var(--color-neutral-500);--faint:var(--color-neutral-400);
  --line:var(--color-divider);--line-strong:var(--color-neutral-300);
  --signal:var(--color-accent);--signal-soft:var(--color-accent-100);
}
/* Light. Baby blue measures 1.6:1 on paper, so the token takes the kit's deep
   blue for ink while the mark keeps the real one. */
@media(prefers-color-scheme:light){:root:not([data-theme="dark"]){
  color-scheme:light;
  --color-bg:#f1efe8;--color-surface:#ffffff;--surface-2:#eae7df;
  --color-text:#111110;--color-divider:color-mix(in srgb,#111110 13%,transparent);
  --color-accent:#1c67c0;--color-accent-100:#e4f2ff;--color-accent-300:#a8d6ff;
  --color-accent-600:#17589f;--color-accent-800:#17568f;
  --color-accent-2:#55524a;--color-accent-2-100:#e4e1d7;--color-accent-2-800:#3b3830;
  --color-neutral-100:#e8e5dc;--color-neutral-200:#ddd9ce;--color-neutral-300:#c9c5b9;
  --color-neutral-400:#98948a;--color-neutral-500:#6b675e;--color-neutral-600:#4c4941;
  --color-neutral-700:#3a3833;--color-neutral-800:#232220;--color-neutral-900:#111110;
  --brand-cursor:#1f6fc5;--brand-ai-bg:#111110;--brand-ai-ink:#8ccbff;
  --bad:#c0281f;
  --shadow-sm:0 0 0 1px rgba(17,17,16,.08),0 1px 2px rgba(17,17,16,.06);
}}
:root[data-theme="light"]{
  color-scheme:light;
  --color-bg:#f1efe8;--color-surface:#ffffff;--surface-2:#eae7df;
  --color-text:#111110;--color-divider:color-mix(in srgb,#111110 13%,transparent);
  --color-accent:#1c67c0;--color-accent-100:#e4f2ff;--color-accent-300:#a8d6ff;
  --color-accent-600:#17589f;--color-accent-800:#17568f;
  --color-accent-2:#55524a;--color-accent-2-100:#e4e1d7;--color-accent-2-800:#3b3830;
  --color-neutral-100:#e8e5dc;--color-neutral-200:#ddd9ce;--color-neutral-300:#c9c5b9;
  --color-neutral-400:#98948a;--color-neutral-500:#6b675e;--color-neutral-600:#4c4941;
  --color-neutral-700:#3a3833;--color-neutral-800:#232220;--color-neutral-900:#111110;
  --brand-cursor:#1f6fc5;--brand-ai-bg:#111110;--brand-ai-ink:#8ccbff;
  --bad:#c0281f;
  --shadow-sm:0 0 0 1px rgba(17,17,16,.08),0 1px 2px rgba(17,17,16,.06);
}
*{box-sizing:border-box}
html{background:var(--ground)}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--font-body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:880px;margin:0 auto;padding-inline:20px;padding-block:52px 72px;display:flex;flex-direction:column;gap:52px}
/* A number is a number everywhere: monospaced, tabular, tightly tracked. */
.num{font-family:var(--mono);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
::selection{background:color-mix(in srgb,var(--color-accent) 30%,transparent)}
:focus{outline:none}
:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}

/* lockup, at the kit's proportions */
.brandbar{display:flex;align-items:center;gap:16px}
.lockup{display:inline-flex;align-items:center;gap:7.6px;color:var(--ink);margin:0;font-weight:400}
.lockup svg{display:block}
.wordmark{font-family:var(--mono);font-weight:800;font-size:20px;letter-spacing:-.045em;line-height:1;white-space:nowrap}
.wordmark .ai{background:var(--brand-ai-bg);color:var(--brand-ai-ink);padding:.06em .06em;letter-spacing:-.045em}
.theme-toggle{margin-left:auto;font-family:var(--font-body);font-weight:600;font-size:12.5px;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:var(--radius-md);padding:6px 12px;cursor:pointer}
.theme-toggle:hover{background:color-mix(in srgb,var(--ink) 7%,transparent)}
.hrule{height:1px;background:var(--line);margin:14px 0 12px}
.meta{font-family:var(--mono);font-size:12px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 18px}

/* Section labels are the app's h6: mono, tracked open, uppercase. */
h2{font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 18px;padding-bottom:9px;border-bottom:1px solid var(--line)}
/* Archivo is a narrow industrial grotesque; at any size it wants to be set
   tighter than it ships. */
h3{font-family:var(--font-heading);font-weight:700;letter-spacing:-.035em;line-height:1.12}
.spent{font-size:14px;color:var(--muted);margin:0}
.spent b{font-family:var(--mono);font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em;color:var(--ink)}
.headline{font-family:var(--mono);font-size:clamp(38px,8.5vw,58px);font-weight:700;letter-spacing:-.045em;line-height:1.05;margin:6px 0 0;color:var(--signal);font-variant-numeric:tabular-nums}
.headline small{font-family:var(--font-body);font-size:15px;font-weight:500;color:var(--muted);letter-spacing:0;margin-left:10px}
.sub{color:var(--ink-soft);margin:12px 0 0;max-width:62ch}
.sub b{color:var(--ink);font-weight:600}
.est{font-size:12.5px;color:var(--faint);margin:8px 0 0;max-width:72ch}
.reasons{display:flex;flex-direction:column;gap:9px;margin-top:28px}
.reason{display:grid;grid-template-columns:190px minmax(0,1fr) 86px;gap:14px;align-items:center}
.reason-name{font-size:13.5px}
.reason-bar{height:10px;background:var(--color-neutral-200);border-radius:var(--radius-sm);overflow:hidden}
.reason-bar span{display:block;height:100%;background:var(--signal)}
.reason-val{font-family:var(--mono);font-weight:700;font-size:13px;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:-.03em}

/* cards */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--line);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-sm)}
.stat{background:var(--surface);padding:15px 16px;display:flex;flex-direction:column;gap:2px}
.stat-val{font-family:var(--mono);font-weight:700;font-size:20px;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
/* Deliberately neutral: every tile has a kicker, so colouring it would put the
   accent above four different figures and stop it pointing at anything. */
.stat-key{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--color-neutral-500)}
.stat-note{font-size:12px;color:var(--muted)}

/* controls, from the app's segmented control */
.toggle{display:inline-flex;border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;width:fit-content;margin-bottom:20px;flex-wrap:wrap}
.toggle button{font-family:var(--mono);font-size:12.5px;padding:6px 13px;background:transparent;color:var(--ink);border:none;border-right:1px solid var(--line);cursor:pointer}
.toggle button:last-child{border-right:none}
.toggle button[aria-pressed="true"]{background:var(--color-neutral-200);color:var(--signal)}
.toggle button:not([aria-pressed="true"]):hover{background:color-mix(in srgb,var(--ink) 7%,transparent)}
.toggle button:focus-visible{outline:2px solid var(--signal);outline-offset:-2px}
.dims{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.dims button{font-family:var(--mono);font-size:11.5px;padding:4px 10px;border-radius:var(--radius-sm);border:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer}
.dims button:hover{color:var(--ink)}
.dims button[aria-pressed="true"]{border-color:var(--signal);color:var(--signal);background:var(--signal-soft)}
.rows{display:flex;flex-direction:column;gap:9px}
.row{display:grid;grid-template-columns:160px minmax(0,1fr) 96px;gap:14px;align-items:center}
.row-name{font-family:var(--mono);font-size:12.5px;overflow-wrap:anywhere}
.row-bar{height:10px;background:var(--color-neutral-200);border-radius:var(--radius-sm);overflow:hidden}
.row-bar span{display:block;height:100%;background:var(--signal)}
.row-val{font-family:var(--mono);font-weight:700;font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:-.03em}

/* findings */
.finding{border-top:1px solid var(--line);padding:22px 0;display:flex;flex-direction:column;gap:11px}
.finding:last-of-type{border-bottom:1px solid var(--line)}
.finding header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.finding h3{font-size:18px;margin:0;flex:1;min-width:220px;text-wrap:balance}
.cat{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
.amount{font-family:var(--mono);font-size:19px;font-weight:700;color:var(--signal);font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.amount small{font-family:var(--font-body);font-size:11px;font-weight:400;color:var(--faint);margin-left:4px;letter-spacing:0}
.econ{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding:12px 0;border-block:1px solid var(--line)}
.econ-item{display:flex;flex-direction:column}
.econ-item span{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
.econ-item b{font-family:var(--mono);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.econ-arrow{color:var(--faint);font-size:15px}
.gauges{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center}
.gauge{display:flex;align-items:center;gap:9px}
.gauge-label{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
/* Chips rank by value, not by hue: the accent is money and appears on no
   status, and red is failure only. */
.conf,.impact,.gate{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.05em;padding:3px 8px;border-radius:var(--radius-sm);background:var(--color-neutral-100);color:var(--color-neutral-600)}
.conf-high{color:var(--color-neutral-800)}
.conf-medium{color:var(--color-neutral-600)}
.conf-low{color:var(--color-neutral-500)}
.impact-none,.impact-low{color:var(--color-accent-2-800)}
.impact-medium{color:var(--color-neutral-600)}
.impact-high{color:var(--bad)}
.impact.impact-none,.impact.impact-low{background:var(--color-accent-2-100)}
.impact.impact-high{background:color-mix(in srgb,var(--bad) 13%,transparent)}
.gate-safe{background:var(--color-accent-2-100);color:var(--color-accent-2-800)}
.detail{color:var(--ink-soft);font-size:14px;margin:0;max-width:62ch;text-wrap:pretty}
.evidence{margin:0;padding-left:18px;font-size:12.5px;color:var(--muted);font-family:var(--mono);line-height:1.65}
.evidence li{overflow-wrap:anywhere}
.evidence li::marker{color:var(--color-neutral-400)}
.fix{font-size:14px;margin:0;max-width:62ch}
.fix strong{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-right:8px;font-weight:500}
details{font-size:13px}
summary{cursor:pointer;color:var(--muted);font-family:var(--mono);font-size:11.5px;letter-spacing:.04em}
summary:hover{color:var(--ink)}
summary:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
.calc{color:var(--ink-soft);margin:9px 0 0;max-width:62ch}
.calc.dim{color:var(--faint);font-size:12.5px}
.assume-title{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin:12px 0 4px}
.assume{margin:0;padding-left:18px;color:var(--ink-soft);font-size:13px;line-height:1.6}
.assume li::marker{color:var(--color-neutral-400)}
/* An advisory is real but not recoverable, so its figure is not money and
   does not get the accent. */
.advisory{border-left:2px solid var(--color-neutral-300);padding-left:16px}
.advisory .amount{color:var(--color-neutral-600)}

/* table */
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:480px;font-size:14px}
td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent)}
td.num{text-align:right;white-space:nowrap}
td:first-child{width:1%}
td.dim{color:var(--muted)}
tbody tr:hover,table tr:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}

/* recommendations */
.recs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;counter-reset:rec}
.recs li{border-top:1px solid var(--line);padding:16px 0 16px 34px;position:relative;counter-increment:rec}
.recs li:last-child{border-bottom:1px solid var(--line)}
.recs li::before{content:counter(rec);position:absolute;left:0;top:17px;font-family:var(--mono);font-size:12px;color:var(--faint)}
.rec-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.rec-head h3{margin:0;font-size:16px;flex:1;min-width:200px}
.rec-amount{font-family:var(--mono);font-size:17px;font-weight:700;color:var(--signal);font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.rec-amount small{font-family:var(--font-body);font-size:11px;font-weight:400;color:var(--faint);letter-spacing:0}
.rec-why{margin:7px 0 0;font-size:13.5px;color:var(--ink-soft);max-width:62ch}
.rec-meta{display:flex;flex-wrap:wrap;gap:4px 18px;margin-top:9px;font-size:12px;color:var(--faint)}
.rec-meta b{color:var(--ink);font-weight:600}
.legend{display:flex;flex-direction:column;gap:8px;font-size:13.5px;color:var(--ink-soft)}
.legend b{font-family:var(--mono);font-size:11.5px;letter-spacing:.05em;margin-right:8px}
.ev-measured{color:var(--color-neutral-800)}
.ev-inferred{color:var(--color-neutral-600)}
.ev-estimated{color:var(--color-neutral-500)}
footer{border-top:1px solid var(--line);padding-top:18px;font-size:12.5px;color:var(--faint);display:flex;flex-direction:column;gap:6px}
footer b{color:var(--muted)}
footer code{font-family:var(--mono);font-size:.92em;white-space:nowrap;background:var(--color-neutral-100);border-radius:var(--radius-sm);padding:1px 5px}
@media print{
  /* Printing is the export path: one clean PDF for a CTO or finance team. */
  :root,:root[data-theme="light"],:root[data-theme="dark"]{
    color-scheme:light;
    --color-bg:#fff;--color-surface:#fff;--surface-2:#fff;
    --color-text:#111110;--color-divider:#ccc;
    --color-accent:#1c67c0;--color-accent-100:#eef5fd;
    --color-accent-2:#55524a;--color-accent-2-100:#f0eee8;--color-accent-2-800:#3b3830;
    --color-neutral-100:#f2f0ea;--color-neutral-200:#e6e3db;--color-neutral-300:#999;
    --color-neutral-400:#666;--color-neutral-500:#555;--color-neutral-600:#444;
    --color-neutral-700:#333;--color-neutral-800:#222;--color-neutral-900:#111;
    --brand-cursor:#1f6fc5;--brand-ai-bg:#111110;--brand-ai-ink:#fff;
    --bad:#a02c22;--shadow-sm:0 0 0 1px #ddd;
  }
  body{font-size:11pt}
  .wrap{max-width:none;padding-block:0;gap:28px}
  .toggle,.dims,.theme-toggle{display:none}
  .page-break{break-before:page}
  details{display:block}
  details summary{display:none}
  .finding,.recs li{break-inside:avoid}
  a[href]::after{content:""}
}
@media(max-width:620px){
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .reason,.row{grid-template-columns:110px minmax(0,1fr) 76px;gap:10px}
  .reason-name{font-size:12px}
}
</style></head><body><div class="wrap">

<header>
  <div class="brandbar">
    <h1 class="lockup">
      <svg width="27" height="27" viewBox="0 0 64 64" aria-hidden="true">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="none" stroke="currentColor" stroke-width="3" />
        <path d="M15 21 L26 32 L15 43" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="square" />
        <rect x="30" y="39" width="19" height="5" fill="var(--brand-cursor)" />
      </svg>
      <span class="wordmark">optim<span class="ai">ai</span>zr</span>
    </h1>
    <button type="button" class="theme-toggle" id="theme-toggle">Light</button>
  </div>
  <div class="hrule"></div>
  <div class="meta">
    <span>${esc(summary.windowDays.from)} to ${esc(summary.windowDays.to)}</span>
    <span>${summary.window.days.toFixed(1)} days</span>
    <span>${summary.calls.toLocaleString()} calls</span>
    <span>${summary.byModel.length} model${summary.byModel.length === 1 ? "" : "s"}</span>
    <span>days in ${esc(summary.dayTimeZone)}</span>
  </div>
</header>

<section>
  <p class="spent">Estimated API-equivalent spend <b>${usd(summary.totalCost)}</b> in this window &mdash; <b>${usd(summary.perMonth)}</b>/month ${summary.pace === "last-30-days" ? "at the last 30 days&rsquo; rate" : "at this rate"}.</p>
  <p class="est"><b>This is not a bill.</b> It applies published list rates to the tokens your
  transcripts recorded. If you are on a Claude subscription or a plan with a usage allowance,
  that meter counts usage on its own terms and will not match this figure exactly. Use this
  number to compare your own traffic against itself &mdash; across days, models and projects
  &mdash; not to predict an invoice.</p>
  <p class="headline">${usd(monthlySavings)}<small>/month in estimated savings</small></p>
  <p class="sub"><b>${share.toFixed(1)}%</b> of your current spend may be avoidable &mdash; about <b>${usd(annualSavings)}</b> a year if the pattern holds.</p>
  <p class="est">These are estimates, not guarantees. Every figure below shows what it assumes and how much of it was measured rather than modelled.</p>

  <div class="reasons">
    ${
      categories.length
        ? categories
            .map(
              ([key, value]) => `<div class="reason">
        <div class="reason-name">${esc(CATEGORY_LABEL[key] ?? key)}</div>
        <div class="reason-bar"><span style="width:${((value / (categories[0]?.[1] || 1)) * 100).toFixed(1)}%"></span></div>
        <div class="reason-val">${usd(value)}</div>
      </div>`,
            )
            .join("")
        : '<p class="detail">No savings opportunities found above the reporting threshold.</p>'
    }
  </div>
</section>

<section>
  <h2>Usage</h2>
  <div class="stats">
    <div class="stat"><div class="stat-val">${fmtTokens(summary.totalTokens)}</div><div class="stat-key">Total tokens</div><div class="stat-note">${fmtTokens(summary.avgTokensPerCall)} per call</div></div>
    <div class="stat"><div class="stat-val">${(summary.cacheHitRate * 100).toFixed(1)}%</div><div class="stat-key">Cache hit rate</div><div class="stat-note">reads bill at 10%</div></div>
    <div class="stat"><div class="stat-val">${fmtTokens(summary.outputTokens)}</div><div class="stat-key">Tokens out</div><div class="stat-note">${fmtTokens(summary.thinkingTokens)} reasoning</div></div>
    <div class="stat"><div class="stat-val">${usd(summary.avgCostPerCall)}</div><div class="stat-key">Cost per call</div><div class="stat-note">${summary.latency ? `${(summary.latency.p50 / 1000).toFixed(1)}s p50` : "average"}</div></div>
    ${cacheWriteStat(summary)}
  </div>
  ${cacheWriteNote(summary)}
</section>

<section>
  <h2>Breakdown</h2>
  <div class="toggle" role="group" aria-label="Metric">
    <button type="button" data-metric="cost" aria-pressed="true">Cost</button>
    <button type="button" data-metric="tokens" aria-pressed="false">Tokens</button>
    <button type="button" data-metric="requests" aria-pressed="false">Requests</button>
    <button type="button" data-metric="savings" aria-pressed="false">Savings</button>
  </div>
  <div class="dims" role="group" aria-label="Group by">
    <button type="button" data-dim="model" aria-pressed="true">By model</button>
    <button type="button" data-dim="provider" aria-pressed="false">By provider</button>
    <button type="button" data-dim="project" aria-pressed="false">By project</button>
    <button type="button" data-dim="day" aria-pressed="false">Over time</button>
  </div>
  <div class="rows" id="rows"></div>
</section>

${recommendationsSection(extras.recommendations ?? [])}

<section class="page-break">
  <h2>Evidence key</h2>
  <div class="legend">
    <div><b class="ev-measured">measured</b> A fact, read from provider-reported usage and priced at the rate in force.</div>
    <div><b class="ev-inferred">inferred</b> A pattern we derived from measured data by a stated rule. Our reading, not a reading.</div>
    <div><b class="ev-estimated">estimated</b> A projection that assumes how a different model or setting would behave. Could be wrong.</div>
  </div>
  <p class="est">Monthly and annual figures are projections on top of all three, ${
    summary.pace === "last-30-days"
      ? `at the pace of the window&rsquo;s last 30 days rather than its full ${summary.window.days.toFixed(1)}: each finding keeps its share of spend and is scaled with it.`
      : `extrapolated from a ${summary.window.days.toFixed(1)}-day window.`
  }
  Elapsed days are divided in full, including any that carried no traffic, so long quiet
  stretches project lower than active days alone would suggest.</p>
</section>

<section>
  <h2>What to cut &mdash; ${usd(monthlySavings)}/month</h2>
  ${findingCards(actionable) || '<p class="detail">No savings opportunities found above the reporting threshold.</p>'}
</section>

${
  advisories.length
    ? `<section><h2>Worth knowing &mdash; real, but not recoverable</h2>${findingCards(advisories)}</section>`
    : ""
}

<section>
  <h2>Most expensive calls</h2>
  <div class="tablewrap"><table>${topRows}</table></div>
</section>

<footer>
  <div><b>optimAIzr</b> &mdash; savings report${extras.org ? ` for ${esc(extras.org)}` : ""}, generated ${new Date().toISOString().slice(0, 10)} from ${summary.calls.toLocaleString()} analysed requests.</div>
  <div>Findings marked &ldquo;verify&rdquo; are replayed against your own traffic and scored on your quality bar before being recommended.</div>
  <div>Savings are estimates based on observed usage. They are not guaranteed.</div>
  <div>Every finding lists what it assumes and how much of it was measured. The full derivation of
  each figure is not printed here; <code>optimaizr scan --why</code> prints it against the same data.</div>
  <div>Spend is an <b>estimate of API-equivalent cost</b>: published list rates applied to recorded token
  counts, at the rate in force on the day of each call. It is not an invoice and does not reconcile to a
  Claude subscription or plan usage meter, which measures consumption on its own terms. Days are cut in
  ${esc(summary.dayTimeZone)}.</div>
  <div>Analysis ran locally. No usage data left the machine that produced this report.</div>
</footer>

</div>
<script>
(function(){
  var DATA = ${jsonForScript(breakdown)};
  var metric = "cost", dim = "model";
  var rows = document.getElementById("rows");

  function format(value, metric){
    if(metric === "requests") return value.toLocaleString();
    if(metric === "tokens"){
      if(value >= 1e9) return (value/1e9).toFixed(2) + "B";
      if(value >= 1e6) return (value/1e6).toFixed(1) + "M";
      if(value >= 1e3) return (value/1e3).toFixed(1) + "K";
      return String(Math.round(value));
    }
    if(value === 0) return "$0.00";
    if(Math.abs(value) < 1) return "$" + value.toFixed(3);
    if(Math.abs(value) >= 1000) return "$" + Math.round(value).toLocaleString();
    return "$" + value.toFixed(2);
  }

  function render(){
    // The savings view is category-shaped, so it ignores the grouping buttons.
    var list = metric === "savings" ? DATA.savings : (DATA[dim] || []);
    var field = metric === "savings" ? "cost" : metric;
    var sorted = dim === "day" && metric !== "savings" ? list.slice() : list.slice().sort(function(a,b){ return b[field] - a[field]; });
    var max = sorted.reduce(function(m,r){ return Math.max(m, r[field]); }, 0);

    // Built as DOM rather than an innerHTML string: r.key is a model id,
    // provider or project name that came from ingested data, so concatenating
    // it into markup would let that data run as script.
    rows.textContent = "";
    if(sorted.length === 0){
      var empty = document.createElement("p");
      empty.className = "detail";
      empty.textContent = "Nothing to show for this view.";
      rows.appendChild(empty);
    }
    sorted.forEach(function(r){
      var pct = max > 0 ? (r[field] / max) * 100 : 0;

      var name = document.createElement("div");
      name.className = "row-name";
      name.textContent = r.key;

      var fill = document.createElement("span");
      fill.style.width = pct.toFixed(1) + "%";
      var bar = document.createElement("div");
      bar.className = "row-bar";
      bar.appendChild(fill);

      var val = document.createElement("div");
      val.className = "row-val";
      val.textContent = format(r[field], field === "cost" ? "cost" : field);

      var row = document.createElement("div");
      row.className = "row";
      row.appendChild(name);
      row.appendChild(bar);
      row.appendChild(val);
      rows.appendChild(row);
    });

    document.querySelectorAll(".dims button").forEach(function(b){
      b.disabled = metric === "savings";
      b.style.opacity = metric === "savings" ? "0.4" : "1";
    });
  }

  document.querySelectorAll(".toggle button").forEach(function(btn){
    btn.addEventListener("click", function(){
      metric = btn.dataset.metric;
      document.querySelectorAll(".toggle button").forEach(function(b){
        b.setAttribute("aria-pressed", String(b === btn));
      });
      render();
    });
  });

  document.querySelectorAll(".dims button").forEach(function(btn){
    btn.addEventListener("click", function(){
      dim = btn.dataset.dim;
      document.querySelectorAll(".dims button").forEach(function(b){
        b.setAttribute("aria-pressed", String(b === btn));
      });
      render();
    });
  });

  render();

  // The app has a theme toggle in its sidebar, so the report has one too.
  // With no data-theme set the page follows the OS, which is why the current
  // theme is read back off the media query rather than tracked in a variable.
  var root = document.documentElement;
  var themeBtn = document.getElementById("theme-toggle");
  var prefersLight = window.matchMedia("(prefers-color-scheme: light)");

  function theme(){ return root.dataset.theme || (prefersLight.matches ? "light" : "dark"); }

  function paintToggle(){
    var other = theme() === "dark" ? "Light" : "Dark";
    themeBtn.textContent = other;
    themeBtn.setAttribute("aria-label", "Switch to " + other.toLowerCase() + " theme");
  }

  themeBtn.addEventListener("click", function(){
    root.dataset.theme = theme() === "dark" ? "light" : "dark";
    paintToggle();
  });
  prefersLight.addEventListener("change", paintToggle);
  paintToggle();
})();
</script>
</body></html>`;
}
