import { parentPort, workerData } from "node:worker_threads";
import { buildSnapshot } from "./snapshot.js";

// Reading a month of transcripts takes a second or more, so it runs here and
// the editor never waits on it.
const days = typeof workerData?.days === "number" ? workerData.days : 30;
buildSnapshot({ days }).then(
  (snapshot) => parentPort?.postMessage({ ok: true, snapshot }),
  (err: unknown) =>
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
