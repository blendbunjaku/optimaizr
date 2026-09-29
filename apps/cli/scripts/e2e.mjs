// End-to-end run against a mock Anthropic server: records traffic through
// wrap(), then runs scan -> verify -> apply with the real CLI. No API key
// needed.
//
//   npm run e2e
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

import Anthropic from "@anthropic-ai/sdk";
import { wrap, withRoute, drain } from "@optimaizr/local";

const root = new URL("..", import.meta.url).pathname;

const PROFILES = {
  "claude-sonnet-5": { input: 1200, output: 420 },
  "claude-haiku-4-5": { input: 1200, output: 360 },
  "claude-opus-5": { input: 900, output: 5 },
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const p = JSON.parse(body || "{}");
    const model = p.model ?? "claude-sonnet-5";
    const prof = PROFILES[model] ?? PROFILES["claude-sonnet-5"];
    const sys = typeof p.system === "string" ? p.system : "";
    const isJudge = sys.includes("evaluating two responses");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_" + Math.random().toString(36).slice(2, 10),
        type: "message",
        role: "assistant",
        model,
        content: [
          { type: "text", text: isJudge ? "TIE" : "A careful, complete summary of the ticket." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: prof.input, output_tokens: isJudge ? 5 : prof.output },
      }),
    );
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimaizr-cli-"));
process.env.OPTIMAIZR_DIR = dir;

// record some traffic through wrap() with capture on
const client = wrap(
  new Anthropic({ apiKey: "sk-ant-test", baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }),
  { service: "checkout-api", capture: { rate: 1 } },
);

for (let i = 0; i < 14; i++) {
  await withRoute("summarise-ticket", () =>
    client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system: "You summarise support tickets for the support desk.",
      messages: [
        { role: "user", content: `Ticket ${i}: customer cannot log in after password reset.` },
      ],
    }),
  );
}
await drain();
console.log(`seeded 14 calls -> ${dir}\n`);

const env = {
  ...process.env,
  OPTIMAIZR_DIR: dir,
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  NO_COLOR: "1",
};
// has to be async, the mock server runs in this process
const run = async (args) => {
  try {
    const { stdout } = await execFileAsync("node", ["dist/cli.js", ...args], { env, cwd: root });
    return stdout;
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
};

console.log("=".repeat(70) + "\n$ optimaizr scan --source sdk\n" + "=".repeat(70));
console.log(await run(["scan", "--source", "sdk"]));

console.log("=".repeat(70) + "\n$ optimaizr verify model-fit --source sdk\n" + "=".repeat(70));
console.log(await run(["verify", "model-fit", "--source", "sdk"]));

console.log("=".repeat(70) + "\n$ optimaizr apply model-fit --source sdk\n" + "=".repeat(70));
console.log(await run(["apply", "model-fit", "--source", "sdk"]));

server.close();
