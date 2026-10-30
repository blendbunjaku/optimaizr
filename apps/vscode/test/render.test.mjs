import { test } from "node:test";
import assert from "node:assert/strict";

import { convo, fix, lib, live, sandbox, snapshot, view } from "./helpers.mjs";

sandbox("render");

const { render, convoState, esc } = lib;
const SIDEBAR = { mode: "sidebar", open: [] };
const REPORT = { mode: "report", open: [] };
const MIN = 60_000;

const ids = (sections) => sections.map(([id]) => id);
const html = (sections) => sections.map(([, h]) => h).join("\n");
const section = (sections, id) => sections.find(([s]) => s === id)?.[1] ?? "";

test("the sidebar leads with the saving, then right now, guard and the fixes", () => {
  const out = render(view(), SIDEBAR);
  assert.deepEqual(ids(out), ["top", "hero", "now", "guard", "fixes", "results", "where", "foot"]);
  const hero = section(out, "hero");
  assert.match(hero, /data-count="13" data-suffix="%">13%</);
  assert.match(hero, /1\.4x the work<\/b> per 5-hour window and per week/);
  assert.match(hero, /Claude Pro<\/b> did <b>\$676\/mo<\/b> of work at API prices/);
  assert.match(section(out, "foot"), /Open the full report/);
});

test("the report adds where the share comes from and the biggest win", () => {
  const out = render(view(), REPORT);
  assert.deepEqual(ids(out), [
    "top",
    "hero",
    "now",
    "guard",
    "parts",
    "win",
    "fixes",
    "results",
    "where",
    "foot",
  ]);
  assert.match(section(out, "parts"), /Where the 13% comes from/);
  assert.match(section(out, "win"), /\$40\.00\/mo, 6% of your usage/);
  assert.doesNotMatch(section(out, "foot"), /Open the full report/);
  // Every fix is open in the report, and says why it works.
  assert.equal((section(out, "fixes").match(/<details[^>]* open>/g) ?? []).length, 3);
  assert.match(section(out, "fixes"), /Why it works/);
});

test("fixes go biggest money first, with the ones done at the bottom", () => {
  const order = (s) =>
    [
      ...section(render(view({ snapshot: s }), SIDEBAR), "fixes").matchAll(/data-id="([^"]+)"/g),
    ].map((m) => m[1]);
  assert.deepEqual(order(snapshot()), ["model-choice", "context-compaction", "dup-read"]);
  const done = snapshot();
  done.fixes[2] = { ...done.fixes[2], doneAt: "2026-10-27T12:00:00.000Z" };
  assert.deepEqual(order(done), ["context-compaction", "dup-read", "model-choice"]);
  // The header counts only what is left to do.
  assert.match(section(render(view({ snapshot: done }), SIDEBAR), "fixes"), /3 · \$42\.00\/mo/);
});

test("a habit asks for I did this; a done one offers undo; compaction is one click", () => {
  const s = snapshot();
  s.fixes[0] = { ...s.fixes[0], doneAt: "2026-10-27T12:00:00.000Z" };
  const fixes = section(render(view({ snapshot: s }), SIDEBAR), "fixes");
  assert.match(fixes, /data-action="done" data-rule="model-choice"/);
  assert.match(fixes, /data-action="undoDone" data-rule="dup-read">[\s\S]*?Recorded Oct 27\. Undo/);
  assert.match(fixes, /data-action="compact" data-on="true"[^>]*>Apply</);
  const on = snapshot({
    compaction: { at: 200_000, ours: true, since: "2026-10-27T12:00:00.000Z" },
  });
  const applied = section(render(view({ snapshot: on }), SIDEBAR), "fixes");
  assert.match(applied, /On at 200K/);
  assert.match(applied, /data-action="compact" data-on="false"/);
  const busy = section(render(view({ busy: "compact" }), SIDEBAR), "fixes");
  assert.match(busy, /disabled>Applying…</);
});

test("titles and labels from transcripts are escaped", () => {
  const now = Date.now();
  const bad = '<script>alert("x")</script>';
  const s = snapshot({ fixes: [fix({ label: bad })] }, now);
  const v = view(
    {
      snapshot: s,
      live: live(
        { convo: convo({ title: bad }, now), warm: [convo({ sessionId: "s2", title: bad }, now)] },
        now,
      ),
    },
    now,
  );
  const out = html(render(v, REPORT));
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.equal(esc(`a&b"'<>`), "a&amp;b&quot;&#39;&lt;&gt;");
});

test("no inline styles and no em dashes, in every state", () => {
  const now = Date.now();
  const states = [
    view({}, now),
    view(
      {
        live: live(
          {
            convo: convo({}, now),
            fiveHour: {
              percent: 92,
              resetsAt: new Date(now + 3_600_000).toISOString(),
              basis: "estimate",
            },
          },
          now,
        ),
      },
      now,
    ),
    view(
      { live: live({ convo: convo({ expiresAt: now - MIN, context: 230_000 }, now) }, now) },
      now,
    ),
    view({ snapshot: null, loading: true }, now),
    view({ snapshot: null, error: "Could not read ~/.claude" }, now),
    view(
      { snapshot: { ...lib.emptySnapshot(30, now), emptyReason: "No Claude Code history yet." } },
      now,
    ),
    view(
      { snapshot: snapshot({ guard: { on: true, catches: 2, savedUsd: 3.1, recent: [] } }, now) },
      now,
    ),
  ];
  for (const v of states) {
    for (const ui of [SIDEBAR, REPORT]) {
      const out = html(render(v, ui));
      assert.doesNotMatch(out, /\sstyle=/, "the CSP allows no inline styles");
      assert.doesNotMatch(out, /—/);
    }
  }
});

test("loading, error and first-run heroes", () => {
  const loading = render(view({ snapshot: null, loading: true }), SIDEBAR);
  assert.match(section(loading, "hero"), /aria-busy="true"/);
  assert.match(section(loading, "top"), /Reading your history…/);
  assert.deepEqual(ids(loading), ["top", "hero", "now", "guard", "foot"]);

  const error = section(render(view({ snapshot: null, error: "Bad <file>" }), SIDEBAR), "hero");
  assert.match(error, /Something got in the way/);
  assert.match(error, /Bad &lt;file&gt;/);
  assert.match(error, /data-action="refresh"/);

  const empty = render(
    view({ snapshot: { ...lib.emptySnapshot(30), emptyReason: "No Claude Code history yet." } }),
    SIDEBAR,
  );
  assert.match(section(empty, "hero"), /Your savings show up here\./);
  assert.ok(!ids(empty).includes("fixes"));
  assert.doesNotMatch(section(empty, "foot"), /Open the full report/);
});

test("the hero falls back to the plan multiple, then to dollars", () => {
  const lean = snapshot({ allIn: { share: 0.03, monthlyUsd: 20, moreWork: 1.03, parts: [] } });
  assert.match(
    section(render(view({ snapshot: lean }), SIDEBAR), "hero"),
    /Your plan is worth.*34x/s,
  );
  const api = snapshot({ allIn: null, plan: null });
  assert.match(
    section(render(view({ snapshot: api }), SIDEBAR), "hero"),
    /\$676<\/span><span class="big-post">\/mo of AI/,
  );
});

test("right now follows the cache: warm, expiring, cold", () => {
  const now = Date.now();
  const card = (c, guardOn = false) =>
    section(
      render(
        view(
          {
            snapshot: snapshot(
              { guard: { on: guardOn, catches: 0, savedUsd: 0, recent: [] } },
              now,
            ),
            live: live({ convo: c }, now),
          },
          now,
        ),
        SIDEBAR,
      ),
      "now",
    );
  const warm = card(convo({ expiresAt: now + 20 * MIN }, now));
  assert.match(warm, /Cache warm\./);
  assert.match(warm, /\$0\.07/);
  assert.match(warm, /Opus 5\.5/);
  // The countdown text is left to the script, so a render a second later is the same.
  assert.match(warm, /data-countdown="\d+"><\/span>/);

  const soon = card(convo({}, now));
  assert.match(soon, /class="card now soon"/);
  assert.match(soon, /Expiring soon\..*\$1\.78/);

  const cold = card(convo({ expiresAt: now - MIN }, now), true);
  assert.match(cold, /Cache expired\..*142K again: \$1\.78\. Guard will hold it first\./);

  const nothing = section(render(view(), SIDEBAR), "now");
  assert.match(nothing, /Nothing running in this folder/);

  assert.equal(convoState({ expiresAt: null }, now), "unknown");
  assert.equal(convoState({ expiresAt: now + 20 * MIN }, now), "warm");
  assert.equal(convoState({ expiresAt: now + 5 * MIN }, now), "soon");
  assert.equal(convoState({ expiresAt: now }, now), "cold");
});

test("the 5-hour row marks an estimate, and the context bar warns past 200K", () => {
  const now = Date.now();
  const c = convo({ context: 230_000 }, now);
  const fiveHour = {
    percent: 92,
    resetsAt: new Date(now + 3_600_000).toISOString(),
    basis: "estimate",
  };
  const card = section(
    render(view({ live: live({ convo: c, fiveHour }, now) }, now), SIDEBAR),
    "now",
  );
  assert.match(card, /5-hour window<\/span><b class="num">92%/);
  assert.match(card, /class="bar hot"/);
  assert.match(card, />estimate</);
  assert.match(card, /class="bar ctx hot"/);
  assert.match(card, /Past 200K/);
});

test("guard: off explains itself, on counts what it held", () => {
  const off = section(render(view({ cli: "missing" }), SIDEBAR), "guard");
  assert.match(off, /aria-checked="false" data-action="guard" data-on="true"/);
  assert.match(off, /Turning it on offers to install it\./);
  assert.doesNotMatch(section(render(view(), SIDEBAR), "guard"), /offers to install/);

  const recent = [
    {
      at: new Date().toISOString(),
      kind: "cold-hold",
      title: "Held a message",
      text: "Its cache had expired.",
    },
  ];
  const held = section(
    render(
      view({ snapshot: snapshot({ guard: { on: true, catches: 0, savedUsd: 0, recent } }) }),
      SIDEBAR,
    ),
    "guard",
  );
  // A hold that was sent anyway saved nothing, but it still happened.
  assert.match(held, /1 catch<\/b> this week/);
  assert.doesNotMatch(held, /Nothing needed holding/);
  assert.match(held, /Held a message/);

  const kept = section(
    render(
      view({ snapshot: snapshot({ guard: { on: true, catches: 3, savedUsd: 4.2, recent } }) }),
      SIDEBAR,
    ),
    "guard",
  );
  assert.match(kept, /\$4\.20<\/b> kept this week <span class="muted">· 3 catches/);
  const quiet = section(
    render(
      view({ snapshot: snapshot({ guard: { on: true, catches: 0, savedUsd: 0, recent: [] } }) }),
      SIDEBAR,
    ),
    "guard",
  );
  assert.match(quiet, /On and watching/);
});

test("results read with arrows and a capital letter", () => {
  const out = section(render(view(), SIDEBAR), "results");
  assert.match(out, /Opus → Sonnet/);
  assert.match(out, /Working: 18% less per prompt/);
  assert.match(out, /Last 7 days: 12% less/);
});
