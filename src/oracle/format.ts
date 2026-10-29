/**
 * Lightweight Oracle SQL / PL/SQL formatter.
 *
 * A small, dependency-free default for the "Prettify" action. Replace it via
 * the `formatter` prop on `<OracleEditor />` (e.g. delegate to SQLcl or a
 * server-side formatter).
 *
 * Intentionally conservative so it never changes meaning:
 *   - the script is split into statements first (splitter.ts); SQL*Plus
 *     command lines are copied verbatim and `;` / `/` terminators are kept
 *   - string literals (incl. q-quotes), quoted identifiers, comments and hints
 *     are copied verbatim (see scanner.ts); a line comment keeps its line break
 *   - clause breaks are only inserted at statement level or directly inside a
 *     subquery — never inside a call such as `EXTRACT(YEAR FROM d)` or
 *     `OVER (ORDER BY x)` — and only clause / block keywords are UPPER-cased
 *   - PL/SQL is indented by block: DECLARE / BEGIN / EXCEPTION / END,
 *     IF … THEN / ELSIF / ELSE, LOOP, CASE statements, and the IS / AS of
 *     procedure, function, package and type-body headers
 */
import type { Formatter } from "../core/editorActions";
import { scan } from "./scanner";
import { splitStatements, type SqlStatement } from "./splitter";

export type { Formatter };

export interface FormatOptions {
  /** One indentation level. Default two spaces. */
  indent?: string;
}

/** Clauses that start a new line (longest first so multi-word forms win). */
const CLAUSES = [
  "ORDER SIBLINGS BY", "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN",
  "WHEN NOT MATCHED", "WHEN MATCHED", "NATURAL JOIN", "CROSS APPLY", "OUTER APPLY",
  "UNION ALL", "GROUP BY", "ORDER BY", "CONNECT BY", "START WITH", "FETCH FIRST",
  "FETCH NEXT", "FOR UPDATE", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN",
  "CROSS JOIN", "SELECT", "FROM", "WHERE", "HAVING", "UNION", "INTERSECT", "MINUS",
  "EXCEPT", "JOIN", "VALUES", "PIVOT", "UNPIVOT", "OFFSET", "RETURNING",
];

const CLAUSE_RES = CLAUSES.map((c) => ({
  clause: c,
  re: new RegExp(`${c.replace(/ /g, "\\s+")}(?![\\w$#])`, "iy"),
}));

/** Keywords after which a clause word stays on the same line (`DELETE FROM`). */
const NO_BREAK_AFTER = new Set(["DELETE", "REVOKE"]);

/** Words whose following IS / AS opens a declaration section. */
const HEADER_OPENS = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "BODY"]);
/** Words after which IS / AS does not open a block (`CURSOR c IS`, `TYPE t IS`). */
const HEADER_WORDS = new Set([...HEADER_OPENS, "TYPE", "TRIGGER", "CURSOR", "SUBTYPE"]);

const WORD = /[A-Za-z_][\w$#]*/y;
const WS = /\s+/y;
const SUBQUERY_START = /\s*(?:SELECT|WITH)(?![\w$#])/iy;

/**
 * Block stack entries:
 *   decl      DECLARE / header IS-AS section          begin     BEGIN … END
 *   exception EXCEPTION section                       when      WHEN … THEN body
 *   then      IF / ELSIF … THEN body                  else      IF … ELSE body
 *   loop      LOOP body                               case      CASE statement
 *   caseElse  CASE statement ELSE body                expr      CASE expression (no indent)
 */
type Block =
  | "decl" | "begin" | "exception" | "when" | "then" | "else"
  | "loop" | "case" | "caseElse" | "expr";

/** Format one SQL or PL/SQL statement body (no terminator). */
function formatBody(text: string, plsql: boolean, unit: string): string {
  let out = "";
  let breakPending = false; // after a line comment / `;`: next token starts a new line
  let parens: boolean[] = []; // true when the paren opens a subquery
  let prevWord = "";
  const blocks: Block[] = [];
  let atStmtStart = true; // at the start of a PL/SQL statement
  let header = ""; // last header word since the start of the PL/SQL statement
  // Block a following THEN opens: set by IF / ELSIF / a handler or CASE WHEN.
  // A THEN without one (e.g. MERGE … WHEN MATCHED THEN) stays inline.
  let thenOpens: "then" | "when" | null = null;

  const top = () => blocks[blocks.length - 1];
  const depth = () => blocks.reduce((n, b) => (b === "expr" ? n : n + 1), 0);

  const newline = () => {
    out = out.replace(/[ \t]+$/, "");
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const emit = (s: string) => {
    if (breakPending) {
      newline();
      breakPending = false;
    }
    if (out.endsWith("\n")) out += unit.repeat(depth());
    out += s;
  };
  const space = () => {
    if (out && !/[\s(]$/.test(out)) out += " ";
  };
  /** Emit a block keyword that starts its own line. */
  const lineWord = (w: string) => {
    newline();
    emit(w);
  };
  const opens = (b: Block) => {
    blocks.push(b);
    breakPending = true;
    atStmtStart = true;
  };

  /** PL/SQL structure. Returns true when the word was fully handled. */
  const block = (w: string): boolean => {
    const t = top();
    if (prevWord === "END" && (w === "IF" || w === "LOOP" || w === "CASE")) return false;
    switch (w) {
      case "DECLARE":
        lineWord(w);
        opens("decl");
        return true;
      case "BEGIN":
        newline();
        if (t === "decl") blocks.pop();
        emit(w);
        opens("begin");
        return true;
      case "IS":
      case "AS":
        if (parens.length || !HEADER_OPENS.has(header)) return false;
        space();
        emit(w);
        header = "";
        opens("decl");
        return true;
      case "EXCEPTION":
        if (!atStmtStart || t !== "begin") return false;
        newline();
        blocks.pop();
        emit(w);
        opens("exception");
        return true;
      case "WHEN":
        if (t !== "exception" && t !== "when" && t !== "case") return false;
        newline();
        if (t === "when") blocks.pop();
        emit(w);
        thenOpens = "when";
        atStmtStart = false;
        return true;
      case "THEN": {
        if (t === "expr" || !thenOpens) return false;
        const b = thenOpens;
        thenOpens = null;
        space();
        emit(w);
        opens(b);
        return true;
      }
      case "ELSIF":
        if (!atStmtStart) return false;
        newline();
        if (t === "then") blocks.pop();
        emit(w);
        thenOpens = "then";
        atStmtStart = false;
        return true;
      case "ELSE":
        if (t === "expr" || !atStmtStart) return false;
        newline();
        if (t === "then" || t === "when") blocks.pop();
        emit(w);
        opens(t === "when" ? "caseElse" : "else");
        return true;
      case "IF":
        if (!atStmtStart) return false;
        emit(w);
        thenOpens = "then";
        atStmtStart = false;
        return true;
      case "LOOP":
        space();
        emit(w);
        opens("loop");
        return true;
      case "CASE":
        if (!atStmtStart) {
          blocks.push("expr");
          return false;
        }
        lineWord(w);
        blocks.push("case");
        atStmtStart = false;
        return true;
      case "END":
        if (t === "expr") {
          blocks.pop();
          return false;
        }
        newline();
        if (t === "when" || t === "caseElse") blocks.pop();
        blocks.pop();
        emit(w);
        atStmtStart = false;
        return true;
    }
    return false;
  };

  for (const seg of scan(text)) {
    if (seg.type !== "code") {
      emit(seg.text);
      if (seg.type === "lineComment") breakPending = true;
      continue;
    }

    const code = seg.text;
    let i = 0;
    while (i < code.length) {
      const ch = code[i];

      if (/\s/.test(ch)) {
        WS.lastIndex = i;
        WS.exec(code);
        i = WS.lastIndex;
        if (!breakPending) space();
        continue;
      }

      if (ch === ";") {
        out = out.replace(/[ \t]+$/, "");
        emit(";");
        breakPending = true;
        parens = [];
        prevWord = "";
        header = "";
        atStmtStart = true;
        i++;
        continue;
      }

      if (ch === "(") {
        SUBQUERY_START.lastIndex = i + 1;
        const subquery = SUBQUERY_START.test(code);
        emit("(");
        parens.push(subquery);
        i++;
        continue;
      }

      if (ch === ")") {
        parens.pop();
        out = out.replace(/[ \t]+$/, "");
        emit(")");
        i++;
        continue;
      }

      WORD.lastIndex = i;
      const word = WORD.exec(code);
      if (!word) {
        emit(ch);
        i++;
        continue;
      }

      const upper = word[0].toUpperCase();
      i = WORD.lastIndex;

      if (plsql && block(upper)) {
        prevWord = upper;
        continue;
      }

      if (plsql && HEADER_WORDS.has(upper)) header = upper;

      const breakable =
        (parens.length === 0 || parens[parens.length - 1]) &&
        top() !== "expr" &&
        !out.endsWith(".") && // `t.from` is a column, not a clause
        !NO_BREAK_AFTER.has(prevWord);
      const hit = breakable
        ? CLAUSE_RES.find(({ re }) => {
            re.lastIndex = WORD.lastIndex - word[0].length;
            return re.test(code);
          })
        : undefined;

      if (hit) {
        const atLineStart = breakPending || out === "" || /\n[ \t]*$/.test(out);
        if (!atLineStart && !/\($/.test(out)) newline();
        emit(hit.clause);
        i = hit.re.lastIndex;
        prevWord = hit.clause;
      } else {
        const structural = plsql && (upper === "END" || (prevWord === "END" && /^(IF|LOOP|CASE)$/.test(upper)));
        emit(structural ? upper : word[0]);
        prevWord = upper;
      }
      atStmtStart = false;
    }
  }

  return out.replace(/\s+$/, "");
}

function startsWithComment(text: string): boolean {
  const first = scan(text)[0];
  return first?.type === "lineComment" || first?.type === "blockComment";
}

function endsWithLineComment(text: string): boolean {
  const segs = scan(text);
  const last = segs[segs.length - 1];
  return last?.type === "lineComment";
}

function formatStatement(stmt: SqlStatement, unit: string): string {
  if (stmt.kind === "sqlplus") return stmt.text;
  if (stmt.kind === "empty") return stmt.text;

  const body = formatBody(stmt.text, stmt.kind === "plsql", unit);
  switch (stmt.terminator) {
    case ";":
      return endsWithLineComment(stmt.text) ? `${body}\n;` : `${body};`;
    case "/":
      return `${body}\n/`;
    default:
      return body;
  }
}

/** Create a formatter with custom options. */
export function createOracleFormatter(options: FormatOptions = {}): Formatter {
  const unit = options.indent ?? "  ";
  return (sql: string): string => {
    const stmts = splitStatements(sql);
    if (!stmts.length) return sql;

    let out = "";
    let prevEnd = 0;
    for (const stmt of stmts) {
      if (out) {
        const gap = sql.slice(prevEnd, stmt.startOffset);
        if (/\n[ \t\r]*\n/.test(gap)) out += "\n\n";
        else if (!gap.includes("\n") && startsWithComment(stmt.text)) out += " ";
        else out += "\n";
      }
      out += formatStatement(stmt, unit);
      prevEnd = stmt.endOffset;
    }
    return out;
  };
}

/**
 * Format Oracle SQL / PL/SQL with the default options: collapse whitespace in
 * code, one statement per line, major clauses on their own (UPPER-cased) line,
 * PL/SQL blocks indented by two spaces.
 */
export const formatOracleSql: Formatter = createOracleFormatter();
