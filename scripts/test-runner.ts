/* Node test for the query runner over a mock transport. Run: npx tsx scripts/test-runner.ts */
import { createMockTransport } from "../src/oracle/transport/mock.js";
import { createOracleQueryRunner, type OracleQueryError, type StatementResult } from "../src/oracle/runner.js";
import { splitStatements } from "../src/oracle/splitter.js";
import { assert, done, eq, section } from "./harness.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => [String(i + 1)]);

function setup() {
  const t = createMockTransport({ session: { currentSchema: "HR" } });
  t.on(/FROM big/i, { columns: [{ name: "N", type: "NUMBER" }], rows: rows(12) });
  t.on(/^SELECT 1 FROM dual$/i, { columns: [{ name: "1", type: "NUMBER" }], rows: [["1"]] });
  t.on(/^UPDATE/i, { rowsAffected: 3 });
  t.on(/^INSERT/i, { rowsAffected: 1 });
  t.on(/no_such/i, { error: { code: "ORA-00942", message: "ORA-00942: table or view does not exist", offset: 14 } });
  t.on(/^BEGIN/i, (req) => ({ dbmsOutput: req.captureDbmsOutput ? ["out"] : undefined }));
  const invalidated: number[] = [];
  const runner = createOracleQueryRunner({ transport: t, maxRows: 5, metadata: { invalidate: () => invalidated.push(1) } });
  return { t, runner, invalidated };
}

async function collect(gen: AsyncGenerator<StatementResult>): Promise<StatementResult[]> {
  const out: StatementResult[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

section("queries and paging");
{
  const { t, runner } = setup();
  const pages: number[] = [];
  const r = await runner.run("SELECT n FROM big;", { onPage: (p) => pages.push(p.rows.length) });
  eq("first page", [r.rows?.length, r.hasMore, r.message], [5, true, "5 rows fetched (more available)."]);
  eq("request", [t.calls[0].sql, t.calls[0].category, t.calls[0].maxRows], ["SELECT n FROM big", "query", 5]);
  eq("onPage called with the first page", pages, [5]);
  await runner.fetchMore(r);
  await runner.fetchMore(r);
  eq("paged to the end", [r.rows?.length, r.hasMore, r.cursorId, r.message], [12, false, undefined, "12 rows selected."]);
}

section("feedback");
{
  const { runner, invalidated } = setup();
  eq("UPDATE", (await runner.run("UPDATE emp SET sal = 0")).message, "3 rows updated.");
  eq("INSERT", (await runner.run("INSERT INTO emp VALUES (1)")).message, "1 row created.");
  eq("CREATE TABLE", (await runner.run("CREATE TABLE t (a NUMBER)")).message, "Table created.");
  eq("DROP VIEW", (await runner.run("DROP VIEW v")).message, "View dropped.");
  eq("ALTER SESSION", (await runner.run("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY'")).message, "Session altered.");
  eq("COMMIT", (await runner.run("COMMIT")).message, "Commit complete.");
  eq("anonymous block", (await runner.run("BEGIN NULL; END;")).message, "PL/SQL procedure successfully completed.");
  eq("CREATE PACKAGE BODY", (await runner.run("CREATE OR REPLACE PACKAGE BODY p AS END;\n/")).message, "Package body created.");
  eq("metadata invalidated after each DDL (3)", invalidated.length, 3);
  await runner.run("ALTER SESSION SET CURRENT_SCHEMA = scott");
  eq("…and after a schema switch", invalidated.length, 4);
}

section("errors are located in the document");
{
  const { runner } = setup();
  const doc = "SELECT 1 FROM dual;\n  SELECT * FROM no_such WHERE x = 1;";
  const stmt = splitStatements(doc)[1];
  try {
    await runner.run(stmt);
  } catch (e) {
    const err = e as OracleQueryError;
    eq("code + offset", [err.code, err.offset], ["ORA-00942", 14]);
    eq("line / columns", [err.line, err.column, err.endColumn], [2, 17, 24]);
  }
}
{
  const { t, runner } = setup();
  runner.variables.set("TAB", "a_much_longer_name");
  t.on(/a_much_longer_name/, { error: { code: "ORA-00904", message: "ORA-00904: invalid identifier", offset: 33 } });
  // after substitution: "SELECT x FROM a_much_longer_name WHERE bad = 1" — offset 33 is `WHERE`
  try {
    await runner.run("SELECT x FROM &tab WHERE bad = 1");
  } catch (e) {
    const err = e as OracleQueryError;
    eq("offset mapped back through substitution", [err.offset, err.column], [19, 20]);
  }
}

section("SQL*Plus commands");
{
  const { t, runner } = setup();
  const results = await collect(
    runner.runScript(`
SET SERVEROUTPUT ON
DEFINE tab = big
PROMPT reading &tab
SELECT n FROM &tab;
EXEC dbms_output.put_line('x')
UNDEFINE tab
DEFINE tab
SPOOL out.txt
`),
  );
  eq("messages", results.map((r) => r.message ?? ""), [
    "",
    "",
    "reading big",
    "5 rows shown (first page only).",
    "PL/SQL procedure successfully completed.",
    "",
    "SP2-0135: symbol tab is UNDEFINED",
    "Ignored SQL*Plus command: SPOOL",
  ]);
  eq("substituted SQL sent", t.calls[0].sql, "SELECT n FROM big");
  eq("script keeps only the first page", [results[3].truncated, results[3].hasMore], [true, false]);
  eq("EXEC rewritten", t.calls[1].sql, "BEGIN dbms_output.put_line('x'); END;");
  eq("SERVEROUTPUT requests DBMS_OUTPUT", [t.calls[1].captureDbmsOutput, results[4].dbmsOutput], [true, ["out"]]);
}

section("script error handling");
{
  const { runner } = setup();
  const cont = await collect(runner.runScript("SELECT * FROM no_such;\nSELECT 1 FROM dual;"));
  eq("errors are yielded and the script continues", cont.map((r) => r.error?.code ?? "ok"), ["ORA-00942", "ok"]);
  const stop = await collect(runner.runScript("WHENEVER SQLERROR EXIT\nSELECT * FROM no_such;\nSELECT 1 FROM dual;"));
  eq("WHENEVER SQLERROR EXIT stops", stop.map((r) => r.error?.code ?? "ok"), ["ok", "ORA-00942"]);
}

section("bind variables");
{
  const { t, runner } = setup();
  t.on(/:id/, (req) => ({ columns: [{ name: "X", type: "NUMBER" }], rows: [[JSON.stringify(req.binds)]] }));
  eq("call binds (case-insensitive)", (await runner.run("SELECT x FROM t WHERE id = :id", { binds: { ID: 7 } })).rows, [['{"id":7}']]);
  try {
    await runner.run("SELECT x FROM t WHERE id = :id");
    assert("missing bind rejected", false);
  } catch (e) {
    eq("missing bind without prompt", (e as OracleQueryError).code, "BIND_MISSING");
  }
  const asked: string[][] = [];
  const prompted = createOracleQueryRunner({ transport: t, onBindPrompt: (names) => (asked.push(names), { id: 9 }) });
  await prompted.run("SELECT x FROM t WHERE id = :id");
  await prompted.run("SELECT x FROM t WHERE id = :id");
  eq("prompted once, then remembered", asked, [["id"]]);
  await prompted.run("CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :new.id := 1; END;\n/");
  eq("DDL sent without binds", t.calls.find((c) => /CREATE OR REPLACE TRIGGER/.test(c.sql))?.binds, undefined);
}

section("compilation errors");
{
  const t = createMockTransport({ session: { currentSchema: "HR" } });
  t.on(/CREATE OR REPLACE PROCEDURE/i, { rowsAffected: 0, warning: { code: "NJS-700", message: "creation succeeded with compilation errors" } });
  t.on(/all_errors/i, (req) => {
    eq("ALL_ERRORS lookup binds", req.binds, { owner: "HR", name: "P", type: "PROCEDURE" });
    return {
      columns: [],
      rows: [
        [3, 3, "PLS-00201: identifier 'X' must be declared", "ERROR"],
        [1, 11, "PLW-05018: unit P omitted optional AUTHID clause", "WARNING"],
      ],
    };
  });
  const runner = createOracleQueryRunner({ transport: t });
  const doc = "-- header\n  CREATE OR REPLACE PROCEDURE p IS\nBEGIN\n  x := 1;\nEND;\n/";
  const r = await runner.run(splitStatements(doc)[0]);
  eq("feedback", r.message, "Procedure created with compilation errors.");
  eq("mapped to the document", r.compileErrors?.map((c) => [c.line, c.column, c.severity]), [[4, 3, "error"], [2, 31, "warning"]]);
}

section("describe and explain");
{
  const t = createMockTransport({ session: { currentSchema: "HR" } });
  t.on(/FROM all_tab_columns/i, (req) =>
    (req.binds as Record<string, string>).name === "EMPLOYEES"
      ? { columns: [{ name: "Name", type: "VARCHAR2" }], rows: [["ID", "NOT NULL", "NUMBER(6)"]] }
      : { columns: [], rows: [] },
  );
  t.on(/FROM all_synonyms/i, { columns: [], rows: [["HR", "EMPLOYEES"]] });
  t.on(/DBMS_XPLAN/i, { columns: [], rows: [["Plan hash value: 1"], ["| 0 | SELECT STATEMENT |"]] });
  const runner = createOracleQueryRunner({ transport: t });
  const d = await runner.describe("staff");
  eq("DESC follows a synonym", [d.message, d.rows], ["HR.EMPLOYEES", [["ID", "NOT NULL", "NUMBER(6)"]]]);
  const plan = await runner.explain("SELECT * FROM t WHERE id = :id");
  eq("plan lines", plan.lines, ["Plan hash value: 1", "| 0 | SELECT STATEMENT |"]);
  const explainCall = t.calls.find((c) => c.sql.startsWith("EXPLAIN PLAN"));
  eq("EXPLAIN binds placeholders with NULL", explainCall?.binds, { id: null });
  assert("plan rows cleaned up", t.calls.some((c) => /DELETE FROM plan_table/.test(c.sql)));
}

section("cancellation");
{
  const t = createMockTransport({ latencyMs: 200 });
  const runner = createOracleQueryRunner({ transport: t });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  try {
    await runner.run("SELECT 1 FROM dual", { signal: ctrl.signal });
  } catch (e) {
    eq("aborted run -> CANCELLED", (e as OracleQueryError).code, "CANCELLED");
  }
}

done();
