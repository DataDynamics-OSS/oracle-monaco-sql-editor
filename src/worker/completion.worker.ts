/**
 * Web Worker entry: exposes the completion core over Comlink so the heavy
 * ANTLR parse + antlr4-c3 candidate collection runs off the main thread.
 */
import * as Comlink from "comlink";
import { getCaretContext, validateGrammar } from "./completionCore.js";
import type { CompletionWorkerApi } from "./protocol.js";

const api: CompletionWorkerApi = { getCaretContext, validateGrammar };

Comlink.expose(api);
