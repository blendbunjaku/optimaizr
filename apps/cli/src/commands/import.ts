import fs from "node:fs";
import path from "node:path";
import { blue, dim, green, importUsageFile, red, yellow } from "@optimaizr/core";
import { append, drain } from "@optimaizr/local";
import type { Args } from "../args.js";

export async function cmdImport(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) {
    console.log(`  ${red("usage:")} optimaizr import <file.csv|file.json>`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(file)) {
    console.log(`  ${red("No such file:")} ${file}`);
    process.exitCode = 1;
    return;
  }

  const service = typeof args.flags.service === "string" ? args.flags.service : "imported";
  const result = importUsageFile(file, { service });

  for (const e of result.events) append(e);
  await drain();

  console.log("");
  console.log(
    `  ${green("Imported")} ${result.events.length.toLocaleString()} ${dim("calls from")} ${path.basename(file)}`,
  );
  if (result.skipped > 0) {
    console.log(
      `  ${yellow(`${result.skipped} rows skipped`)} ${dim("(missing model or token counts)")}`,
    );
  }
  const unpriced = result.events.filter((e) => e.cost.unpriced);
  if (unpriced.length > 0) {
    const names = [...new Set(unpriced.map((e) => e.model))].slice(0, 5);
    console.log(
      `  ${yellow(`${unpriced.length} calls priced at $0`)} ${dim(`- unknown models: ${names.join(", ")}`)}`,
    );
    console.log(`  ${dim("Add them to ~/.optimaizr/models.json to price them.")}`);
  }
  console.log("");
  console.log(`  ${dim("Run")} ${blue("optimaizr scan")} ${dim("to analyse.")}`);
  console.log("");
}
