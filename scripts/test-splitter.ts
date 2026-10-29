/* Node test for the statement splitter and variable helpers. Run: npx tsx scripts/test-splitter.ts */
import { splitStatements, statementAt, toExecutable } from "../src/oracle/splitter.js";
import {
  findBindVariables,
  findSubstitutionVariables,
  parseDefine,
  resolveSubstitutions,
} from "../src/oracle/variables.js";
import { done, eq, section } from "./harness.js";

const split = (sql: string) => splitStatements(sql).map((s) => [s.kind, s.text, s.terminator]);

section("SQL");
eq("two statements on ;", split("select 1 from dual; select 2 from dual;"), [
  ["sql", "select 1 from dual", ";"],
  ["sql", "select 2 from dual", ";"],
]);
eq("last statement without terminator", split("select 1 from dual;\nselect 2 from dual"), [
  ["sql", "select 1 from dual", ";"],
  ["sql", "select 2 from dual", "eof"],
]);
eq("/ line ends SQL", split("select 1 from dual\n/\nselect 2 from dual"), [
  ["sql", "select 1 from dual", "/"],
  ["sql", "select 2 from dual", "eof"],
]);
eq("; inside strings / q-quotes / comments / quoted ids does not split",
  split("select 'a;b', q'[c;d]', \"e;f\" from t -- g;h\n/* i;j */ where 1 = 1;"),
  [["sql", "select 'a;b', q'[c;d]', \"e;f\" from t -- g;h\n/* i;j */ where 1 = 1", ";"]]);
eq("division is not a terminator", split("select a\n/ b from t;"), [["sql", "select a\n/ b from t", ";"]]);
eq("stray ; and empty / are ignored", split(";\n/\nselect 1 from dual;"), [["sql", "select 1 from dual", ";"]]);
eq("CREATE TABLE stays SQL", split("create table t (a number);"), [["sql", "create table t (a number)", ";"]]);
eq("SET TRANSACTION is SQL", split("set transaction read only;"), [["sql", "set transaction read only", ";"]]);

section("PL/SQL");
eq("anonymous block ends at /", split("begin\n  x := 1;\n  y := 2;\nend;\n/\nselect 1 from dual;"), [
  ["plsql", "begin\n  x := 1;\n  y := 2;\nend;", "/"],
  ["sql", "select 1 from dual", ";"],
]);
eq("DECLARE block", split("declare v number; begin null; end;\n/")[0].slice(0, 1), ["plsql"]);
eq("label before DECLARE", split("<<outer>> declare v number; begin null; end;\n/")[0][0], "plsql");
eq("CREATE OR REPLACE EDITIONABLE PACKAGE BODY",
  split("create or replace editionable package body p as\n procedure a is begin null; end;\nend p;\n/")[0][0], "plsql");
eq("CREATE TRIGGER", split("create trigger trg before insert on t for each row begin :new.id := 1; end;\n/")[0][0], "plsql");
eq("CREATE TYPE needs /", split("create type t as object (a number);\n/")[0], ["plsql", "create type t as object (a number);", "/"]);
eq("WITH FUNCTION (12c inline)", split("with function f return number is begin return 1; end;\nselect f from dual\n/")[0][0], "plsql");
eq("PL/SQL without / runs to EOF", split("begin null; end;")[0], ["plsql", "begin null; end;", "eof"]);

section("SQL*Plus commands");
{
  const s = splitStatements("set serveroutput on\nexec dbms_output.put_line('hi');\n@setup.sql\ndefine x = 10\nselect &x from dual;");
  eq("kinds", s.map((x) => x.kind), ["sqlplus", "sqlplus", "sqlplus", "sqlplus", "sql"]);
  eq("commands", s.slice(0, 4).map((x) => [x.command?.name, x.command?.args]), [
    ["SET", "serveroutput on"],
    ["EXEC", "dbms_output.put_line('hi')"],
    ["@", "setup.sql"],
    ["DEFINE", "x = 10"],
  ]);
  eq("EXEC becomes an anonymous block", toExecutable(s[1]), "BEGIN dbms_output.put_line('hi'); END;");
  eq("SET is not sent to the database", toExecutable(s[0]), undefined);
  eq("SQL is sent as-is", toExecutable(s[4]), "select &x from dual");
}
eq("comment before a command is its own empty chunk",
  splitStatements("-- setup\nset echo on").map((x) => x.kind), ["empty", "sqlplus"]);
eq("abbreviations", splitStatements("desc hr.emp\nsho errors\npro hello").map((x) => x.command?.name), ["DESC", "SHOW", "PROMPT"]);

section("blank-line separation (opt-in)");
eq("off by default", splitStatements("select 1 from dual\n\nselect 2 from dual").length, 1);
eq("on: splits SQL", splitStatements("select 1 from dual\n\nselect 2 from dual", { blankLineSeparates: true })
  .map((x) => [x.text, x.terminator]), [["select 1 from dual", "blank"], ["select 2 from dual", "eof"]]);
eq("on: never splits PL/SQL", splitStatements("begin\n  null;\n\n  null;\nend;", { blankLineSeparates: true }).length, 1);

section("positions");
{
  const sql = "-- head\nselect 1\nfrom dual;\n\nbegin\n  null;\nend;\n/\n";
  const s = splitStatements(sql);
  eq("lines", s.map((x) => [x.startLine, x.endLine]), [[1, 3], [5, 8]]);
  eq("leading comment belongs to the statement", s[0].text.startsWith("-- head"), true);
  eq("offsets cover the terminator", sql.slice(s[0].startOffset, s[0].endOffset), "-- head\nselect 1\nfrom dual;");
  eq("statementAt inside", statementAt(sql, sql.indexOf("dual"))?.startLine, 1);
  eq("statementAt after ; on same line", statementAt(sql, sql.indexOf(";") + 1)?.startLine, 1);
  eq("statementAt in PL/SQL", statementAt(sql, sql.indexOf("null"))?.kind, "plsql");
  eq("statementAt on blank line", statementAt(sql, sql.indexOf("\n\n") + 1), undefined);
}

section("substitution variables");
{
  eq("find & and &&", findSubstitutionVariables("select &a, &&b. from t where c = '&c' -- &d").map((r) => [r.name, r.define]),
    [["A", false], ["B", true], ["C", false]]);
  const vars = new Map<string, string>([["A", "1"]]);
  const asked: string[] = [];
  const out = await resolveSubstitutions("select &a, &&b, &b, &tab._x from dual", vars, (n) => {
    asked.push(n);
    return n === "B" ? "2" : "emp";
  });
  eq("resolved text", out, "select 1, 2, 2, emp_x from dual");
  eq("prompted once per name", asked, ["B", "TAB"]);
  eq("&& stored the value", vars.get("B"), "2");
  eq("& did not store the value", vars.has("TAB"), false);
  let threw = false;
  try { await resolveSubstitutions("select &z from dual", new Map()); } catch { threw = true; }
  eq("missing value without prompt throws", threw, true);
  eq("parseDefine x = 1", parseDefine("x = 1"), { name: "X", value: "1" });
  eq("parseDefine quoted", parseDefine("who = 'O''Brien'"), { name: "WHO", value: "O'Brien" });
  eq("parseDefine name only", parseDefine("x"), { name: "X" });
}

section("bind variables");
eq("names in order, de-duplicated", findBindVariables("select :a, :b, :a, :1 from t where x := 1"), ["A", "B", "1"]);
eq("not in strings / comments", findBindVariables("select ':x' from t -- :y\n/* :z */"), []);
eq(":new. / :old. are not binds", findBindVariables("begin :new.id := :old.id + :step; end;"), ["STEP"]);

done();
