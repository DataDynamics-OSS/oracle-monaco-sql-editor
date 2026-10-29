import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import App from "./App";
import "./fonts";

// Serve Monaco from the local bundle instead of the default CDN, so the demo
// works on networks without access to cdn.jsdelivr.net.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// Reset default body margin so the editor fills the viewport.
document.body.style.margin = "0";

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
