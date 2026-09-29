import fs from "node:fs";
import path from "node:path";

import type { DecisionStore } from "@optimaizr/core";

import { optimaizrDir } from "./ledger.js";

/** File-backed decision store for the CLI. */
export function fileDecisionStore(): DecisionStore {
  const file = () => path.join(optimaizrDir(), "decisions.json");
  return {
    load() {
      try {
        const p = file();
        if (!fs.existsSync(p)) return {};
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        return {};
      }
    },
    save(all) {
      try {
        fs.mkdirSync(optimaizrDir(), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify(all, null, 2));
      } catch {
        /* a lost decision must not break the run */
      }
    },
  };
}
