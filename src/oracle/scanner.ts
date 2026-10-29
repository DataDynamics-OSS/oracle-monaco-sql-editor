/**
 * Lightweight lexical scanner for Oracle SQL / PL/SQL.
 *
 * Splits text into coarse segments — code, string literals (incl. `N'…'` and
 * `q'[…]'` alternative quoting), quoted identifiers, comments and optimizer
 * hints — so text-level tools (formatter, statement splitter, bind-variable
 * detection) never touch the inside of a literal or comment.
 *
 * Dependency-free and DOM-free: usable on the main thread, in a worker or in
 * Node tests. Not a full lexer — the ANTLR grammar handles real parsing.
 */

export type SegmentType =
  | "code"
  | "string"
  | "quotedIdent"
  | "lineComment"
  | "blockComment"
  | "hint";

export interface Segment {
  type: SegmentType;
  text: string;
  /** Absolute start offset (inclusive). */
  start: number;
  /** Absolute end offset (exclusive). */
  end: number;
}

const CLOSING: Record<string, string> = { "[": "]", "{": "}", "(": ")", "<": ">" };

function isIdentChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$#]/.test(ch);
}

/**
 * Length of a string-literal prefix starting at `i` (`'`, `N'`, `q'`, `nq'`),
 * or 0 if no string literal starts here. Returns the prefix length up to and
 * including the opening quote, plus whether it is a q-quote.
 */
function stringStart(text: string, i: number): { len: number; q: boolean } | null {
  if (text[i] === "'") return { len: 1, q: false };
  if (isIdentChar(text[i - 1])) return null; // part of a longer identifier
  const head = text.slice(i, i + 3).toLowerCase();
  if (head.startsWith("nq'")) return { len: 3, q: true };
  if (head.startsWith("q'")) return { len: 2, q: true };
  if (head.startsWith("n'")) return { len: 2, q: false };
  return null;
}

/** Offset just past the end of a regular `'…'` literal whose body starts at `i`. */
function endOfString(text: string, i: number): number {
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        i += 2; // escaped quote
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return text.length; // unterminated
}

/**
 * Offset just past the end of a q-quoted literal; `i` points at the delimiter
 * character right after `q'`.
 */
function endOfQString(text: string, i: number): number {
  const open = text[i];
  if (open === undefined || /\s/.test(open)) return endOfString(text, i);
  const close = CLOSING[open] ?? open;
  const terminator = close + "'";
  const idx = text.indexOf(terminator, i + 1);
  return idx < 0 ? text.length : idx + 2;
}

/** Scan `text` into contiguous segments that together cover the whole input. */
export function scan(text: string): Segment[] {
  const segments: Segment[] = [];
  let codeStart = 0;
  let i = 0;

  const push = (type: SegmentType, start: number, end: number) => {
    if (codeStart < start) {
      segments.push({ type: "code", text: text.slice(codeStart, start), start: codeStart, end: start });
    }
    segments.push({ type, text: text.slice(start, end), start, end });
    codeStart = end;
    i = end;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      push("lineComment", i, nl < 0 ? text.length : nl);
      continue;
    }

    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close < 0 ? text.length : close + 2;
      push(text[i + 2] === "+" ? "hint" : "blockComment", i, end);
      continue;
    }

    if (ch === '"') {
      // Oracle quoted identifiers cannot contain a double quote.
      const close = text.indexOf('"', i + 1);
      push("quotedIdent", i, close < 0 ? text.length : close + 1);
      continue;
    }

    const str = stringStart(text, i);
    if (str) {
      const bodyStart = i + str.len;
      push("string", i, str.q ? endOfQString(text, bodyStart) : endOfString(text, bodyStart));
      continue;
    }

    i++;
  }

  if (codeStart < text.length) {
    segments.push({ type: "code", text: text.slice(codeStart), start: codeStart, end: text.length });
  }
  return segments;
}
