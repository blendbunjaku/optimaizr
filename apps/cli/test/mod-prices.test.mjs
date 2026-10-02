import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import prettier from "prettier";

import { PRICES_FILE, renderPrices } from "../scripts/mod-prices.mjs";

test("the mod's price table matches the engine's catalogue", async () => {
  const options = await prettier.resolveConfig(PRICES_FILE);
  const want = await prettier.format(renderPrices(), { ...options, filepath: PRICES_FILE });
  assert.equal(
    fs.readFileSync(PRICES_FILE, "utf8"),
    want,
    "the mod prices a saving with stale rates: run `npm run mod:prices` in apps/cli",
  );
});
