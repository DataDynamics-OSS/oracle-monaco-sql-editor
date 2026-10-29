import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

// Two modes:
//   - default `vite build`      -> builds the library (dist/)
//   - `vite build --mode demo`  -> builds the runnable demo site (dist-demo/)
export default defineConfig(({ mode }) => {
  if (mode === "demo") {
    // Same-origin proxy to the oracle-monaco gateway (servers/), so the
    // session cookie stays first-party. Override with VITE_ORACLE_GATEWAY.
    const proxy = {
      "/api": {
        target: process.env.VITE_ORACLE_GATEWAY ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    };
    return {
      plugins: [react()],
      worker: { format: "es" },
      build: { outDir: "dist-demo" },
      server: { proxy },
      preview: { proxy },
    };
  }

  return {
    plugins: [
      react(),
      dts({ include: ["src"], exclude: ["src/main.tsx", "src/App.tsx", "src/appStrings.ts", "src/fonts.ts", "src/vite-env.d.ts"] }),
    ],
    worker: { format: "es" },
    build: {
      lib: {
        entry: resolve(__dirname, "src/index.ts"),
        formats: ["es"],
        fileName: () => "oracle-monaco.js",
      },
      rollupOptions: {
        external: ["react", "react-dom", "react/jsx-runtime", "@monaco-editor/react", "monaco-editor"],
      },
    },
  };
});
