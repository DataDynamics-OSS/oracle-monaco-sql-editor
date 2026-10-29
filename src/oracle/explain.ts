/**
 * EXPLAIN PLAN + DBMS_XPLAN.
 *
 * `EXPLAIN PLAN SET STATEMENT_ID = '<id>' FOR <stmt>` writes the plan to
 * PLAN_TABLE without executing the statement (binds need no values), then
 * `DBMS_XPLAN.DISPLAY` formats it. The plan rows are deleted afterwards.
 * PLAN_TABLE is session-private, so on a stateless transport (ORDS) both
 * statements go in one request.
 */
import { randomId, type OracleTransport } from "./transport/types";
import { findBindVariables } from "./variables";

export interface ExplainOptions {
  /** DBMS_XPLAN format: "BASIC", "TYPICAL" (default), "ALL", "TYPICAL +PEEKED_BINDS", … */
  format?: string;
  signal?: AbortSignal;
}

export interface ExplainResult {
  statementId: string;
  /** DBMS_XPLAN output, one line per element. */
  lines: string[];
}

export async function explainPlan(
  transport: OracleTransport,
  sql: string,
  options: ExplainOptions = {},
): Promise<ExplainResult> {
  const format = options.format ?? "TYPICAL";
  if (!/^[A-Za-z_ +\-]+$/.test(format)) throw new Error(`Invalid DBMS_XPLAN format: ${format}`);
  // Alphanumeric only: STATEMENT_ID must be a literal, it cannot be bound.
  const statementId = randomId("OM").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 30);

  // Plans do not depend on bind values, but drivers insist every placeholder is bound.
  const binds = Object.fromEntries(findBindVariables(sql, { preserveCase: true }).map((n) => [n, null]));
  const display = `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', '${statementId}', '${format}'))`;

  if (transport.stateless) {
    const plan = await transport.execute(
      {
        sql: `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${sql};\n${display}`,
        binds: Object.keys(binds).length ? binds : undefined,
        category: "query",
        maxRows: 5000,
      },
      options.signal,
    );
    return { statementId, lines: (plan.rows ?? []).map((r) => String(r[0] ?? "")) };
  }

  await transport.execute(
    { sql: `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${sql}`, binds, category: "other" },
    options.signal,
  );
  try {
    const plan = await transport.execute(
      {
        sql: "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, :fmt))",
        binds: { id: statementId, fmt: format },
        category: "query",
        maxRows: 5000,
      },
      options.signal,
    );
    return { statementId, lines: (plan.rows ?? []).map((r) => String(r[0] ?? "")) };
  } finally {
    await transport
      .execute({ sql: "DELETE FROM plan_table WHERE statement_id = :id", binds: { id: statementId }, category: "dml" })
      .catch(() => {});
  }
}
