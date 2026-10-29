/**
 * Inject a stylesheet once per document (the library ships no CSS file).
 * No-op outside the browser.
 */
export function injectStyles(id: string, css: string): void {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}
