import type { editor } from "monaco-editor";
import { DEFAULT_ORACLE_EDITOR_FONT } from "./fonts";

/**
 * Default editor options tuned for a compact SQL editing experience:
 * ~12px D2Coding Ligature (ligatures on), no minimap, no overview ruler, padded, and overflow widgets
 * fixed to the body so the suggest popup is never clipped.
 */
export const DEFAULT_EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  hideCursorInOverviewRuler: true,
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  scrollbar: {
    vertical: "auto",
    verticalScrollbarSize: 10,
    horizontal: "auto",
    useShadows: false,
  },
  padding: { top: 8, bottom: 8 },
  scrollBeyondLastLine: false,
  fixedOverflowWidgets: true,
  lineDecorationsWidth: 25,
  fontFamily: DEFAULT_ORACLE_EDITOR_FONT.fontFamily,
  fontLigatures: DEFAULT_ORACLE_EDITOR_FONT.ligatures,
  fontSize: 12,
  lineHeight: 20,
  letterSpacing: 0.3,
  wordBasedSuggestions: "off",
  automaticLayout: true,
  tabSize: 2,
  renderLineHighlight: "all",
  smoothScrolling: true,
  cursorBlinking: "smooth",
  suggestOnTriggerCharacters: true,
  quickSuggestions: { other: true, comments: false, strings: false },
};
