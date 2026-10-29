/**
 * Shared types between the completion worker and the main thread.
 * (No antlr imports here, so the main bundle never pulls in the parser.)
 */

export interface AliasInfo {
  /** Alias as written (or the bare table name when there is no alias). */
  alias: string;
  /** Table text as written (`hr.employees`), the CTE name, or "(subquery)". */
  table: string;
  /** What the alias stands for. */
  kind: "table" | "cte" | "subquery" | "record";
  /** Database link of a remote table (`emp@prod`). */
  dbLink?: string;
  /**
   * Columns known from the statement itself (CTE / inline view / cursor
   * select lists). When set, no metadata lookup is needed.
   */
  columns?: string[];
}

export interface CteInfo {
  name: string;
  /** Explicit column list or names derived from the select list. */
  columns?: string[];
}

/** A PL/SQL name declared in the statement being edited. */
export interface PlsqlSymbol {
  name: string;
  kind: "variable" | "constant" | "parameter" | "cursor" | "record" | "exception" | "type";
  /** Declared type as written (`employees.salary%TYPE`, `NUMBER`). */
  type?: string;
}

export interface OracleCaretContext {
  /** Keyword texts that are grammatically valid at the caret. */
  keywords: string[];
  /** An existing table / view / synonym is expected (FROM, INTO, UPDATE …). */
  expectTable: boolean;
  /** A column / qualified reference is expected (SELECT list, WHERE …). */
  expectColumn: boolean;
  /** A function name is expected (anywhere an expression is valid). */
  expectFunction: boolean;
  /** A procedure call is expected (PL/SQL statement position). */
  expectProcedure: boolean;
  /** A PL/SQL variable / INTO target is expected. */
  expectVariable: boolean;
  /** A data type is expected (declarations, CAST … AS). */
  expectType: boolean;
  /** A database link is expected (after `@`). */
  expectDbLink: boolean;
  /**
   * Qualifier chain typed before the caret, unquoted:
   *   `e.`       -> ["e"]
   *   `hr.emp.`  -> ["hr", "emp"]
   *   `:new.`    -> [":new"]
   */
  qualifier: string[];
  /** Per qualifier part: was it a quoted identifier (case-sensitive)? */
  qualifierQuoted: boolean[];
  /** The partial word immediately before the caret (for filtering). */
  partialWord: string;
  /** Tables, CTEs, inline views and records in scope. */
  aliases: AliasInfo[];
  /** WITH-clause names. */
  ctes: CteInfo[];
  /** PL/SQL variables, parameters, cursors … declared in the statement. */
  plsql: PlsqlSymbol[];
  /** Kind of the statement under the caret ("none" between statements). */
  statementKind: "sql" | "plsql" | "sqlplus" | "none";
}

export interface GrammarError {
  /** 1-based line. */
  line: number;
  /** 1-based start column (Monaco convention). */
  column: number;
  /** 1-based end column. */
  endColumn: number;
  message: string;
  /** Default "error"; syntax newer than `targetVersion` is a "warning". */
  severity?: "error" | "warning";
}

/** Which statements `validateGrammar` checks: SQL only, or SQL and PL/SQL. */
export type ValidateMode = "sql" | "all";

/** Oracle release whose syntax is accepted (mirrors `OracleVersion`). */
export type TargetVersion = "19c" | "21c" | "23ai";

/** The RPC surface the worker exposes via Comlink. */
export interface CompletionWorkerApi {
  getCaretContext(
    text: string,
    position: { line: number; column: number },
    options?: { version?: TargetVersion },
  ): OracleCaretContext;
  validateGrammar(text: string, mode?: ValidateMode, version?: TargetVersion): GrammarError[];
}
