/**
 * Editor glue for the statement splitter: per-model caching, selection
 * handling, and text helpers used by the editor actions.
 */
import type { editor, IPosition, IRange } from "monaco-editor";
import { scan } from "./scanner";
import { pickStatement, splitStatements, type SplitOptions, type SqlStatement } from "./splitter";

/** Caches the split of a model per content version. */
export function createStatementCache(getOptions: () => SplitOptions) {
  let key = "";
  let value: SqlStatement[] = [];
  return (model: editor.ITextModel): SqlStatement[] => {
    const opts = getOptions();
    const k = `${model.uri.toString()}#${model.getVersionId()}#${opts.blankLineSeparates ? 1 : 0}`;
    if (k !== key) {
      value = splitStatements(model.getValue(), opts);
      key = k;
    }
    return value;
  };
}

/** The statement for the caret (see `pickStatement`). */
export function statementAtPosition(
  model: editor.ITextModel,
  position: IPosition,
  statements: SqlStatement[],
): SqlStatement | undefined {
  return pickStatement(statements, model.getValue(), model.getOffsetAt(position));
}

/**
 * Split only the selected text; offsets and lines are relative to the whole
 * model so markers and decorations land in the right place.
 */
export function statementsInRange(
  model: editor.ITextModel,
  range: IRange,
  options: SplitOptions,
): SqlStatement[] {
  const base = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
  return splitStatements(model.getValueInRange(range), options).map((s) => {
    const start = model.getPositionAt(s.startOffset + base);
    return {
      ...s,
      startOffset: s.startOffset + base,
      endOffset: s.endOffset + base,
      startLine: start.lineNumber,
      startColumn: start.column,
      endLine: model.getPositionAt(Math.max(s.startOffset, s.endOffset - 1) + base).lineNumber,
    };
  });
}

/** Non-empty statements only (comment-only chunks dropped). */
export function runnable(statements: SqlStatement[]): SqlStatement[] {
  return statements.filter((s) => s.kind !== "empty");
}

/**
 * The (possibly qualified) object name under the caret: `hr.employees`,
 * `"Mixed".T`, `emp@prod`. Returns undefined on whitespace / punctuation.
 */
export function qualifiedNameAt(model: editor.ITextModel, position: IPosition): string | undefined {
  const line = model.getLineContent(position.lineNumber);
  const part = String.raw`(?:"[^"]+"|[A-Za-z_][\w$#]*)`;
  const re = new RegExp(`${part}(?:\\.${part})*(?:@[A-Za-z_][\\w$#.]*)?`, "g");
  const col = position.column - 1; // 0-based caret
  for (const m of line.matchAll(re)) {
    const start = m.index!;
    if (col >= start && col <= start + m[0].length) return m[0];
  }
  return undefined;
}

/**
 * Toggle the case of code in `text`: all-upper code becomes lower, anything
 * else becomes upper. Strings, quoted identifiers and comments are untouched.
 */
export function toggleCase(text: string): string {
  const segs = scan(text);
  const code = segs.filter((s) => s.type === "code").map((s) => s.text).join("");
  const toLower = /[A-Za-z]/.test(code) && code === code.toUpperCase();
  return segs
    .map((s) => (s.type === "code" ? (toLower ? s.text.toLowerCase() : s.text.toUpperCase()) : s.text))
    .join("");
}
