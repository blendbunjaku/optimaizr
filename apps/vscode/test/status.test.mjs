import { test } from "node:test";
import assert from "node:assert/strict";

import { convo, lib, live, snapshot } from "./helpers.mjs";

const { statusView, tooltip } = lib;
const MIN = 60_000;

test("with a conversation: context, the cache clock and the 5h window", () => {
  const now = Date.now();
  const v = statusView(
    live(
      {
        convo: convo({ expiresAt: now + 4 * MIN + 12_000 }, now),
        fiveHour: { percent: 38.4, resetsAt: null, basis: "claude" },
      },
      now,
    ),
    snapshot({}, now),
    false,
  );
  assert.equal(v.text, "$(layers) 142K · $(watch) 4:12 · 5h 38%");
  // Five minutes or less on the clock is worth a colour.
  assert.equal(v.level, "warn");
});

test("a warm cache far from expiring stays calm, an expired one says cold", () => {
  const now = Date.now();
  const warm = statusView(
    live({ convo: convo({ expiresAt: now + 40 * MIN }, now) }, now),
    null,
    false,
  );
  assert.equal(warm.level, "ok");
  assert.equal(warm.text, "$(layers) 142K · $(watch) 40:00");
  const cold = statusView(live({ convo: convo({ expiresAt: now - MIN }, now) }, now), null, false);
  assert.equal(cold.text, "$(layers) 142K · $(watch) cold");
  assert.equal(cold.level, "ok");
  const codex = statusView(live({ convo: convo({ expiresAt: null }, now) }, now), null, false);
  assert.equal(codex.text, "$(layers) 142K");
});

test("90% of the 5-hour window turns it hot, over everything else", () => {
  const now = Date.now();
  const v = statusView(
    live(
      { convo: convo({}, now), fiveHour: { percent: 92, resetsAt: null, basis: "estimate" } },
      now,
    ),
    null,
    false,
  );
  assert.equal(v.level, "hot");
});

test("without a conversation it pitches the saving", () => {
  const now = Date.now();
  assert.equal(
    statusView(live({}, now), snapshot({}, now), false).text,
    "$(sparkle) Save up to 13%",
  );
  const lean = snapshot({ allIn: { share: 0.03, monthlyUsd: 20, moreWork: 1.03, parts: [] } }, now);
  assert.equal(statusView(live({}, now), lean, false).text, "$(sparkle) Claude Pro 34x");
  assert.equal(statusView(live({}, now), null, true).text, "$(sync~spin) optimAIzr");
  assert.equal(statusView(live({}, now), null, false).text, "$(sparkle) optimAIzr");
  const five = live({ fiveHour: { percent: 51, resetsAt: null, basis: "claude" } }, now);
  assert.equal(
    statusView(five, snapshot({}, now), false).text,
    "$(sparkle) Save up to 13% · 5h 51%",
  );
});

test("the tooltip escapes titles and ends on the way in", () => {
  const now = Date.now();
  const t = tooltip(
    live({ convo: convo({ title: "fix *all* the [links]" }, now) }, now),
    snapshot({}, now),
  );
  assert.match(t, /fix \\\*all\\\* the \\\[links\\\]/);
  assert.match(t, /Cache warm for about \*\*4 min\*\*/);
  assert.match(t, /Up to \*\*13%\*\* of your usage can be saved\./);
  assert.ok(t.endsWith("[Open savings](command:optimaizr.focus)"));
  assert.doesNotMatch(t, /—/);

  const empty = tooltip(live({}, now), null);
  assert.match(empty, /No Claude Code conversation in this folder right now\./);
  const guard = tooltip(
    live({}, now),
    snapshot({ guard: { on: true, catches: 2, savedUsd: 3.1, recent: [] } }, now),
  );
  assert.match(guard, /Guard is on, kept \$3\.10 this week\./);
});
