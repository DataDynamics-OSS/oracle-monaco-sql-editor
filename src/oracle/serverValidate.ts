/**
 * Server-side validation without execution.
 *
 * The reduced client grammar checks syntax only; whether tables, columns and
 * privileges exist is up to the database. `EXPLAIN PLAN FOR <stmt>` makes
 * Oracle parse and resolve the statement — ORA-00942, ORA-00904, ORA-01031 …
 * come back with an offset — without running it.
 *
 * Only queries and DML are validated. DDL is never sent: Oracle executes DDL
 * while parsing it. Statements with undefined substitution variables are
 * skipped; bind variables are bound to NULL (plans ignore their values).
 */
import { randomId, OracleTransportError, type OracleTransport } from "./transport/types";
import { findBindVariables, findSubstitutionVariables, substitute, type SubstitutionVariables } from "./variables";
import { leadingWords, tokenLength } from "./runner";
import type { SqlStatement } from "./splitter";

/** A problem in a statement, relative to `SqlStatement.text`. */
export interface ServerValidationIssue {
  /** ORA code, e.g. "ORA-00942". */
  code: string;
  message: string;
  /** 0-based offset in the statement text (statement start when Oracle gave none). */
  offset: number;
  /** Characters to underline. */
  length: number;
}

/**
 * Validates one statement. Resolves to an issue, `null` when the database
 * accepted it, or `undefined` when it was not checked (not a query / DML,
 * unresolved substitution variables, transport busy or failing).
 */
export type ServerValidator = (
  statement: SqlStatement,
  signal?: AbortSignal,
) => Promise<ServerValidationIssue | null | undefined>;

export interface ServerValidatorOptions {
  transport: OracleTransport;
  /** DEFINE values used for `&var` (e.g. the runner's `variables`); never modified. */
  substitutionVariables?: SubstitutionVariables;
  /**
   * Return true to skip validation for now (e.g. while a statement runs on the
   * same single-connection session, so the EXPLAIN does not queue behind it).
   */
  paused?: () => boolean;
}

const VALIDATED = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE"]);

/**
 * Errors about the environment rather than the statement: no PLAN_TABLE,
 * no privilege to explain a view's base tables, cancelled, session gone.
 */
const IGNORED = new Set(["ORA-02402", "ORA-02403", "ORA-02404", "ORA-01039", "ORA-01013", "ORA-03113", "ORA-03114", "ORA-03135"]);

/** Whether `statement` is something server validation may send (query / DML). */
export function isServerValidatable(statement: SqlStatement): boolean {
  if (statement.kind !== "sql") return false;
  const [w0] = leadingWords(statement.text, 1);
  return VALIDATED.has(w0 ?? "");
}

export function createServerValidator(options: ServerValidatorOptions): ServerValidator {
  const { transport } = options;

  return async (statement, signal) => {
    if (!isServerValidatable(statement) || options.paused?.()) return undefined;

    let sql = statement.text;
    let toOriginal = (o: number) => o;
    if (findSubstitutionVariables(sql).length) {
      try {
        const sub = await substitute(sql, new Map(options.substitutionVariables ?? []));
        sql = sub.text;
        toOriginal = sub.toOriginal;
      } catch {
        return undefined; // undefined &var: the user will be prompted at run time
      }
    }

    const statementId = randomId("OMV").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 30);
    const prefix = `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR `;
    const names = findBindVariables(sql, { preserveCase: true });
    const binds = names.length ? Object.fromEntries(names.map((n) => [n, null])) : undefined;

    try {
      await transport.execute({ sql: prefix + sql, binds, category: "other" }, signal);
    } catch (e) {
      if (!(e instanceof OracleTransportError) || !/^ORA-\d+$/.test(e.code) || IGNORED.has(e.code)) return undefined;
      const raw = e.offset !== undefined && e.offset >= prefix.length ? e.offset - prefix.length : undefined;
      const offset = raw === undefined ? 0 : toOriginal(Math.min(raw, sql.length));
      const length = raw === undefined ? Math.max(1, (leadingWords(statement.text, 1)[0] ?? "").length) : tokenLength(statement.text, offset);
      return { code: e.code, message: e.message, offset, length };
    }

    if (!transport.stateless) {
      await transport
        .execute({ sql: "DELETE FROM plan_table WHERE statement_id = :id", binds: { id: statementId }, category: "dml" })
        .catch(() => {});
    }
    return null;
  };
}
