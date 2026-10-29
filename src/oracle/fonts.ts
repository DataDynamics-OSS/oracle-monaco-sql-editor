/**
 * Recommended monospace fonts for the editor. The library only names them in
 * `fontFamily`; the host page loads the font files (the demo bundles them
 * from npm: `d2coding`, `@fontsource/*`).
 */
export interface OracleEditorFont {
  id: string;
  label: string;
  /** CSS font-family stack (the font first, then fallbacks). */
  fontFamily: string;
  /** Has programming ligatures (`=>`, `!=`, `||` …): turn on Monaco `fontLigatures`. */
  ligatures: boolean;
  /** Has Hangul glyphs (others fall back to the system font for Korean). */
  hangul?: boolean;
}

const FALLBACK = "'SF Mono', Menlo, Consolas, 'Courier New', monospace";

export const ORACLE_EDITOR_FONTS: OracleEditorFont[] = [
  { id: "d2coding-ligature", label: "D2Coding Ligature", fontFamily: `'D2Coding Ligature', D2Coding, ${FALLBACK}`, ligatures: true, hangul: true },
  { id: "jetbrains-mono", label: "JetBrains Mono", fontFamily: `'JetBrains Mono', ${FALLBACK}`, ligatures: true },
  { id: "fira-code", label: "Fira Code", fontFamily: `'Fira Code', ${FALLBACK}`, ligatures: true },
  { id: "cascadia-code", label: "Cascadia Code", fontFamily: `'Cascadia Code', ${FALLBACK}`, ligatures: true },
  { id: "source-code-pro", label: "Source Code Pro", fontFamily: `'Source Code Pro', ${FALLBACK}`, ligatures: false },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", fontFamily: `'IBM Plex Mono', ${FALLBACK}`, ligatures: false },
];

/** Default editor font: D2Coding Ligature (Hangul + ligatures). */
export const DEFAULT_ORACLE_EDITOR_FONT = ORACLE_EDITOR_FONTS[0];
