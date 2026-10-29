/* Node test for the formatter. Run: npx tsx scripts/test-format.ts */
import { formatOracleSql } from "../src/oracle/format.js";
import { done, eq, section } from "./harness.js";

const fmt = (s: string) => formatOracleSql(s) as string;

section("clauses");
eq("breaks major clauses", fmt("select a, b from t where x = 1 order by a"),
  "SELECT a, b\nFROM t\nWHERE x = 1\nORDER BY a");
eq("multi-word clauses", fmt("select a from t left outer join u on t.id = u.id group by a"),
  "SELECT a\nFROM t\nLEFT OUTER JOIN u on t.id = u.id\nGROUP BY a");
eq("hierarchical query", fmt("select ename from emp start with mgr is null connect by prior empno = mgr"),
  "SELECT ename\nFROM emp\nSTART WITH mgr is null\nCONNECT BY prior empno = mgr");
eq("MINUS + FETCH FIRST", fmt("select a from t minus select a from u fetch first 5 rows only"),
  "SELECT a\nFROM t\nMINUS\nSELECT a\nFROM u\nFETCH FIRST 5 rows only");
eq("DELETE FROM stays together", fmt("delete from t where a = 1"), "delete from t\nWHERE a = 1");

section("no breaks inside calls");
eq("EXTRACT(YEAR FROM d)", fmt("select extract(year from d) from t"),
  "SELECT extract(year from d)\nFROM t");
eq("OVER (ORDER BY …)", fmt("select row_number() over (order by a) rn from t"),
  "SELECT row_number() over (order by a) rn\nFROM t");
eq("subquery breaks inside its parens", fmt("select * from (select a from t where b = 1) x"),
  "SELECT *\nFROM (SELECT a\nFROM t\nWHERE b = 1) x");
eq("t.from column is not a clause", fmt("select t.from from t"), "SELECT t.from\nFROM t");

section("literals and comments are verbatim");
eq("keywords in strings untouched", fmt("select 'a  from   b' from t"), "SELECT 'a  from   b'\nFROM t");
eq("q-quote untouched", fmt("select q'[it's  from]' from dual"), "SELECT q'[it's  from]'\nFROM dual");
eq("line comment keeps its line break", fmt("-- header\nselect 1 from dual"), "-- header\nSELECT 1\nFROM dual");
eq("trailing line comment", fmt("select a -- note\nfrom t"), "SELECT a -- note\nFROM t");
eq("hint preserved", fmt("select /*+ full(t) */ a from t"), "SELECT /*+ full(t) */ a\nFROM t");
eq("multi-line string preserved", fmt("select 'a  \n  b' from t"), "SELECT 'a  \n  b'\nFROM t");

section("statements and terminators");
eq("one statement per line", fmt("select 1 from dual; select 2 from dual;"),
  "SELECT 1\nFROM dual;\nSELECT 2\nFROM dual;");
eq("slash terminator line preserved", fmt("begin\n  null;\nend;\n/\nselect 1 from dual"),
  "BEGIN\n  null;\nEND;\n/\nSELECT 1\nFROM dual");
eq("division is not a terminator", fmt("select a\n/ b from t"), "SELECT a / b\nFROM t");
eq("blank line between statements kept", fmt("select 1 from dual;\n\nselect 2 from dual;"),
  "SELECT 1\nFROM dual;\n\nSELECT 2\nFROM dual;");
eq("comment after ; stays on its line", fmt("select 1 from dual; -- one\nselect 2 from dual;"),
  "SELECT 1\nFROM dual; -- one\nSELECT 2\nFROM dual;");
eq("SQL*Plus command verbatim", fmt("set   serveroutput on\nselect 1 from dual;"),
  "set   serveroutput on\nSELECT 1\nFROM dual;");
eq("; after a trailing line comment moves to its own line", fmt("select 1 from dual -- c\n;"),
  "SELECT 1\nFROM dual -- c\n;");
eq("blank input unchanged", fmt("   "), "   ");
eq("idempotent", fmt(fmt("select a from t where b = 1")), fmt("select a from t where b = 1"));

section("PL/SQL indentation");
eq("anonymous block with IF / ELSIF / ELSE",
  fmt("declare v number := 0; begin if v > 0 then v := 1; elsif v < 0 then v := 2; else v := 3; end if; end;\n/"),
  [
    "DECLARE",
    "  v number := 0;",
    "BEGIN",
    "  IF v > 0 THEN",
    "    v := 1;",
    "  ELSIF v < 0 THEN",
    "    v := 2;",
    "  ELSE",
    "    v := 3;",
    "  END IF;",
    "END;",
    "/",
  ].join("\n"));
eq("procedure with cursor loop, embedded SELECT and exception handlers",
  fmt("create or replace procedure p(a in number) is cursor c is select x from t; begin for r in c loop select y into v from u where id = r.x; end loop; exception when no_data_found then null; when others then raise; end p;\n/"),
  [
    "create or replace procedure p(a in number) IS",
    "  cursor c is",
    "  SELECT x",
    "  FROM t;",
    "BEGIN",
    "  for r in c LOOP",
    "    SELECT y into v",
    "    FROM u",
    "    WHERE id = r.x;",
    "  END LOOP;",
    "EXCEPTION",
    "  WHEN no_data_found THEN",
    "    null;",
    "  WHEN others THEN",
    "    raise;",
    "END p;",
    "/",
  ].join("\n"));
eq("package body with nested procedures",
  fmt("create package body pkg as procedure a is begin null; end a; function b return number is begin return 1; end b; end pkg;\n/"),
  [
    "create package body pkg AS",
    "  procedure a IS",
    "  BEGIN",
    "    null;",
    "  END a;",
    "  function b return number IS",
    "  BEGIN",
    "    return 1;",
    "  END b;",
    "END pkg;",
    "/",
  ].join("\n"));
eq("CASE statement vs CASE expression",
  fmt("begin x := case when a then 1 else 2 end; case y when 1 then null; else z := 0; end case; end;"),
  [
    "BEGIN",
    "  x := case when a then 1 else 2 END;",
    "  CASE y",
    "    WHEN 1 THEN",
    "      null;",
    "    ELSE",
    "      z := 0;",
    "  END CASE;",
    "END;",
  ].join("\n"));
eq("MERGE … WHEN MATCHED THEN inside a block stays inline",
  fmt("begin merge into t using s on (t.id = s.id) when matched then update set t.v = s.v; end;"),
  [
    "BEGIN",
    "  merge into t using s on (t.id = s.id)",
    "  WHEN MATCHED then update set t.v = s.v;",
    "END;",
  ].join("\n"));
eq("type spec AS is not a block", fmt("create type t as object (a number);\n/"), "create type t as object (a number);\n/");
eq("e EXCEPTION declaration is not a section",
  fmt("declare e exception; begin raise e; end;"),
  "DECLARE\n  e exception;\nBEGIN\n  raise e;\nEND;");
{
  const src = "declare v number; begin for i in 1..3 loop v := i; end loop; end;\n/";
  eq("PL/SQL formatting is idempotent", fmt(fmt(src)), fmt(src));
}

done();
