/* Node test for the context-aware completion core. Run: npx tsx scripts/test-core.ts */
import { getCaretContext, validateGrammar } from "../src/worker/completionCore.js";
import type { OracleCaretContext } from "../src/worker/protocol.js";
import type { OracleVersion } from "../src/oracle/keywords.js";
import { assert, done, eq, section } from "./harness.js";

/** Caret context for `sql` with the caret marked by `|`. */
function ctx(sql: string, version?: OracleVersion): OracleCaretContext {
  const idx = sql.indexOf("|");
  const text = sql.slice(0, idx) + sql.slice(idx + 1);
  const lines = sql.slice(0, idx).split("\n");
  return getCaretContext(text, { line: lines.length, column: lines[lines.length - 1].length + 1 }, { version });
}

const aliasMap = (c: OracleCaretContext) =>
  Object.fromEntries(c.aliases.map((a) => [a.alias, a.columns ? `${a.table}[${a.columns.join(",")}]` : a.table]));

section("statement start");
{
  const c = ctx("|");
  for (const kw of ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "BEGIN", "DECLARE"]) {
    assert(`start offers ${kw}`, c.keywords.includes(kw));
  }
  assert("partial keyword SEL offers SELECT", ctx("SEL|").keywords.includes("SELECT"));
  assert("after `;` a new statement starts", ctx("SELECT 1 FROM dual;\n|").keywords.includes("SELECT"));
  eq("caret after `;` on the next statement", ctx("SELECT 1 FROM dual; SELECT * FROM |").expectTable, true);
}

section("queries");
{
  const c = ctx("SELECT * FROM |");
  assert("FROM -> expectTable", c.expectTable);
  assert("FROM does not suggest SELECT", !c.keywords.includes("SELECT"));
  assert("FROM offers TABLE( / LATERAL", c.keywords.includes("TABLE") && c.keywords.includes("LATERAL"));
}
{
  const c = ctx("SELECT | FROM emp e");
  assert("SELECT list -> expectColumn", c.expectColumn);
  assert("SELECT list -> expectFunction", c.expectFunction);
  eq("SELECT list sees FROM alias (placeholder re-parse)", aliasMap(c), { e: "emp" });
}
{
  const c = ctx("SELECT e.| FROM hr.employees e");
  eq("e. -> qualifier [e]", c.qualifier, ["e"]);
  assert("e. -> expectColumn", c.expectColumn);
  eq("alias e -> hr.employees", aliasMap(c).e, "hr.employees");
  eq("e. -> no keywords", c.keywords, []);
}
{
  const c = ctx("SELECT * FROM emp e JOIN dept d ON d.|");
  eq("ON d. -> qualifier [d]", c.qualifier, ["d"]);
  eq("both join aliases", aliasMap(c), { e: "emp", d: "dept" });
}
assert("WHERE -> expectColumn", ctx("SELECT * FROM emp WHERE |").expectColumn);
assert("WHERE offers EXISTS", ctx("SELECT * FROM emp WHERE |").keywords.includes("EXISTS"));
eq("FROM hr. -> schema qualifier, table expected", [ctx("SELECT * FROM hr.|").qualifier, ctx("SELECT * FROM hr.|").expectTable], [["hr"], true]);
eq("quoted qualifier keeps case", [ctx('SELECT * FROM "Hr".|').qualifier, ctx('SELECT * FROM "Hr".|').qualifierQuoted], [["Hr"], [true]]);
assert("after `@` -> expectDbLink", ctx("SELECT * FROM emp@|").expectDbLink);
eq("remote table alias carries the link", ctx("SELECT x.| FROM emp@prod x").aliases[0]?.dbLink, "prod");
{
  const c = ctx("SELECT * FROM emp ORDER BY sal |");
  assert("ORDER BY item offers ASC/DESC/NULLS", ["ASC", "DESC", "NULLS"].every((k) => c.keywords.includes(k)));
  assert("ORDER BY item offers FETCH/OFFSET", c.keywords.includes("FETCH") && c.keywords.includes("OFFSET"));
}
eq("FETCH -> FIRST/NEXT", ctx("SELECT * FROM emp FETCH |").keywords, ["FIRST", "NEXT"]);
assert("CONNECT BY PRIOR -> expectColumn", ctx("SELECT * FROM emp START WITH mgr IS NULL CONNECT BY PRIOR |").expectColumn);
assert("GROUP BY -> ROLLUP/CUBE offered", ctx("SELECT a FROM t GROUP BY |").keywords.includes("ROLLUP"));
assert("analytic OVER( -> PARTITION", ctx("SELECT ROW_NUMBER() OVER (|) FROM t").keywords.includes("PARTITION"));
assert("COUNT( -> column + DISTINCT", ctx("SELECT COUNT(|) FROM emp").expectColumn && ctx("SELECT COUNT(|) FROM emp").keywords.includes("DISTINCT"));
assert("MINUS second block -> column", ctx("SELECT a FROM t MINUS SELECT | FROM s").expectColumn);
assert("CAST( x AS -> expectType", ctx("SELECT CAST(x AS |) FROM t").expectType);
assert("Oracle aliases take no AS: FROM t | offers WHERE", ctx("SELECT * FROM t x |").keywords.includes("WHERE"));

section("CTEs and inline views");
{
  const c = ctx("WITH x AS (SELECT a, b AS bb FROM t) SELECT x.| FROM x");
  eq("CTE columns derived", aliasMap(c).x, "x[a,bb]");
  eq("ctes list", c.ctes, [{ name: "x", columns: ["a", "bb"] }]);
}
eq("CTE explicit column list", ctx("WITH x (p, q) AS (SELECT 1, 2 FROM dual) SELECT * FROM |").ctes, [{ name: "x", columns: ["p", "q"] }]);
eq("inline view columns", aliasMap(ctx("SELECT v.| FROM (SELECT empno, ename n FROM emp) v")).v, "(subquery)[empno,n]");
eq("SELECT * inline view falls back to its table", aliasMap(ctx("SELECT v.| FROM (SELECT * FROM emp) v")).v, "emp");

section("DML / DDL");
assert("INSERT INTO -> expectTable", ctx("INSERT INTO |").expectTable);
{
  const c = ctx("INSERT INTO emp (|)");
  assert("INSERT column list -> expectColumn", c.expectColumn);
  eq("INSERT target in scope", aliasMap(c), { emp: "emp" });
}
assert("UPDATE -> expectTable", ctx("UPDATE |").expectTable);
eq("UPDATE SET -> columns of target alias", [ctx("UPDATE emp e SET |").expectColumn, aliasMap(ctx("UPDATE emp e SET |"))], [true, { e: "emp" }]);
assert("DELETE FROM -> expectTable", ctx("DELETE FROM |").expectTable);
eq("MERGE WHEN -> MATCHED/NOT", ctx("MERGE INTO t USING s ON (t.id = s.id) WHEN |").keywords, ["MATCHED", "NOT"]);
eq("MERGE target and source aliases", aliasMap(ctx("MERGE INTO emp t USING src s ON (t.id = s.|)")), { t: "emp", s: "src" });
assert("CREATE TABLE column -> expectType", ctx("CREATE TABLE t (a |").expectType);
assert("CREATE TABLE column -> constraint keywords", ctx("CREATE TABLE t (a NUMBER |").keywords.includes("PRIMARY"));
assert("CREATE TABLE name is new: no table expected", !ctx("CREATE TABLE |").expectTable);
assert("DROP TABLE -> expectTable", ctx("DROP TABLE |").expectTable);
assert("TRUNCATE TABLE -> expectTable", ctx("TRUNCATE TABLE |").expectTable);
eq("ALTER TABLE DROP COLUMN -> columns of table", [ctx("ALTER TABLE emp DROP COLUMN |").expectColumn, aliasMap(ctx("ALTER TABLE emp DROP COLUMN |"))], [true, { emp: "emp" }]);
assert("CREATE INDEX ON t( -> columns", ctx("CREATE INDEX i ON emp (|)").expectColumn);
assert("COMMENT ON COLUMN t. -> column", ctx("COMMENT ON COLUMN emp.|").expectColumn);
assert("CREATE SYNONYM … FOR -> table", ctx("CREATE SYNONYM s FOR |").expectTable);
assert("EXPLAIN PLAN FOR -> SELECT offered", ctx("EXPLAIN PLAN FOR |").keywords.includes("SELECT"));
assert("DESC (SQL*Plus) -> table", ctx("DESC |").expectTable);

section("PL/SQL");
{
  const c = ctx("BEGIN |");
  assert("block statement -> expectProcedure", c.expectProcedure);
  assert("block statement offers IF / LOOP / NULL", ["IF", "LOOP", "NULL"].every((k) => c.keywords.includes(k)));
  eq("statement kind", c.statementKind, "plsql");
}
{
  const c = ctx("DECLARE v NUMBER; c CONSTANT VARCHAR2(10) := 'x'; BEGIN v := |; END;");
  assert("assignment RHS -> expression", c.expectColumn && c.expectFunction);
  eq("declared variables", c.plsql.map((s) => [s.name, s.kind]), [["v", "variable"], ["c", "constant"]]);
}
assert("declaration type -> expectType", ctx("DECLARE v |").expectType);
assert("declaration offers CONSTANT", ctx("DECLARE v |").keywords.includes("CONSTANT"));
{
  const c = ctx("DECLARE v emp.|");
  assert("%TYPE anchor emp. -> columns", c.expectColumn);
  eq("%TYPE anchor qualifier", c.qualifier, ["emp"]);
}
eq("cursor FOR loop record columns", aliasMap(ctx("BEGIN FOR r IN (SELECT empno, ename FROM emp) LOOP x := r.|; END LOOP; END;")).r, "(subquery)[empno,ename]");
eq("cursor FOR loop over declared cursor", aliasMap(ctx("DECLARE CURSOR c IS SELECT id, name FROM t; BEGIN FOR r IN c LOOP x := r.|; END LOOP; END;")).r, "(cursor)[id,name]");
eq("%ROWTYPE record maps to its table", aliasMap(ctx("DECLARE r emp%ROWTYPE; BEGIN x := r.|; END;")).r, "emp");
{
  const c = ctx("CREATE OR REPLACE PROCEDURE p (p_id IN NUMBER, p_out OUT VARCHAR2) IS BEGIN |");
  eq("procedure parameters", c.plsql.map((s) => [s.name, s.kind]), [["p_id", "parameter"], ["p_out", "parameter"]]);
}
{
  const c = ctx("CREATE OR REPLACE TRIGGER t BEFORE INSERT ON emp FOR EACH ROW BEGIN :new.| END;");
  eq(":new. qualifier", c.qualifier, [":new"]);
  eq(":NEW / :OLD map to the trigger table", [aliasMap(c)[":NEW"], aliasMap(c)[":OLD"]], ["emp", "emp"]);
}
assert("SELECT … INTO -> expectVariable", ctx("DECLARE v NUMBER; BEGIN SELECT sal INTO | FROM emp; END;").expectVariable);
assert("EXCEPTION WHEN -> OTHERS", ctx("BEGIN NULL; EXCEPTION WHEN |").keywords.includes("OTHERS"));
assert("package member call dbms_output. -> qualifier", ctx("BEGIN dbms_output.|").qualifier[0] === "dbms_output");

section("validation");
eq("valid SQL has no errors", validateGrammar("SELECT a, b FROM t WHERE a = 1 ORDER BY b"), []);
eq("valid Oracle-specific SQL",
  validateGrammar("SELECT e.ename, LEVEL, q'[a;b]', ROWNUM FROM emp@prod e WHERE e.mgr(+) = 1 START WITH mgr IS NULL CONNECT BY PRIOR empno = mgr FETCH FIRST 5 ROWS ONLY"),
  []);
eq("first error only, in document coordinates", validateGrammar("SELECT 1 FROM dual;\n  SELECT FROM t WHERE;").map((e) => [e.line, e.column]), [[2, 10]]);
eq("incomplete statement", validateGrammar("SELECT * FROM emp WHERE").map((e) => e.message), ["Incomplete statement"]);
eq("PL/SQL is skipped in sql mode", validateGrammar("BEGIN x := ; END;\n/"), []);
eq("PL/SQL is checked in all mode", validateGrammar("BEGIN x := ; END;\n/", "all").length, 1);
eq("valid PL/SQL block in all mode",
  validateGrammar("DECLARE v NUMBER := 0; BEGIN FOR i IN 1..10 LOOP v := v + i; END LOOP; dbms_output.put_line(v); EXCEPTION WHEN OTHERS THEN NULL; END;\n/", "all"),
  []);
eq("SQL*Plus commands are not validated", validateGrammar("SET SERVEROUTPUT ON\nEXEC p;"), []);

section("performance");
{
  const big = "SELECT " + Array.from({ length: 300 }, (_, i) => `t.c${i}`).join(", ") + " FROM t WHERE ";
  const t0 = performance.now();
  ctx(big + "|");
  const ms = performance.now() - t0;
  console.log(`  (600-token statement: ${ms.toFixed(1)} ms)`);
  assert("large statement under 200 ms", ms < 200);
}

section("targetVersion gating");
{
  assert("23ai: CREATE TABLE offers IF (NOT EXISTS)", ctx("CREATE TABLE |", "23ai").keywords.includes("IF"));
  assert("19c: CREATE TABLE hides IF", !ctx("CREATE TABLE |", "19c").keywords.includes("IF"));
  assert("19c: DROP TABLE hides IF (EXISTS)", !ctx("DROP TABLE |", "19c").keywords.includes("IF"));
  assert("no version: everything the grammar knows", ctx("DROP TABLE |").keywords.includes("IF"));
  assert("19c: PL/SQL IF statement kept", ctx("BEGIN\n  |\nEND;", "19c").keywords.includes("IF"));
}
{
  const warn = (sql: string, version: OracleVersion = "19c") => validateGrammar(sql, "all", version).map((e) => `${e.severity}:${e.message}`);
  eq("19c: CREATE TABLE IF NOT EXISTS", warn("CREATE TABLE IF NOT EXISTS t (a NUMBER)"), ["warning:IF NOT EXISTS requires Oracle 23ai (target: 19c)"]);
  eq("19c: DROP TABLE IF EXISTS", warn("DROP TABLE IF EXISTS t"), ["warning:IF EXISTS requires Oracle 23ai (target: 19c)"]);
  eq("23ai: no warning", warn("DROP TABLE IF EXISTS t", "23ai"), []);
  eq("21c: still a warning", warn("DROP TABLE IF EXISTS t", "21c").length, 1);
  eq("19c: SELECT without FROM", warn("SELECT 1"), ["warning:SELECT without FROM requires Oracle 23ai (target: 19c); use FROM dual"]);
  eq("19c: SELECT … FROM dual is fine", warn("SELECT 1 FROM dual"), []);
  eq("19c: subquery without FROM", warn("SELECT * FROM t WHERE a IN (SELECT 1)").length, 1);
  eq("19c: SQL BOOLEAN column", warn("CREATE TABLE t (flag BOOLEAN)"), ["warning:The SQL BOOLEAN type requires Oracle 23ai (target: 19c)"]);
  eq("19c: SQL TRUE literal", warn("SELECT * FROM t WHERE flag = TRUE"), ["warning:SQL boolean literals requires Oracle 23ai (target: 19c)"]);
  eq("19c: PL/SQL BOOLEAN / TRUE are fine", warn("DECLARE b BOOLEAN := TRUE; BEGIN NULL; END;"), []);
  eq("no version: no warnings", validateGrammar("DROP TABLE IF EXISTS t", "sql"), []);
  const [w] = validateGrammar("SELECT 1 FROM dual;\n  DROP TABLE IF EXISTS t", "sql", "19c");
  eq("warning located in the document", [w.line, w.column, w.endColumn], [2, 14, 23]);
  eq("syntax errors still win over version warnings", validateGrammar("DROP TABLE IF EXISTS", "sql", "19c").map((e) => e.severity ?? "error"), ["error"]);
}

done();
