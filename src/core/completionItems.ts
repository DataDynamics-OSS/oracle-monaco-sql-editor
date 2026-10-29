/**
 * Dialect-agnostic helpers for building Monaco completion items.
 * (Extracted from trino-monaco's completion providers.)
 */
import type { languages } from "monaco-editor";

/** How keyword-like completions are cased when inserted. */
export type CaseMode = "upper" | "lower" | "preserve";

/**
 * Case `text` for insertion. `preserve` follows what the user is typing:
 * an all-uppercase (or empty) prefix gives UPPER, anything else lower.
 */
export function applyCase(text: string, typed: string, mode: CaseMode = "preserve"): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  if (!typed) return text.toUpperCase();
  return typed.toUpperCase() === typed ? text.toUpperCase() : text.toLowerCase();
}

/** Keep the first item per label (callers push higher-priority items first). */
export function dedupeByLabel(items: languages.CompletionItem[]): languages.CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = typeof i.label === "string" ? i.label : i.label.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
