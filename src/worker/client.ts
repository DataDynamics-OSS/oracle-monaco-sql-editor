/**
 * Main-thread client: spins up the completion Web Worker and wraps it with
 * Comlink so its methods can be awaited like local async functions.
 */
import * as Comlink from "comlink";
import type { CompletionWorkerApi } from "./protocol.js";

export interface CompletionWorkerHandle {
  api: Comlink.Remote<CompletionWorkerApi>;
  dispose: () => void;
}

export function createCompletionWorker(): CompletionWorkerHandle {
  const worker = new Worker(
    new URL("./completion.worker.ts", import.meta.url),
    { type: "module" },
  );
  const api = Comlink.wrap<CompletionWorkerApi>(worker);
  return {
    api,
    dispose: () => worker.terminate(),
  };
}
