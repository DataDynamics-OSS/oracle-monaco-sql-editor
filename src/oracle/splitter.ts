/**
 * Oracle statement splitter.
 *
 * Splits a script into statements the way SQL*Plus / SQL Developer do:
 *   - plain SQL ends at `;` (or a `/` line); the `;` is not part of the text
 *     sent to the database (Oracle rejects it with ORA-00933 / ORA-00911)
 *   - PL/SQL — `DECLARE`, `BEGIN`, `CREATE [OR REPLACE] PROCEDURE | FUNCTION |
 *     PACKAGE [BODY] | TRIGGER | TYPE [BODY] | LIBRARY | JAVA`, 12c `WITH
 *     FUNCTION` — contains `;` and ends only at a line holding just `/` (or EOF);
 *     its final `END;` is kept
 *   - SQL*Plus commands (`SET`, `DEFINE`, `PROMPT`, `EXEC`, `@file`, …) are one
 *     line long and need no terminator
 *   - `;` and `/` inside strings (incl. q-quotes), quoted identifiers and
 *     comments never split (see scanner.ts)
 *
 * Runs on the main thread (no ANTLR) so actions and decorations stay cheap.
 */
import { scan } from "./scanner";

export type StatementKind = "sql" | "plsql" | "sqlplus" | "empty";

/** What ended the statement: `;`, a `/` line, a blank line (opt-in), end of line (SQL*Plus) or EOF. */
export type StatementTerminator = ";" | "/" | "blank" | "eol" | "eof";

export interface SqlPlusCommand {
  /** Canonical command name, e.g. "SET", "DEFINE", "EXEC", "@", "PROMPT". */
  name: string;
  /** The rest of the line, trimmed, without a trailing `;`. */
  args: string;
}

export interface SqlStatement {
  /** Statement text without its terminator (PL/SQL keeps its final `END;`). */
  text: string;
  kind: StatementKind;
  /** Absolute offset of the first character (leading comments included). */
  startOffset: number;
  /** Absolute offset just past the terminator. */
  endOffset: number;
  /** 1-based first line. */
  startLine: number;
  /** 1-based column of the first character on `startLine`. */
  startColumn: number;
  /** 1-based last line (the terminator's line). */
  endLine: number;
  terminator: StatementTerminator;
  /** Set when `kind` is "sqlplus". */
  command?: SqlPlusCommand;
}

export interface SplitOptions {
  /**
   * End plain SQL statements at a blank line too (SQL Developer habit, and
   * SQL*Plus with `SET SQLBLANKLINES OFF`). PL/SQL is never split on blank
   * lines. Default `false`.
   */
  blankLineSeparates?: boolean;
}

const SQLPLUS_COMMANDS: Record<string, string> = {
  ACC: "ACCEPT", ACCEPT: "ACCEPT",
  BRE: "BREAK", BREAK: "BREAK",
  BTI: "BTITLE", BTITLE: "BTITLE",
  CL: "CLEAR", CLEAR: "CLEAR",
  COL: "COLUMN", COLUMN: "COLUMN",
  COMP: "COMPUTE", COMPUTE: "COMPUTE",
  CONN: "CONNECT", CONNECT: "CONNECT",
  DEF: "DEFINE", DEFINE: "DEFINE",
  DESC: "DESC", DESCRIBE: "DESC",
  DISC: "DISCONNECT", DISCONNECT: "DISCONNECT",
  EXEC: "EXEC", EXECUTE: "EXEC",
  EXIT: "EXIT", QUIT: "EXIT",
  HO: "HOST", HOST: "HOST",
  PAU: "PAUSE", PAUSE: "PAUSE",
  PRI: "PRINT", PRINT: "PRINT",
  PRO: "PROMPT", PROMPT: "PROMPT",
  REM: "REMARK", REMARK: "REMARK",
  SET: "SET",
  SHO: "SHOW", SHOW: "SHOW",
  SPO: "SPOOL", SPOOL: "SPOOL",
  STA: "@", START: "@",
  TTI: "TTITLE", TTITLE: "TTITLE",
  UNDEF: "UNDEFINE", UNDEFINE: "UNDEFINE",
  VAR: "VARIABLE", VARIABLE: "VARIABLE",
  WHENEVER: "WHENEVER",
};

/** `SET <x>` forms that are SQL statements, not SQL*Plus settings. */
const SQL_SET = new Set(["TRANSACTION", "ROLE", "CONSTRAINT", "CONSTRAINTS"]);

const PLSQL_OBJECTS = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "LIBRARY", "JAVA"]);
const EDITIONING = new Set(["EDITIONABLE", "NONEDITIONABLE", "EDITIONING"]);

/** Decide SQL vs PL/SQL from the first few (upper-cased) words. */
export function classifyWords(words: string[]): "sql" | "plsql" {
  const [w0, w1] = words;
  if (w0 === "DECLARE" || w0 === "BEGIN") return "plsql";
  if (w0 === "WITH" && (w1 === "FUNCTION" || w1 === "PROCEDURE")) return "plsql";
  if (w0 === "CREATE") {
    let k = 1;
    if (words[k] === "OR" && words[k + 1] === "REPLACE") k += 2;
    if (words[k] === "AND" && (words[k + 1] === "COMPILE" || words[k + 1] === "RESOLVE")) k += 2;
    while (EDITIONING.has(words[k])) k++;
    if (PLSQL_OBJECTS.has(words[k])) return "plsql";
  }
  return "sql";
}

/** Recognise a SQL*Plus command line (`line` starts at the first token). */
function sqlPlusCommand(line: string): SqlPlusCommand | undefined {
  const at = /^@@?\s*(.*)$/s.exec(line);
  if (at) return { name: "@", args: stripSemicolon(at[1]) };
  const m = /^([A-Za-z]+)(?=\s|;|$)\s*(.*)$/s.exec(line);
  if (!m) return undefined;
  const name = SQLPLUS_COMMANDS[m[1].toUpperCase()];
  if (!name) return undefined;
  const args = stripSemicolon(m[2]);
  if (name === "SET" && SQL_SET.has(args.split(/\s+/)[0]?.toUpperCase())) return undefined;
  return { name, args };
}

function stripSemicolon(s: string): string {
  return s.trim().replace(/;\s*$/, "").trim();
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 1-based line number of `offset`. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const TOKEN = /<<[\w$#]+>>|[A-Za-z_][\w$#]*|@@?/y;

/** Split `text` into statements. Whitespace between statements belongs to none. */
export function splitStatements(text: string, options: SplitOptions = {}): SqlStatement[] {
  const starts = lineStartsOf(text);
  const out: SqlStatement[] = [];

  // Mutated inside closures: the assertion stops TS narrowing it to `null`.
  let cur = null as { start: number; words: string[]; hasCode: boolean } | null;
  let skipUntil = 0;

  const begin = (at: number) => {
    if (!cur) cur = { start: at, words: [], hasCode: false };
  };

  const finish = (
    bodyEnd: number,
    end: number,
    terminator: StatementTerminator,
    command?: SqlPlusCommand,
  ) => {
    if (!cur) return;
    const kind: StatementKind = command
      ? "sqlplus"
      : cur.hasCode
        ? classifyWords(cur.words)
        : "empty";
    out.push({
      text: text.slice(cur.start, bodyEnd).replace(/\s+$/, ""),
      kind,
      startOffset: cur.start,
      endOffset: end,
      startLine: lineAt(starts, cur.start),
      startColumn: cur.start - starts[lineAt(starts, cur.start) - 1] + 1,
      endLine: lineAt(starts, Math.max(cur.start, end - 1)),
      terminator,
      ...(command ? { command } : {}),
    });
    cur = null;
  };

  const isPlsql = () => !!cur && classifyWords(cur.words) === "plsql";

  for (const seg of scan(text)) {
    if (seg.end <= skipUntil) continue;

    if (seg.type !== "code") {
      begin(seg.start);
      if (seg.type === "string" || seg.type === "quotedIdent") cur!.hasCode = true;
      continue;
    }

    let i = Math.max(seg.start, skipUntil);
    while (i < seg.end) {
      const ch = text[i];

      if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
        if (
          ch === "\n" &&
          options.blankLineSeparates &&
          cur?.hasCode &&
          !isPlsql() &&
          /\n[ \t\r]*\n/y.test(text.slice(i, i + 64))
        ) {
          finish(i, i, "blank");
        }
        i++;
        continue;
      }

      // `/` alone on its line ends the current statement (SQL or PL/SQL).
      if (ch === "/") {
        const lineStart = starts[lineAt(starts, i) - 1];
        const rest = /[ \t\r]*(?:\n|$)/y;
        rest.lastIndex = i + 1;
        if (/^[ \t]*$/.test(text.slice(lineStart, i)) && rest.test(text)) {
          const lineEnd = text[rest.lastIndex - 1] === "\n" ? rest.lastIndex - 1 : rest.lastIndex;
          if (cur?.hasCode) finish(lineStart, lineEnd, "/");
          i = lineEnd;
          continue;
        }
      }

      if (ch === ";") {
        if (cur?.hasCode && !isPlsql()) {
          finish(i, i + 1, ";");
        } else if (cur) {
          cur.hasCode = true;
        }
        i++;
        continue;
      }

      TOKEN.lastIndex = i;
      const tok = TOKEN.exec(text);
      begin(i);
      const c = cur!;

      if (!c.hasCode) {
        // First token of a statement: is this line a SQL*Plus command?
        const nl = text.indexOf("\n", i);
        const lineEnd = nl < 0 ? text.length : nl;
        const command = sqlPlusCommand(text.slice(i, lineEnd).replace(/\s+$/, ""));
        if (command) {
          // Leading comments become their own (empty) statement.
          if (c.start < i) {
            finish(i, i, "eol");
            begin(i);
          }
          finish(lineEnd, lineEnd, "eol", command);
          skipUntil = lineEnd; // also skips string/comment segments on this line
          i = lineEnd;
          continue;
        }
      }

      c.hasCode = true;
      if (tok) {
        if (!tok[0].startsWith("<<") && c.words.length < 8) c.words.push(tok[0].toUpperCase());
        i = TOKEN.lastIndex;
      } else {
        i++;
      }
    }
  }

  if (cur) finish(text.length, text.length, "eof");
  return out;
}

/**
 * The statement to run for a caret at `offset`: the one containing it, else
 * the one ending on the caret's line (caret after `;`), else the one starting
 * on that line. Comment-only ("empty") statements are ignored.
 */
export function statementAt(
  text: string,
  offset: number,
  options: SplitOptions = {},
): SqlStatement | undefined {
  return pickStatement(splitStatements(text, options), text, offset);
}

/** `statementAt` over an already-split list (lets callers cache the split). */
export function pickStatement(
  statements: SqlStatement[],
  text: string,
  offset: number,
): SqlStatement | undefined {
  const stmts = statements.filter((s) => s.kind !== "empty");
  const inside = stmts.find((s) => offset >= s.startOffset && offset <= s.endOffset);
  if (inside) return inside;
  const line = text.slice(0, offset).split("\n").length;
  return (
    stmts.find((s) => s.endLine === line && s.endOffset <= offset) ??
    stmts.find((s) => s.startLine === line && s.startOffset >= offset)
  );
}

/**
 * The text to send to the database for a statement, or `undefined` for
 * SQL*Plus commands that are handled client-side (SET, DEFINE, PROMPT, …).
 * `EXEC proc(…)` becomes the anonymous block `BEGIN proc(…); END;`.
 */
export function toExecutable(stmt: SqlStatement): string | undefined {
  if (stmt.kind === "sql" || stmt.kind === "plsql") return stmt.text;
  if (stmt.kind === "sqlplus" && stmt.command?.name === "EXEC" && stmt.command.args) {
    return `BEGIN ${stmt.command.args}; END;`;
  }
  return undefined;
}
