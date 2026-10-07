import { priceFor, tokens as fmtTokens, usd } from "../pricing.js";
import { ruleLabel } from "./terminal.js";
import type { Profile } from "../analyze/profile.js";
import type { Summary } from "../analyze/summary.js";

/**
 * `optimaizr card`: the profile as a 1200x630 image to post. Aggregates only
 * (no project names, paths or prompts), so it's safe to share unread. An SVG
 * in a self-contained HTML page that renders a PNG via canvas: no runtime
 * dependencies, no network, and system fonts (webfonts in an SVG image aren't
 * loaded when drawn to a canvas).
 */

export interface CardData {
  from: string;
  to: string;
  days: number;
  /** The headline dollar figure and what it means. */
  headlineUsd: number;
  /** Two short lines beside and under the headline; the tiles sit to the right. */
  headlineNote: [string, string];
  /** "22x" beside the headline, on a subscription. */
  multiple: string | null;
  tokensTotal: number;
  inputShare: number;
  calls: number;
  callsPerDay: number;
  cacheHitRate: number;
  topModel: { label: string; share: number } | null;
  wasteShare: number;
  biggestWaste: string | null;
  /** Share of spend that went on re-reading context: usually the biggest part. */
  rereadShare: number;
  /** Clear waste per month: the saving that needs no trade-off. */
  clearWasteMonthlyUsd: number;
  /** The biggest lever, when it is one: "compact earlier", up to a share. */
  lever: { label: string; share: number } | null;
  /** The text a post would carry, ready to paste. */
  shareText: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(key: string): string {
  const m = Number(key.slice(5, 7));
  const d = Number(key.slice(8, 10));
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : key;
}

function roundUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : usd(n);
}

/**
 * `profile` supplies the headline, waste share and top finding (the numbers
 * `optimaizr profile` prints); `summary` covers the card's 30 days and fills
 * the tiles.
 */
export function cardData(profile: Profile, summary: Summary): CardData {
  const days = Math.max(1, summary.window.days);
  const top = summary.byModel[0];
  const input = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  const total = summary.totalCost;
  // Waste as a share of spend: the same ratio the profile's savings carry,
  // so the card and `profile` can never disagree about it.
  const wasteShare = profile.perMonthUsd > 0 ? profile.savingsMonthlyUsd / profile.perMonthUsd : 0;
  // A Claude plan the user named first; otherwise a paid ChatGPT plan Codex
  // reported. Either way the headline is what the subscription is worth.
  const plan = profile.plan
    ? profile.plan
    : profile.codex?.priceUsd && profile.codex.multiple !== null
      ? {
          label: profile.codex.label,
          priceUsd: profile.codex.priceUsd,
          valueMonthlyUsd: profile.codex.valueMonthlyUsd,
          multiple: profile.codex.multiple,
        }
      : null;

  const headlineUsd = plan ? plan.valueMonthlyUsd : profile.perMonthUsd;
  const multiple = plan
    ? `${plan.multiple >= 10 ? Math.round(plan.multiple) : plan.multiple.toFixed(1)}x`
    : null;
  const price = `$${Math.round(plan?.priceUsd ?? 0)}`;
  const headlineNote: [string, string] = plan
    ? ["a month of API-equivalent usage", `on a ${price} ${plan.label} plan`]
    : [
        "a month on AI coding and APIs",
        profile.pace === "last-30-days" ? "at the last 30 days' pace" : "at this rate",
      ];

  const biggestWaste = profile.bottleneck ? ruleLabel(profile.bottleneck.rule) : null;
  const pct = Math.round(wasteShare * 100);
  const reread = Math.round(profile.breakdown.reread * 100);
  const win = profile.biggestWin;
  const lever =
    win && win.recommendation.tier === "test"
      ? { label: ruleLabel(win.recommendation.rule).toLowerCase(), share: win.share }
      : null;
  const shareText = [
    plan
      ? `My AI coding: ${roundUsd(headlineUsd)}/month of API-equivalent usage on a ${price} plan (${multiple} what I pay).`
      : `My AI coding runs ${roundUsd(headlineUsd)}/month at list prices.`,
    `${summary.totalTokens > 0 ? ((input / summary.totalTokens) * 100).toFixed(1) : 0}% of ${fmtTokens(summary.totalTokens)} tokens in 30 days were input.`,
    reread > 0
      ? `${reread}% of the cost was Claude re-reading the conversation, at the cheap cache-read rate.`
      : "",
    pct > 0
      ? `${pct}% of it was waste${biggestWaste ? `, mostly ${biggestWaste.toLowerCase()}` : ""}.`
      : "Almost none of it was waste.",
    lever && win
      ? `Biggest lever: ${lever.label}, up to ${Math.round(lever.share * 100)}% less (${roundUsd(win.recommendation.savings.monthlyUsd)}/month).`
      : "",
    "npx optimaizr profile",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    from: summary.windowDays.from,
    to: summary.windowDays.to,
    days,
    headlineUsd,
    headlineNote,
    multiple,
    tokensTotal: summary.totalTokens,
    inputShare: summary.totalTokens > 0 ? input / summary.totalTokens : 0,
    calls: summary.calls,
    callsPerDay: summary.calls / days,
    cacheHitRate: summary.cacheHitRate,
    topModel:
      top && total > 0
        ? {
            // Only a catalogue label is safe to publish. A raw id can name the
            // customer: OpenAI fine-tunes read "ft:gpt-4o-mini:acme-corp::abc".
            label: priceFor(top.key)?.label.replace(/^Claude /, "") ?? "Custom model",
            share: top.cost.total / total,
          }
        : null,
    wasteShare,
    biggestWaste,
    rereadShare: profile.breakdown.reread,
    clearWasteMonthlyUsd: profile.savingsMonthlyUsd,
    lever,
    shareText,
  };
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

const INK = "#111110";
const PAPER = "#f1efe8";
const MUTED = "#8f8d86";
const TILE = "#1b1b19";
const RULE = "#2a2a27";
const ACCENT = "#8ccbff";
const WARN = "#ffb070";

const SANS = "-apple-system, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function text(
  x: number,
  y: number,
  body: string,
  o: {
    size: number;
    fill?: string;
    weight?: number;
    mono?: boolean;
    anchor?: "start" | "end";
    spacing?: number;
  },
): string {
  return `<text x="${x}" y="${y}" font-family="${esc(o.mono ? MONO : SANS)}" font-size="${o.size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? PAPER}"${o.anchor === "end" ? ' text-anchor="end"' : ""}${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(body)}</text>`;
}

function tile(x: number, y: number, label: string, value: string, sub: string): string {
  const size = value.length > 9 ? 26 : 34;
  return [
    `<rect x="${x}" y="${y}" width="200" height="118" rx="12" fill="${TILE}"/>`,
    text(x + 20, y + 34, label, { size: 13, fill: MUTED, mono: true, spacing: 1.5 }),
    text(x + 20, y + 76, value, { size, weight: 700 }),
    text(x + 20, y + 102, sub, { size: 15, fill: MUTED }),
  ].join("");
}

/**
 * The site's logo lockup: the outlined tile with the blue cursor, then the
 * wordmark with "ai" in its block. Glyphs are placed at a fixed 0.555em step
 * because an SVG image can't measure text and the mono fallback varies.
 * `y` is the top of the icon.
 */
function lockup(x: number, y: number, size: number): string {
  const icon = Math.round(size * 1.35);
  const s = icon / 64;
  const step = size * 0.555;
  const pad = size * 0.06;
  const x0 = x + icon + size * 0.38;
  const baseline = y + icon / 2 + size * 0.36;
  const at: number[] = [];
  "optimaizr".split("").forEach((_, i) => {
    at.push(x0 + i * step + (i >= 7 ? 2 * pad : i >= 5 ? pad : 0));
  });
  const pos = (from: number, to: number) =>
    at
      .slice(from, to)
      .map((n) => n.toFixed(1))
      .join(" ");
  const glyphs = (from: number, to: number, fill: string) =>
    `<text x="${pos(from, to)}" y="${baseline.toFixed(1)}" font-family="${esc(MONO)}" font-size="${size}" font-weight="800" fill="${fill}">${"optimaizr".slice(from, to)}</text>`;
  return [
    `<g transform="translate(${x} ${y}) scale(${s.toFixed(4)})">`,
    `<rect x="2" y="2" width="60" height="60" rx="10" fill="none" stroke="${PAPER}" stroke-width="3"/>`,
    `<path d="M15 21 L26 32 L15 43" fill="none" stroke="${PAPER}" stroke-width="5" stroke-linecap="square"/>`,
    `<rect x="30" y="39" width="19" height="5" fill="${ACCENT}"/>`,
    `</g>`,
    `<rect x="${(x0 + 5 * step).toFixed(1)}" y="${(baseline - size * 0.98).toFixed(1)}" width="${(2 * step + 2 * pad).toFixed(1)}" height="${(size * 1.26).toFixed(1)}" fill="${ACCENT}"/>`,
    glyphs(0, 5, PAPER),
    glyphs(5, 7, INK),
    glyphs(7, 9, PAPER),
  ].join("");
}

export function renderCardSvg(d: CardData): string {
  const W = 1200;
  const H = 630;
  const grid: string[] = [];
  for (let x = 40; x < W; x += 40)
    grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#171716"/>`);
  for (let y = 40; y < H; y += 40)
    grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#171716"/>`);

  const headline = roundUsd(d.headlineUsd);
  const wastePct = Math.round(d.wasteShare * 100);
  const rereadPct = Math.round(d.rereadShare * 100);
  const barW = 1072;
  const fill = Math.max(rereadPct > 0 ? 6 : 0, Math.round(barW * Math.min(1, d.rereadShare)));

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${INK}"/>`,
    ...grid,

    // Lockup and window.
    lockup(64, 46, 26),
    text(1136, 70, `${shortDay(d.from)} to ${shortDay(d.to)} · my AI coding`, {
      size: 17,
      fill: MUTED,
      mono: true,
      anchor: "end",
    }),

    // Headline.
    text(64, 160, "WHAT IT COSTS AT API PRICES", {
      size: 15,
      fill: ACCENT,
      mono: true,
      spacing: 2,
    }),
    text(60, 280, headline, { size: headline.length > 6 ? 104 : 124, weight: 800 }),
    d.multiple
      ? `<rect x="64" y="${372 - 62}" width="${34 + d.multiple.length * 22}" height="50" rx="10" fill="#13283a"/>` +
        text(81, 347, d.multiple, { size: 34, weight: 800, fill: ACCENT, mono: true })
      : "",
    text(d.multiple ? 114 + d.multiple.length * 22 : 64, 344, d.headlineNote[0], {
      size: 21,
      fill: "#c9c7bf",
    }),
    text(64, 384, d.headlineNote[1], { size: 21, fill: MUTED }),

    // Tiles.
    tile(
      720,
      130,
      "TOKENS",
      fmtTokens(d.tokensTotal),
      `${(d.inputShare * 100).toFixed(1)}% were input`,
    ),
    tile(936, 130, "CALLS", d.calls.toLocaleString("en-US"), `~${Math.round(d.callsPerDay)} a day`),
    tile(720, 264, "FROM CACHE", `${Math.round(d.cacheHitRate * 100)}%`, "of input tokens"),
    d.topModel
      ? tile(
          936,
          264,
          "TOP MODEL",
          d.topModel.label,
          `${Math.round(d.topModel.share * 100)}% of spend`,
        )
      : "",

    // Where it goes, how clean it is, and the biggest lever.
    `<line x1="64" y1="420" x2="1136" y2="420" stroke="${RULE}"/>`,
    text(64, 474, `${rereadPct}% of the cost: re-reading the conversation`, {
      size: 32,
      weight: 800,
    }),
    text(1136, 472, `clear waste ${roundUsd(d.clearWasteMonthlyUsd)}/mo`, {
      size: 20,
      fill: wastePct >= 15 ? WARN : MUTED,
      anchor: "end",
    }),
    `<rect x="64" y="496" width="${barW}" height="12" rx="6" fill="${RULE}"/>`,
    fill > 0 ? `<rect x="64" y="496" width="${fill}" height="12" rx="6" fill="${ACCENT}"/>` : "",
    d.lever
      ? text(
          64,
          540,
          `biggest lever: ${d.lever.label}, up to ${Math.round(d.lever.share * 100)}% less`,
          {
            size: 19,
            fill: ACCENT,
            mono: true,
          },
        )
      : "",

    // How to get your own.
    text(64, 580, "$", { size: 22, fill: ACCENT, mono: true, weight: 700 }),
    text(86, 580, "npx optimaizr profile", { size: 22, mono: true, weight: 700 }),
    text(1136, 580, "optimaizr.com", { size: 20, fill: MUTED, mono: true, anchor: "end" }),
    `</svg>`,
  ];
  return parts.join("");
}

/* ------------------------------------------------------------------ *
 * The page around it
 * ------------------------------------------------------------------ */

export function renderCardHtml(d: CardData): string {
  const svg = renderCardSvg(d);
  const post = `https://x.com/intent/post?text=${encodeURIComponent(d.shareText)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>optimAIzr card</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b0b0a; color: ${PAPER}; font: 15px/1.5 ${SANS}; }
  main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 48px; }
  .card svg { width: 100%; height: auto; display: block; border-radius: 14px; box-shadow: 0 20px 60px #0008; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0 14px; }
  button, a.btn { font: 600 14px ${SANS}; padding: 10px 16px; border-radius: 8px; border: 1px solid #3a3a36;
    background: #1b1b19; color: ${PAPER}; cursor: pointer; text-decoration: none; }
  button.primary { background: ${ACCENT}; color: ${INK}; border-color: ${ACCENT}; }
  textarea { width: 100%; box-sizing: border-box; min-height: 84px; background: #1b1b19; color: ${PAPER};
    border: 1px solid #3a3a36; border-radius: 8px; padding: 12px; font: 14px/1.5 ${MONO}; resize: vertical; }
  p.note { color: ${MUTED}; font-size: 13px; }
  #status { color: ${ACCENT}; font-size: 13px; min-height: 1.5em; }
</style>
</head>
<body>
<main>
  <div class="card">${svg}</div>
  <div class="row">
    <button class="primary" id="png">Download PNG</button>
    <button id="copyimg">Copy image</button>
    <button id="copytext">Copy post text</button>
    <a class="btn" href="${esc(post)}" target="_blank" rel="noreferrer">Post on X</a>
  </div>
  <div id="status" role="status"></div>
  <textarea id="text" aria-label="Post text">${esc(d.shareText)}</textarea>
  <p class="note">Totals only: no project names, paths or prompts are on the card. Made on your machine by
  optimaizr card; this page makes no network request unless you click Post on X.</p>
</main>
<script>
(function () {
  var status = document.getElementById("status");
  function say(s) { status.textContent = s; }
  function toPng(done) {
    var svg = document.querySelector(".card svg");
    var xml = new XMLSerializer().serializeToString(svg);
    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = 2400; c.height = 1260;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(done, "image/png");
    };
    img.onerror = function () { say("Could not render the image in this browser."); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  }
  document.getElementById("png").onclick = function () {
    toPng(function (blob) {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "optimaizr-card.png";
      a.click();
      say("Saved optimaizr-card.png");
    });
  };
  document.getElementById("copyimg").onclick = function () {
    toPng(function (blob) {
      try {
        navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
          function () { say("Image copied. Paste it into your post."); },
          function () { say("This browser would not copy images; use Download PNG."); }
        );
      } catch (e) { say("This browser would not copy images; use Download PNG."); }
    });
  };
  document.getElementById("copytext").onclick = function () {
    var t = document.getElementById("text");
    t.select();
    try {
      navigator.clipboard.writeText(t.value).then(function () { say("Post text copied."); });
    } catch (e) { document.execCommand("copy"); say("Post text copied."); }
  };
})();
</script>
</body>
</html>
`;
}
