/**
 * Statement / script runner for the editor's Run actions.
 *
 * Executes statements from the splitter over any `OracleTransport` the way
 * SQL*Plus / SQL Developer users expect:
 *   - `&var` / `&&var` substitution (DEFINE / UNDEFINE, prompt for unknowns)
 *   - `:bind` values from the call, remembered values, or a prompt
 *   - SQL*Plus commands handled client-side: SET SERVEROUTPUT, SET DEFINE,
 *     DEFINE, UNDEFINE, PROMPT, EXEC, DESC, WHENEVER SQLERROR
 *   - DBMS_OUTPUT capture while SERVEROUTPUT is on
 *   - paged query results (`fetchMore`) and cancellation via AbortSignal
 *   - ORA errors located in the document (`line` / `column`), and PL/SQL
 *     compilation errors read from ALL_ERRORS after CREATE … with errors
 *   - SQL*Plus style feedback ("3 rows updated.", "Procedure created.")
 *   - metadata cache invalidation after DDL / schema switches
 */
import { splitStatements, toExecutable, type SqlStatement } from "./splitter";
import { findBindVariables, parseDefine, substitute, type SubstitutionPrompt, type SubstitutionVariables } from "./variables";
import { splitQualified } from "./identifiers";
import { explainPlan, type ExplainOptions, type ExplainResult } from "./explain";
import { scan } from "./scanner";
import {
  OracleTransportError,
  randomId,
  type BindValue,
  type OracleColumn,
  type OracleTransport,
  type StatementCategory,
} from "./transport/types";

/** A PL/SQL compilation error or warning, in document coordinates. */
export interface CompileError {
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

export interface StatementResult {
  statement: SqlStatement;
  category: StatementCategory | "sqlplus";
  /** The text sent to the database (after substitution / EXEC rewrite). */
  sql?: string;
  columns?: OracleColumn[];
  rows?: unknown[][];
  /** More rows can be fetched with `fetchMore`. */
  hasMore: boolean;
  /** Script runs keep only the first page; this marks a page that was cut. */
  truncated?: boolean;
  cursorId?: string;
  rowsAffected?: number;
  outBinds?: Record<string, unknown> | unknown[];
  dbmsOutput?: string[];
  /** SQL*Plus-style feedback. */
  message?: string;
  compileErrors?: CompileError[];
  elapsedMs?: number;
  /** Set by `runScript` when the statement failed (`run` throws instead). */
  error?: OracleQueryError;
}

/** A failed statement, located in the document when the database said where. */
export class OracleQueryError extends Error {
  readonly code: string;
  /** 0-based offset in the statement text. */
  readonly offset?: number;
  readonly statement?: SqlStatement;
  /** 1-based document position of the error (statement start when unknown). */
  readonly line?: number;
  readonly column?: number;
  readonly endColumn?: number;

  constructor(
    code: string,
    message: string,
    details: { offset?: number; statement?: SqlStatement; line?: number; column?: number; endColumn?: number } = {},
  ) {
    super(message);
    this.name = "OracleQueryError";
    this.code = code;
    Object.assign(this, details);
  }
}

export interface OracleQueryRunnerOptions {
  transport: OracleTransport;
  /** Rows per page (default 500). */
  maxRows?: number;
  /** Initial SET SERVEROUTPUT state (default off). */
  serverOutput?: boolean;
  /** Shared DEFINE store (default: a new one per runner). */
  substitutionVariables?: SubstitutionVariables;
  /** Asked for undefined `&var` values. */
  onSubstitutionPrompt?: SubstitutionPrompt;
  /** Asked for bind values the call and the runner's store do not have. */
  onBindPrompt?: (names: string[]) => Promise<Record<string, BindValue>> | Record<string, BindValue>;
  /** Invalidated after DDL and schema switches (e.g. the metadata provider). */
  metadata?: { invalidate(): void };
  /** Current schema for ALL_ERRORS lookups (default: transport.session()). */
  currentSchema?: () => string | undefined;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Bind values for this call (names case-insensitive, without `:`). */
  binds?: Record<string, BindValue>;
  /** Called with each page of a query, starting with the first. */
  onPage?: (page: { columns: OracleColumn[]; rows: unknown[][] }) => void;
}

export interface RunScriptOptions extends RunOptions {
  /** Stop at the first error (also switched on by `WHENEVER SQLERROR EXIT`). */
  stopOnError?: boolean;
}

export interface OracleQueryRunner {
  /** Run one statement (a SqlStatement from the splitter, or SQL text). Throws OracleQueryError. */
  run(statement: SqlStatement | string, options?: RunOptions): Promise<StatementResult>;
  /** Run statements in order, yielding each result (errors are yielded, not thrown). */
  runScript(script: string | SqlStatement[], options?: RunScriptOptions): AsyncGenerator<StatementResult>;
  /** Fetch the next page into `result.rows`; returns the new rows. */
  fetchMore(result: StatementResult, maxRows?: number, signal?: AbortSignal): Promise<unknown[][]>;
  /** Close a result's open cursor. */
  close(result: StatementResult): Promise<void>;
  /** EXPLAIN PLAN for a statement (substitution variables resolved first). */
  explain(statement: SqlStatement | string, options?: ExplainOptions): Promise<ExplainResult>;
  /** Columns of a table / view (SQL*Plus DESCRIBE). */
  describe(objectName: string, signal?: AbortSignal): Promise<StatementResult>;
  /** DEFINE store. */
  readonly variables: SubstitutionVariables;
  /** Remembered bind values (upper-case names). */
  readonly binds: Map<string, BindValue>;
  /** SET SERVEROUTPUT state. */
  serverOutput: boolean;
}

// ---------------------------------------------------------------- helpers

/** First keywords of a statement, skipping leading comments. */
export function leadingWords(text: string, n = 4): string[] {
  const code = scan(text)
    .filter((s) => s.type === "code" || s.type === "quotedIdent")
    .map((s) => (s.type === "code" ? s.text : " x "))
    .join(" ");
  return (code.match(/[A-Za-z_][\w$#]*/g) ?? []).slice(0, n).map((w) => w.toUpperCase());
}

function categorize(stmt: SqlStatement): StatementCategory {
  const [w0, w1] = leadingWords(stmt.text, 2);
  if (stmt.kind === "plsql") return w0 === "CREATE" ? "ddl" : "plsql"; // CREATE PROCEDURE … is DDL
  if (w0 === "SELECT" || w0 === "WITH") return "query";
  if (["INSERT", "UPDATE", "DELETE", "MERGE", "LOCK"].includes(w0)) return "dml";
  if (["COMMIT", "ROLLBACK", "SAVEPOINT"].includes(w0) || (w0 === "SET" && w1 === "TRANSACTION")) return "tcl";
  if (w0 === "ALTER" && (w1 === "SESSION" || w1 === "SYSTEM")) return "other";
  if (["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "COMMENT", "GRANT", "REVOKE", "AUDIT", "NOAUDIT", "PURGE", "FLASHBACK", "ANALYZE"].includes(w0)) return "ddl";
  if (w0 === "CALL") return "plsql";
  return "other";
}

const PLURAL = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const OBJECT_WORDS = [
  "PACKAGE BODY", "TYPE BODY", "MATERIALIZED VIEW", "PUBLIC SYNONYM", "GLOBAL TEMPORARY TABLE",
  "TABLE", "VIEW", "INDEX", "SEQUENCE", "SYNONYM", "PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER",
  "TYPE", "USER", "ROLE", "DIRECTORY", "DATABASE LINK", "TABLESPACE", "PROFILE", "LIBRARY",
];

/** SQL*Plus-style feedback for a successful statement. */
function feedback(stmt: SqlStatement, category: StatementCategory, rowsAffected: number | undefined, withErrors: boolean): string | undefined {
  const words = leadingWords(stmt.text, 8);
  const [w0] = words;
  if (category === "dml") {
    const verb = { INSERT: "created", UPDATE: "updated", DELETE: "deleted", MERGE: "merged", LOCK: "locked" }[w0] ?? "affected";
    return w0 === "LOCK" ? "Table(s) Locked." : `${PLURAL(rowsAffected ?? 0, "row", "rows")} ${verb}.`;
  }
  if (category === "tcl") return { COMMIT: "Commit complete.", ROLLBACK: "Rollback complete.", SAVEPOINT: "Savepoint created." }[w0] ?? "Transaction set.";
  if (category === "plsql" && w0 !== "CALL") return "PL/SQL procedure successfully completed."; // blocks and EXEC
  if (category === "plsql") return "Call completed.";
  if (category === "other") {
    if (w0 === "ALTER") return words[1] === "SESSION" ? "Session altered." : "System altered.";
    if (w0 === "EXPLAIN") return "Explained.";
    return "Statement executed.";
  }
  if (category === "ddl") {
    if (w0 === "TRUNCATE") return "Table truncated.";
    if (w0 === "COMMENT") return "Comment created.";
    if (w0 === "GRANT") return "Grant succeeded.";
    if (w0 === "REVOKE") return "Revoke succeeded.";
    if (w0 === "RENAME") return "Table renamed.";
    const rest = words.slice(1).filter((w) => !["OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "FORCE", "NO", "UNIQUE", "BITMAP", "PRIVATE", "IF", "NOT", "EXISTS"].includes(w)).join(" ");
    const object = OBJECT_WORDS.find((o) => rest.startsWith(o)) ?? "Statement";
    const verb = { CREATE: "created", ALTER: "altered", DROP: "dropped" }[w0] ?? "processed";
    const name = object.charAt(0) + object.slice(1).toLowerCase();
    return `${name} ${verb}${withErrors ? " with compilation errors" : ""}.`;
  }
  return undefined;
}

/** Document position of a 0-based offset within a statement's text. */
function positionIn(stmt: SqlStatement, offset: number): { line: number; column: number } {
  const before = stmt.text.slice(0, Math.max(0, Math.min(offset, stmt.text.length)));
  const nl = before.lastIndexOf("\n");
  const lines = before.split("\n").length - 1;
  return {
    line: stmt.startLine + lines,
    column: lines === 0 ? stmt.startColumn + before.length : before.length - nl,
  };
}

/** Length of the token at `offset` (for the marker's width). */
export function tokenLength(text: string, offset: number): number {
  const m = /^(?:"[^"]*"|'(?:[^']|'')*'|[\w$#]+|\S)/.exec(text.slice(offset));
  return m ? m[0].length : 1;
}

const CREATE_PLSQL =
  /^((?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?)(PACKAGE\s+BODY|TYPE\s+BODY|PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|VIEW)\s+((?:"[^"]+"|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|[\w$#]+))?)/i;

// ---------------------------------------------------------------- runner

export function createOracleQueryRunner(options: OracleQueryRunnerOptions): OracleQueryRunner {
  const { transport } = options;
  const pageSize = Math.max(1, options.maxRows ?? 500);
  const variables: SubstitutionVariables = options.substitutionVariables ?? new Map();
  const binds = new Map<string, BindValue>();
  let defineOn = true;
  let schemaCache: Promise<string> | null = null;

  async function currentSchema(): Promise<string> {
    const s = options.currentSchema?.();
    if (s) return s;
    if (!schemaCache) {
      schemaCache = (
        transport.session
          ? transport.session().then((x) => x.currentSchema)
          : transport.execute({ sql: "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual", category: "query" })
              .then((r) => String(r.rows?.[0]?.[0] ?? ""))
      ).catch((e) => {
        schemaCache = null;
        throw e;
      });
    }
    return schemaCache;
  }

  function toQueryError(e: unknown, stmt: SqlStatement, mapOffset?: (o: number) => number): OracleQueryError {
    if (e instanceof OracleQueryError) return e;
    if (e instanceof DOMException && e.name === "AbortError") {
      return new OracleQueryError("CANCELLED", "Cancelled", { statement: stmt, line: stmt.startLine, column: stmt.startColumn });
    }
    const code = e instanceof OracleTransportError ? e.code : "CLIENT_ERROR";
    const message = e instanceof Error ? e.message : String(e);
    const raw = e instanceof OracleTransportError ? e.offset : undefined;
    if (raw !== undefined && mapOffset) {
      const offset = mapOffset(raw);
      const pos = positionIn(stmt, offset);
      return new OracleQueryError(code, message, {
        offset,
        statement: stmt,
        ...pos,
        endColumn: pos.column + tokenLength(stmt.text, offset),
      });
    }
    const first = leadingWords(stmt.text, 1)[0] ?? "";
    return new OracleQueryError(code, message, {
      statement: stmt,
      line: stmt.startLine,
      column: stmt.startColumn,
      endColumn: stmt.startColumn + Math.max(1, first.length),
    });
  }

  async function bindValuesFor(sql: string, given: Record<string, BindValue> | undefined): Promise<Record<string, BindValue> | undefined> {
    const names = findBindVariables(sql, { preserveCase: true });
    if (!names.length) return undefined;
    const fromCall = new Map(Object.entries(given ?? {}).map(([k, v]) => [k.replace(/^:/, "").toUpperCase(), v]));
    const missing = names.filter((n) => !fromCall.has(n.toUpperCase()) && !binds.has(n.toUpperCase()));
    if (missing.length) {
      if (!options.onBindPrompt) {
        throw new OracleQueryError("BIND_MISSING", `No value for bind variable${missing.length > 1 ? "s" : ""} ${missing.map((n) => `:${n}`).join(", ")}`);
      }
      const answered = await options.onBindPrompt(missing);
      for (const [k, v] of Object.entries(answered)) binds.set(k.replace(/^:/, "").toUpperCase(), v);
      const still = missing.filter((n) => !binds.has(n.toUpperCase()));
      if (still.length) throw new OracleQueryError("BIND_MISSING", `No value for bind variable(s) ${still.map((n) => `:${n}`).join(", ")}`);
    }
    return Object.fromEntries(names.map((n) => [n, fromCall.get(n.toUpperCase()) ?? binds.get(n.toUpperCase()) ?? null]));
  }

  async function compileErrors(stmt: SqlStatement): Promise<CompileError[]> {
    const m = CREATE_PLSQL.exec(stmt.text);
    if (!m) return [];
    const type = m[2].toUpperCase().replace(/\s+/, " ");
    const { parts } = splitQualified(m[3].replace(/\s+/g, ""));
    const owner = parts.length > 1 ? parts[0] : await currentSchema();
    const name = parts[parts.length - 1];
    const res = await transport.execute({
      sql: `SELECT line, position, text, attribute FROM all_errors
             WHERE owner = :owner AND name = :name AND type = :type ORDER BY sequence`,
      binds: { owner, name, type },
      category: "query",
      maxRows: 1000,
    });
    // Source line 1 starts at the object keyword; for triggers, at the PL/SQL block.
    let base = m[1].length;
    if (type === "TRIGGER") {
      const block = /\b(DECLARE|BEGIN|COMPOUND)\b/i.exec(stmt.text.slice(base));
      if (block) base += block.index;
    }
    const origin = positionIn(stmt, base);
    return (res.rows ?? []).map(([line, position, text, attribute]) => {
      const l = Number(line);
      const p = Number(position);
      return {
        line: origin.line + l - 1,
        column: l === 1 ? origin.column + p - 1 : p,
        message: String(text ?? "").trim(),
        severity: attribute === "WARNING" ? ("warning" as const) : ("error" as const),
      };
    });
  }

  interface ScriptState {
    stopOnError: boolean;
  }

  async function sqlPlus(stmt: SqlStatement, opts: RunOptions, state: ScriptState): Promise<StatementResult> {
    const cmd = stmt.command!;
    const result = (message?: string): StatementResult => ({ statement: stmt, category: "sqlplus", hasMore: false, message });
    const args = cmd.args;
    switch (cmd.name) {
      case "EXEC":
        return execute(stmt, opts);
      case "SET": {
        const so = /^SERVEROUT(?:PUT)?\s+(ON|OFF)\b/i.exec(args);
        if (so) {
          runner.serverOutput = so[1].toUpperCase() === "ON";
          return result();
        }
        const def = /^DEF(?:INE)?\s+(ON|OFF)\b/i.exec(args);
        if (def) {
          defineOn = def[1].toUpperCase() === "ON";
          return result();
        }
        return result(`Ignored: SET ${args}`);
      }
      case "DEFINE": {
        if (!args) return result([...variables].map(([k, v]) => `DEFINE ${k} = "${v}"`).join("\n"));
        const d = parseDefine(args);
        if (!d) return result(`Invalid DEFINE: ${args}`);
        if (d.value !== undefined) {
          variables.set(d.name, d.value);
          return result();
        }
        const v = variables.get(d.name);
        return result(v === undefined ? `SP2-0135: symbol ${d.name.toLowerCase()} is UNDEFINED` : `DEFINE ${d.name} = "${v}"`);
      }
      case "UNDEFINE":
        for (const n of args.split(/\s+/).filter(Boolean)) variables.delete(n.toUpperCase());
        return result();
      case "PROMPT":
        return result(defineOn ? (await substitute(args, variables, options.onSubstitutionPrompt)).text : args);
      case "DESC":
        return { ...(await describe(args, opts.signal)), statement: stmt };
      case "WHENEVER":
        if (/^SQLERROR\s+EXIT/i.test(args)) state.stopOnError = true;
        else if (/^SQLERROR\s+CONTINUE/i.test(args)) state.stopOnError = false;
        return result();
      case "REMARK":
        return result();
      default:
        return result(`Ignored SQL*Plus command: ${cmd.name}`);
    }
  }

  async function execute(stmt: SqlStatement, opts: RunOptions): Promise<StatementResult> {
    const original = toExecutable(stmt);
    if (original === undefined) return { statement: stmt, category: "sqlplus", hasMore: false };
    const isExec = stmt.kind === "sqlplus";
    const category = isExec ? "plsql" : categorize(stmt);

    let sql = original;
    let toOriginal = (o: number) => o;
    if (defineOn) {
      try {
        const sub = await substitute(original, variables, options.onSubstitutionPrompt);
        sql = sub.text;
        toOriginal = sub.toOriginal;
      } catch (e) {
        throw toQueryError(new OracleTransportError({ code: "SUBSTITUTION", message: (e as Error).message }), stmt);
      }
    }

    let callBinds: Record<string, BindValue> | undefined;
    try {
      callBinds = category === "ddl" ? undefined : await bindValuesFor(sql, opts.binds);
    } catch (e) {
      throw toQueryError(e, stmt);
    }

    const executionId = randomId("ex");
    const started = Date.now();
    let res;
    try {
      res = await transport.execute(
        {
          sql,
          binds: callBinds,
          category,
          maxRows: pageSize,
          captureDbmsOutput: runner.serverOutput,
          executionId,
        },
        opts.signal,
      );
    } catch (e) {
      // EXEC was rewritten to BEGIN …; END; — offsets do not map back.
      throw toQueryError(e, stmt, isExec ? undefined : toOriginal);
    }

    const result: StatementResult = {
      statement: stmt,
      category,
      sql,
      hasMore: !!res.cursorId,
      elapsedMs: res.elapsedMs ?? Date.now() - started,
    };
    if (res.columns) {
      result.columns = res.columns;
      result.rows = res.rows ?? [];
      if (res.cursorId) result.cursorId = res.cursorId;
      result.message = res.cursorId
        ? `${PLURAL(result.rows.length, "row", "rows")} fetched (more available).`
        : `${PLURAL(result.rows.length, "row", "rows")} selected.`;
      opts.onPage?.({ columns: result.columns, rows: result.rows });
    }
    if (res.rowsAffected !== undefined) result.rowsAffected = res.rowsAffected;
    if (res.outBinds !== undefined) result.outBinds = res.outBinds;
    if (res.dbmsOutput) result.dbmsOutput = res.dbmsOutput;

    // Not every transport reports "created with compilation errors" (ORDS does
    // not), so always ask ALL_ERRORS after creating a PL/SQL unit or view.
    const warned = !!res.warning && /^(NJS-700|ORA-24344)$/.test(res.warning.code);
    if (warned || (category === "ddl" && CREATE_PLSQL.test(stmt.text))) {
      result.compileErrors = await compileErrors(stmt).catch(() => []);
    }
    if (!res.columns) {
      result.message = feedback(stmt, category, res.rowsAffected, !!result.compileErrors?.some((c) => c.severity === "error"));
    }

    // Dictionary caches go stale after DDL or a schema switch.
    const words = leadingWords(stmt.text, 6).join(" ");
    if (category === "ddl" || /^ALTER SESSION SET CURRENT_SCHEMA/.test(words)) {
      options.metadata?.invalidate();
      schemaCache = null;
    }
    return result;
  }

  async function runOne(stmt: SqlStatement, opts: RunOptions, state: ScriptState): Promise<StatementResult> {
    if (stmt.kind === "sqlplus") return sqlPlus(stmt, opts, state);
    return execute(stmt, opts);
  }

  async function describe(objectName: string, signal?: AbortSignal): Promise<StatementResult> {
    const { parts } = splitQualified(objectName.trim());
    const statement = splitStatements(`DESC ${objectName}`)[0];
    if (!parts.length) throw new OracleQueryError("DESCRIBE", "Nothing to describe", { statement });
    let owner = parts.length > 1 ? parts[0] : await currentSchema();
    let name = parts[parts.length - 1];
    const columnsSql = `SELECT column_name "Name", DECODE(nullable, 'N', 'NOT NULL') "Null?",
        CASE
          WHEN data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR') THEN data_type || '(' || char_length || DECODE(char_used, 'C', ' CHAR') || ')'
          WHEN data_type = 'NUMBER' AND data_precision IS NOT NULL THEN 'NUMBER(' || data_precision || DECODE(data_scale, 0, '', ',' || data_scale) || ')'
          WHEN data_type = 'RAW' THEN 'RAW(' || data_length || ')'
          ELSE data_type
        END "Type"
      FROM all_tab_columns WHERE owner = :owner AND table_name = :name ORDER BY column_id`;
    let res = await transport.execute({ sql: columnsSql, binds: { owner, name }, category: "query", maxRows: 2000 }, signal);
    if (!res.rows?.length && parts.length === 1) {
      const syn = await transport.execute(
        {
          sql: `SELECT table_owner, table_name FROM all_synonyms
                 WHERE synonym_name = :name AND owner IN (:owner, 'PUBLIC') AND db_link IS NULL
                 ORDER BY DECODE(owner, 'PUBLIC', 2, 1) FETCH FIRST 1 ROWS ONLY`,
          binds: { owner, name },
          category: "query",
        },
        signal,
      );
      const [target] = syn.rows ?? [];
      if (target) {
        owner = String(target[0]);
        name = String(target[1]);
        res = await transport.execute({ sql: columnsSql, binds: { owner, name }, category: "query", maxRows: 2000 }, signal);
      }
    }
    if (!res.rows?.length) {
      throw new OracleQueryError("ORA-04043", `ORA-04043: object ${objectName} does not exist`, { statement });
    }
    return {
      statement,
      category: "query",
      columns: res.columns,
      rows: res.rows,
      hasMore: false,
      message: `${owner}.${name}`,
    };
  }

  const runner: OracleQueryRunner = {
    variables,
    binds,
    serverOutput: options.serverOutput ?? false,

    async run(statement, opts = {}) {
      const stmt =
        typeof statement === "string"
          ? splitStatements(statement).find((s) => s.kind !== "empty")
          : statement;
      if (!stmt) throw new OracleQueryError("EMPTY", "Nothing to run");
      return runOne(stmt, opts, { stopOnError: false });
    },

    async *runScript(script, opts = {}) {
      const stmts = (typeof script === "string" ? splitStatements(script) : script).filter((s) => s.kind !== "empty");
      const state: ScriptState = { stopOnError: opts.stopOnError ?? false };
      for (const stmt of stmts) {
        if (opts.signal?.aborted) return;
        let result: StatementResult;
        try {
          result = await runOne(stmt, opts, state);
          if (result.cursorId) {
            // Scripts keep only the first page of each query.
            await transport.closeCursor?.(result.cursorId).catch(() => {});
            result = {
              ...result,
              cursorId: undefined,
              hasMore: false,
              truncated: true,
              message: `${PLURAL(result.rows?.length ?? 0, "row", "rows")} shown (first page only).`,
            };
          }
        } catch (e) {
          const error = toQueryError(e, stmt);
          yield { statement: stmt, category: categorize(stmt), hasMore: false, error, message: error.message };
          if (state.stopOnError || error.code === "CANCELLED") return;
          continue;
        }
        yield result;
      }
    },

    async fetchMore(result, maxRows = pageSize, signal) {
      if (!result.cursorId || !transport.fetchRows) return [];
      const page = await transport.fetchRows(result.cursorId, maxRows, signal);
      result.rows = [...(result.rows ?? []), ...page.rows];
      result.hasMore = page.hasMore;
      if (!page.hasMore) result.cursorId = undefined;
      result.message = page.hasMore
        ? `${PLURAL(result.rows.length, "row", "rows")} fetched (more available).`
        : `${PLURAL(result.rows.length, "row", "rows")} selected.`;
      return page.rows;
    },

    async close(result) {
      if (result.cursorId) await transport.closeCursor?.(result.cursorId).catch(() => {});
      result.cursorId = undefined;
      result.hasMore = false;
    },

    async explain(statement, opts) {
      const text =
        typeof statement === "string" ? statement : statement.kind === "sql" ? statement.text : toExecutable(statement) ?? "";
      const sql = defineOn ? (await substitute(text, variables, options.onSubstitutionPrompt)).text : text;
      return explainPlan(transport, sql, opts);
    },

    describe,
  };

  return runner;
}
