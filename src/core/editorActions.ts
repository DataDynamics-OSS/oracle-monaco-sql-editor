/**
 * Dialect-agnostic editor action helpers (extracted from trino-monaco).
 */
import type { editor } from "monaco-editor";

/** A text → text formatter (sync or async). */
export type Formatter = (sql: string) => string | Promise<string>;

/** Return the selected text, or the whole document if the selection is empty. */
export function selectedOrAll(ed: editor.ICodeEditor): string {
  const model = ed.getModel();
  if (!model) return "";
  const selection = ed.getSelection();
  if (selection && !selection.isEmpty()) {
    return model.getValueInRange(selection);
  }
  return model.getValue();
}

/** Format the whole document (or selection) and replace it in place. */
export async function prettifyEditor(
  ed: editor.ICodeEditor,
  formatter: Formatter,
  source = "prettify",
): Promise<void> {
  const model = ed.getModel();
  if (!model) return;
  const selection = ed.getSelection();
  const useSelection = !!selection && !selection.isEmpty();
  const cursor = ed.getPosition();

  const text = useSelection ? model.getValueInRange(selection) : model.getValue();
  if (!text.trim()) return;

  const formatted = await formatter(text);
  if (formatted === text) return;
  const range = useSelection ? selection : model.getFullModelRange();

  ed.executeEdits(source, [{ range, text: formatted, forceMoveMarkers: true }]);
  if (cursor && !useSelection) ed.setPosition(cursor);
}
