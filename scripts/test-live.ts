/*
 * End-to-end test against a real database through a running gateway (opt-in).
 *
 *   ORACLE_GATEWAY_URL=http://127.0.0.1:8787/api ORACLE_ALIAS=free \
 *   ORACLE_USER=scott ORACLE_PASSWORD=... npx tsx scripts/test-live.ts
 *
 * The gateway must run with ALLOW_HEADER_AUTH=true (Node has no cookie jar).
 * Creates and drops OM_* objects in the user's schema.
 */
import { createGatewayTransport } from "../src/oracle/transport/gateway.js";
import { createOracleQueryRunner, OracleQueryError, type StatementResult } from "../src/oracle/runner.js";
import { createOracleMetadataProvider } from "../src/oracle/metadata.js";
import { splitStatements } from "../src/oracle/splitter.js";
import type { MetadataProviderContext } from "../src/oracle/completion.js";
import { signatureLabel, type CallSite } from "../src/oracle/signatures.js";
import { createServerValidator } from "../src/oracle/serverValidate.js";
import { assert, done, eq, section } from "./harness.js";

const url = process.env.ORACLE_GATEWAY_URL;
if (!url) {
  console.log("ORACLE_GATEWAY_URL not set — skipping live test.");
  process.exit(0);
}

const transport = createGatewayTransport({ baseUrl: url, headerAuth: true });
const login = await transport.login({
  connectAlias: process.env.ORACLE_ALIAS ?? "dev",
  user: process.env.ORACLE_USER ?? "scott",
  password: process.env.ORACLE_PASSWORD ?? "",
});
console.log(`connected: ${login.user} @ ${login.connectAlias}, Oracle ${login.version}`);

const metadata = createOracleMetadataProvider({ transport });
const runner = createOracleQueryRunner({ transport, metadata, maxRows: 5 });

async function script(sql: string): Promise<StatementResult[]> {
  const out: StatementResult[] = [];
  for await (const r of runner.runScript(sql)) out.push(r);
  return out;
}

const SEED = `
BEGIN
  FOR o IN (SELECT object_name, object_type FROM user_objects
             WHERE object_name LIKE 'OM\\_%' ESCAPE '\\'
               AND object_type IN ('TABLE', 'VIEW', 'SEQUENCE', 'PACKAGE', 'PROCEDURE', 'SYNONYM', 'TYPE')) LOOP
    EXECUTE IMMEDIATE 'DROP ' || o.object_type || ' "' || o.object_name || '"' ||
      CASE o.object_type WHEN 'TABLE' THEN ' CASCADE CONSTRAINTS PURGE' WHEN 'TYPE' THEN ' FORCE' END;
  END LOOP;
END;
/
CREATE TABLE om_dept (deptno NUMBER(2) PRIMARY KEY, dname VARCHAR2(14 CHAR) NOT NULL, loc VARCHAR2(13));
CREATE TABLE om_emp (
  empno NUMBER(4) PRIMARY KEY,
  ename VARCHAR2(10),
  sal NUMBER(7,2),
  hiredate DATE,
  deptno NUMBER(2) REFERENCES om_dept,
  "Nick Name" VARCHAR2(20)
);
COMMENT ON COLUMN om_emp.sal IS 'Monthly salary';
INSERT INTO om_dept VALUES (10, 'ACCOUNTING', 'NEW YORK');
INSERT INTO om_dept VALUES (20, 'RESEARCH', 'DALLAS');
INSERT INTO om_emp (empno, ename, sal, hiredate, deptno)
  SELECT 7000 + level, 'EMP' || level, 1000 + level * 10, DATE '2020-01-01' + level, 10 + MOD(level, 2) * 10
    FROM dual CONNECT BY level <= 12;
COMMIT;
CREATE SEQUENCE om_seq START WITH 100;
CREATE VIEW om_emp_v AS SELECT empno, ename FROM om_emp;
CREATE SYNONYM om_staff FOR om_emp;
CREATE OR REPLACE PACKAGE om_pkg AS
  FUNCTION total RETURN NUMBER;
  PROCEDURE raise_all (p_pct NUMBER);
END om_pkg;
/
CREATE OR REPLACE PACKAGE BODY om_pkg AS
  FUNCTION total RETURN NUMBER IS v NUMBER; BEGIN SELECT SUM(sal) INTO v FROM om_emp; RETURN v; END;
  PROCEDURE raise_all (p_pct NUMBER) IS BEGIN UPDATE om_emp SET sal = sal * (1 + p_pct / 100); END;
END om_pkg;
/
`;

section("seed via runScript");
{
  const results = await script(SEED);
  const failed = results.filter((r) => r.error);
  eq("seed script ran without errors", failed.map((r) => r.error?.message), []);
  eq("feedback messages", results.slice(1, 4).map((r) => r.message), ["Table created.", "Table created.", "Comment created."]);
  assert("INSERT … SELECT feedback", results.some((r) => r.message === "12 rows created."));
  assert("package body created", results.some((r) => r.message === "Package body created."));
}

section("queries and paging");
{
  const r = await runner.run("SELECT empno, ename, sal, hiredate FROM om_emp ORDER BY empno");
  eq("first page size", r.rows?.length, 5);
  assert("more available", r.hasMore && !!r.cursorId);
  eq("columns", r.columns?.map((c) => `${c.name}:${c.type}`), ["EMPNO:NUMBER", "ENAME:VARCHAR2", "SAL:NUMBER", "HIREDATE:DATE"]);
  eq("NUMBER as exact string, DATE as text", r.rows?.[0], ["7001", "EMP1", "1010", "2020-01-02 00:00:00"]);
  await runner.fetchMore(r);
  await runner.fetchMore(r);
  eq("all rows after paging", [r.rows?.length, r.hasMore], [12, false]);
}

section("errors located in the document");
{
  const doc = "SELECT 1 FROM dual;\n\nSELECT ename\n  FROM om_missing\n WHERE 1 = 1;";
  const stmt = splitStatements(doc)[1];
  try {
    await runner.run(stmt);
    assert("ORA-00942 raised", false);
  } catch (e) {
    const err = e as OracleQueryError;
    eq("code", err.code, "ORA-00942");
    eq("position of om_missing", [err.line, err.column, err.endColumn], [4, 8, 18]);
  }
  try {
    await runner.run("SELECT 1/0 FROM dual");
  } catch (e) {
    eq("runtime error code", (e as OracleQueryError).code, "ORA-01476");
  }
}

section("PL/SQL compilation errors");
{
  const doc = "-- broken\nCREATE OR REPLACE PROCEDURE om_bad IS\nBEGIN\n  x := 1;\nEND;\n/";
  const r = await runner.run(splitStatements(doc)[0]);
  eq("feedback", r.message, "Procedure created with compilation errors.");
  const first = r.compileErrors?.[0];
  eq("first error at x (document line 4, column 3)", [first?.line, first?.column], [4, 3]);
  assert("PLS message", /PLS-00201/.test(first?.message ?? ""));
  await runner.run("DROP PROCEDURE om_bad");
}

section("SQL*Plus behaviour");
{
  const results = await script(`
SET SERVEROUTPUT ON
DEFINE dept = 20
BEGIN
  DBMS_OUTPUT.PUT_LINE('dept=' || &dept);
  DBMS_OUTPUT.PUT_LINE('total=' || om_pkg.total);
END;
/
EXEC DBMS_OUTPUT.PUT_LINE('exec ok')
PROMPT done with &dept
SELECT COUNT(*) FROM om_emp WHERE deptno = &dept;
`);
  eq("no errors", results.filter((r) => r.error).map((r) => r.error?.message), []);
  eq("DBMS_OUTPUT captured", results[2].dbmsOutput, ["dept=20", "total=12780"]);
  eq("EXEC rewritten and run", results[3].dbmsOutput, ["exec ok"]);
  eq("PROMPT substituted", results[4].message, "done with 20");
  eq("substitution in SQL", results[5].rows, [["6"]]);
}

section("binds, transactions, describe");
{
  const r = await runner.run("SELECT ename FROM om_emp WHERE empno = :id", { binds: { id: 7003 } });
  eq("bind value", r.rows, [["EMP3"]]);
  await runner.run("UPDATE om_emp SET sal = 0 WHERE deptno = 10");
  await transport.rollback();
  const after = await runner.run("SELECT COUNT(*) FROM om_emp WHERE sal = 0");
  eq("rollback undid the update", after.rows, [["0"]]);
  const d = await runner.describe("om_staff");
  eq("DESC through a synonym", d.rows?.slice(0, 2), [["EMPNO", "NOT NULL", "NUMBER(4)"], ["ENAME", null, "VARCHAR2(10)"]]);
}

section("explain plan");
{
  const plan = await runner.explain("SELECT * FROM om_emp WHERE empno = :id");
  assert("DBMS_XPLAN output", plan.lines.some((l) => /TABLE ACCESS|INDEX UNIQUE SCAN/.test(l)));
}

section("cancel");
{
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 500);
  const t0 = Date.now();
  try {
    await runner.run("BEGIN DBMS_SESSION.SLEEP(10); END;", { signal: ctrl.signal });
  } catch (e) {
    eq("aborted call reports cancellation", (e as OracleQueryError).code, "CANCELLED");
  }
  assert("returned quickly", Date.now() - t0 < 5000);
  await new Promise((r) => setTimeout(r, 300));
  eq("session usable after cancel", (await runner.run("SELECT 1 FROM dual")).rows, [["1"]]);
}

section("metadata provider");
{
  const ctx = (c: Partial<MetadataProviderContext>): MetadataProviderContext => ({ text: "", position: { line: 1, column: 1 }, word: "", ...c });
  const labels = async (c: Partial<MetadataProviderContext>) => (await metadata(ctx(c))).map((m) => m.label);

  const from = await labels({ expectTable: true, word: "OM_" });
  assert("FROM om_| lists table, view, synonym", ["OM_EMP", "OM_DEPT", "OM_EMP_V", "OM_STAFF"].every((x) => from.includes(x)));
  const items = await metadata(ctx({ expectColumn: true, qualifier: ["e"], aliases: [{ alias: "e", table: "om_emp", kind: "table" }] }));
  eq("e. -> columns of om_emp", items.map((m) => m.label), ["EMPNO", "ENAME", "SAL", "HIREDATE", "DEPTNO", "Nick Name"]);
  eq("column detail and comment", [items[2].detail, items[2].documentation], ["NUMBER(7,2) · OM_EMP", "Monthly salary"]);
  eq("NOT NULL in detail", items[0].detail, "NUMBER(4) NOT NULL · OM_EMP");
  eq("synonym resolved", await labels({ expectColumn: true, qualifier: ["om_staff"] }), ["EMPNO", "ENAME", "SAL", "HIREDATE", "DEPTNO", "Nick Name"]);
  eq("package members", await labels({ expectFunction: true, expectColumn: true, qualifier: ["om_pkg"] }), ["RAISE_ALL", "TOTAL"]);
  eq("member kinds", (await metadata(ctx({ expectProcedure: true, qualifier: ["om_pkg"] }))).map((m) => m.kind), ["procedure", "function"]);
  eq("sequence pseudo-columns", await labels({ expectColumn: true, qualifier: ["om_seq"] }), ["NEXTVAL", "CURRVAL"]);
  assert("public synonym DBMS_OUTPUT members", (await labels({ expectProcedure: true, qualifier: ["dbms_output"], word: "PUT" })).includes("PUT_LINE"));
  assert("schema qualifier FROM scott.", (await labels({ expectTable: true, qualifier: [login.currentSchema.toLowerCase()], word: "om_" })).includes("OM_EMP"));
  assert("SELECT | columns of tables in scope", (await labels({ expectColumn: true, aliases: [{ alias: "d", table: "om_dept", kind: "table" }] })).includes("DNAME"));
  metadata.invalidate();
}

section("signatures, describe, server validation (Phase 4)");
{
  const site = (parts: string[]): CallSite => ({ parts, quoted: parts.map(() => false), argIndex: 0, namedArgs: [], atArgStart: true, openOffset: 0 });
  const put = await metadata.signatures(site(["dbms_output", "put_line"]));
  assert("DBMS_OUTPUT.PUT_LINE signature via public synonym", put.some((s) => /^DBMS_OUTPUT\.PUT_LINE\(A VARCHAR2\)$/.test(signatureLabel(s).label)), put.map((s) => signatureLabel(s).label));
  eq("package member", (await metadata.signatures(site(["om_pkg", "raise_all"]))).map((s) => signatureLabel(s).label), ["OM_PKG.RAISE_ALL(P_PCT NUMBER)"]);
  eq("function return type", (await metadata.signatures(site(["om_pkg", "total"]))).map((s) => signatureLabel(s).label), ["OM_PKG.TOTAL() RETURN NUMBER"]);

  const table = await metadata.describe({ parts: ["om_staff"], quoted: [false] });
  eq("describe synonym → table", [table?.kind, table?.name, table?.synonym?.endsWith(".OM_STAFF")], ["table", "OM_EMP", true]);
  eq("describe columns", table?.columns?.length, 6);
  const col = await metadata.describe({ parts: ["e", "sal"], quoted: [false, false], aliases: [{ alias: "e", table: "om_emp", kind: "table" }] });
  eq("describe alias.column", [col?.dataType, col?.comment], ["NUMBER(7,2)", "Monthly salary"]);
  eq("describe sequence", (await metadata.describe({ parts: ["om_seq"], quoted: [false] }))?.kind, "sequence");

  const validate = createServerValidator({ transport });
  eq("valid query", await validate(splitStatements("SELECT ename FROM om_emp")[0]), null);
  const missing = await validate(splitStatements("SELECT ename\n  FROM om_missing")[0]);
  eq("ORA-00942 at om_missing", missing && [missing.code, missing.offset, missing.length], ["ORA-00942", 20, 10]);
  const badCol = await validate(splitStatements("UPDATE om_emp SET nope = 1")[0]);
  eq("ORA-00904 at the column", badCol && [badCol.code, badCol.offset], ["ORA-00904", 18]);
  const count = await runner.run("SELECT COUNT(*) FROM plan_table WHERE statement_id LIKE 'OMV%'");
  eq("plan rows cleaned up", count.rows, [["0"]]);
}

section("cleanup");
{
  const results = await script(`
DROP SYNONYM om_staff;
DROP VIEW om_emp_v;
DROP PACKAGE om_pkg;
DROP SEQUENCE om_seq;
DROP TABLE om_emp PURGE;
DROP TABLE om_dept PURGE;
`);
  eq("dropped", results.map((r) => r.message), [
    "Synonym dropped.", "View dropped.", "Package dropped.", "Sequence dropped.", "Table dropped.", "Table dropped.",
  ]);
  await transport.logout();
}

done();
