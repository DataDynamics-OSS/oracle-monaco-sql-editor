/* Node test for the built-in help (Shift+F1 / Ctrl+Click / hover). Run: npx tsx scripts/test-docs.ts */
import { allDocEntries, allDocPages, docFor, docUrl, functionDoc, renderDoc } from "../src/oracle/docs.js";
import { localizeDoc, localizeMessage, uiStrings, type OracleLocale } from "../src/oracle/i18n/index.js";
import { renderObjectInfo } from "../src/oracle/hover.js";
import { hoverInfo, type DescribeSource } from "../src/oracle/hover.js";
import { ORACLE_BUILTIN_PACKAGES, ORACLE_FUNCTIONS, ORACLE_PSEUDO_COLUMNS, ORACLE_TYPES, resolveLanguageElements } from "../src/oracle/keywords.js";
import { assert, done, eq, section } from "./harness.js";

const title = (w: string, ctx = {}) => docFor(w, ctx)?.title;

section("coverage");
{
  eq("every built-in function has help", ORACLE_FUNCTIONS.filter((f) => !functionDoc(f)), []);
  eq("every function help has a summary and syntax", ORACLE_FUNCTIONS.filter((f) => !functionDoc(f)?.summary || !functionDoc(f)?.syntax), []);
  eq("every supplied package has help", ORACLE_BUILTIN_PACKAGES.filter((p) => docFor(p)?.kind !== "package"), []);
  eq("every pseudo-column has help", ORACLE_PSEUDO_COLUMNS.filter((p) => !docFor(p)), []);
  // ROWID resolves to its pseudo-column entry (which covers the type too).
  eq("every built-in type has help", ORACLE_TYPES.filter((t) => t !== "ROWID" && docFor(t)?.kind !== "type"), []);
  assert("every entry links to a manual page", allDocPages().every((p) => /^(sqlrf|lnpls|arpls)\/[\w-]+$/.test(p)));
}

section("functions");
{
  eq("call → function", title("nvl", { call: true }), "NVL");
  eq("OR REPLACE is not REPLACE()", docFor("REPLACE", { next: ["PROCEDURE"] }), undefined);
  eq("REPLACE( is the function", title("replace", { call: true }), "REPLACE");
  eq("no-paren function without (", title("current_date"), "CURRENT_DATE");
  eq("ROUND links the number page", functionDoc("ROUND")?.page, "sqlrf/ROUND-number");
  eq("TRIM has its own syntax", functionDoc("TRIM")?.syntax, "TRIM([[LEADING | TRAILING | BOTH] [trim_char] FROM] source)");
  eq("syntax from the signature table", functionDoc("SUBSTR")?.syntax, "SUBSTR(char VARCHAR2, position NUMBER, [length NUMBER]) RETURN VARCHAR2");
  eq("REGEXP_LIKE → pattern matching conditions", functionDoc("REGEXP_LIKE")?.page, "sqlrf/Pattern-matching-Conditions");
  eq("SUBSTRB shares SUBSTR's page", functionDoc("SUBSTRB")?.page, "sqlrf/SUBSTR");
}

section("keywords in context");
{
  eq("CONNECT → CONNECT BY", title("connect", { next: ["BY", "PRIOR"] }), "CONNECT BY (hierarchical query)");
  eq("PRIOR → CONNECT BY", title("PRIOR"), "CONNECT BY (hierarchical query)");
  eq("CREATE TABLE", title("CREATE", { next: ["TABLE", "T"] }), "CREATE TABLE");
  eq("CREATE OR REPLACE PACKAGE BODY", title("CREATE", { next: ["OR", "REPLACE", "PACKAGE", "BODY"] }), "CREATE PACKAGE BODY");
  eq("CREATE OR REPLACE EDITIONABLE PROCEDURE", title("CREATE", { next: ["OR", "REPLACE", "EDITIONABLE", "PROCEDURE"] }), "CREATE PROCEDURE");
  eq("CREATE GLOBAL TEMPORARY TABLE", title("CREATE", { next: ["GLOBAL", "TEMPORARY", "TABLE"] }), "CREATE TABLE");
  eq("CREATE MATERIALIZED VIEW", title("CREATE", { next: ["MATERIALIZED", "VIEW"] }), "CREATE MATERIALIZED VIEW");
  eq("ALTER SESSION", title("ALTER", { next: ["SESSION", "SET"] }), "ALTER SESSION");
  eq("DROP SEQUENCE", title("DROP", { next: ["SEQUENCE"] }), "DROP SEQUENCE");
  eq("unknown CREATE target", docFor("CREATE", { next: ["TABLESPACE"] }), undefined);
  eq("FETCH FIRST in SQL", title("FETCH", { next: ["FIRST", "10"] }), "OFFSET / FETCH (row limiting)");
  eq("FETCH c INTO in PL/SQL", title("FETCH", { next: ["C", "INTO"], plsql: true }), "FETCH (PL/SQL)");
  eq("FOR UPDATE in SQL", title("FOR", { next: ["UPDATE"] }), "FOR UPDATE");
  eq("FOR loop in PL/SQL", title("FOR", { next: ["I", "IN"], plsql: true }), "FOR LOOP");
  eq("IF in PL/SQL", title("IF", { plsql: true }), "IF");
  eq("IF NOT EXISTS in SQL", title("IF", { next: ["NOT", "EXISTS"] }), "CREATE TABLE");
  eq("END IF", title("END", { next: ["IF", ";"], plsql: true }), "IF");
  eq("END LOOP", title("END", { next: ["LOOP"], plsql: true }), "LOOP");
  eq("NULL; statement", title("NULL", { next: [";"], plsql: true }), "NULL statement");
  eq("NULL value", title("NULL", { next: ["THEN"], plsql: true }), "NULL");
  eq("IS NULL", title("IS", { next: ["NOT", "NULL"] }), "IS [NOT] NULL");
  eq("%TYPE", title("TYPE", { afterPercent: true }), "%TYPE");
  eq("%ROWTYPE", title("rowtype", { afterPercent: true }), "%ROWTYPE");
  eq("INTO in PL/SQL → SELECT INTO", title("INTO", { plsql: true }), "SELECT INTO");
  eq("PRAGMA AUTONOMOUS_TRANSACTION", title("PRAGMA", { next: ["AUTONOMOUS_TRANSACTION"] }), "PRAGMA AUTONOMOUS_TRANSACTION");
  eq("WITH TIME ZONE is not a CTE", docFor("WITH", { next: ["TIME", "ZONE"] }), undefined);
  eq("ON COMMIT is not a join", docFor("ON", { next: ["COMMIT"] }), undefined);
  eq("JSON type is 21c+", docFor("JSON")?.since, "21c");
  eq("pseudo-column", docFor("ROWNUM")?.kind, "pseudo-column");
  eq("NATURAL JOIN", title("NATURAL", { next: ["JOIN", "T2"] }), "JOIN");
  eq("NATURAL subtype", docFor("NATURAL", { next: [";"], plsql: true })?.kind, "type");
  eq("unknown word", docFor("EMPLOYEES"), undefined);
}

section("links");
{
  eq("19c", docUrl("sqlrf/NVL"), "https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/NVL.html");
  eq("23ai", docUrl("sqlrf/NVL", "23ai"), "https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/NVL.html");
  const md = renderDoc(functionDoc("NVL")!, "21c");
  assert("markdown: heading, syntax, example, link", md.startsWith("**NVL** — function") && md.includes("```oracle\nNVL(") && md.includes("Example:") && md.includes("/21/sqlrf/NVL.html"), md);
}

section("hover uses the help");
{
  const elements = resolveLanguageElements();
  const described: string[][] = [];
  const describe: DescribeSource = (t) => {
    described.push(t.parts);
    return t.parts[0].toUpperCase() === "SALARY" ? { kind: "column", name: "SALARY", dataType: "NUMBER" } : undefined;
  };
  const at = (text: string, word: string, nth = 0, version?: "23ai") => {
    let idx = -1;
    for (let i = 0; i <= nth; i++) idx = text.indexOf(word, idx + 1);
    const before = text.slice(0, idx + 1);
    const line = before.split("\n").length;
    const lineText = text.split("\n")[line - 1];
    const column = idx + 1 - (before.lastIndexOf("\n") + 1) + 1;
    return hoverInfo(text, lineText, { line, column }, idx + 1, { elements, describe: () => describe, version: () => version });
  };

  described.length = 0;
  const h = await at("SELECT * FROM emp CONNECT BY PRIOR id = mgr", "CONNECT");
  assert("keyword help", !!h?.markdown.startsWith("**CONNECT BY (hierarchical query)**"), h);
  eq("keywords never hit the dictionary", described.length, 0);
  assert("function call help with example", !!(await at("SELECT nvl(a, 0) FROM t", "nvl"))?.markdown.includes("Example:"));
  assert("PL/SQL detected from the statement (FOR loop)", !!(await at("BEGIN\n  FOR i IN 1 .. 3 LOOP NULL; END LOOP;\nEND;\n/", "FOR"))?.markdown.startsWith("**FOR LOOP**"));
  assert("SQL FOR UPDATE", !!(await at("SELECT * FROM t FOR UPDATE", "FOR"))?.markdown.startsWith("**FOR UPDATE**"));
  eq("column still from the dictionary", (await at("SELECT salary FROM t", "salary"))?.markdown, "`SALARY NUMBER` — column");
  eq("OR REPLACE: no help", await at("CREATE OR REPLACE VIEW v AS SELECT 1 FROM dual", "REPLACE"), undefined);
  assert("%TYPE", !!(await at("DECLARE v t.c%TYPE; BEGIN NULL; END;", "TYPE"))?.markdown.startsWith("**%TYPE**"));
  assert("link follows targetVersion", !!(await at("SELECT 1 FROM dual", "SELECT", 0, "23ai"))?.markdown.includes("/26/sqlrf/SELECT.html"));
  assert("type help", !!(await at("CREATE TABLE t (a VARCHAR2(10))", "VARCHAR2"))?.markdown.startsWith("**VARCHAR2** — data type"));
}

section("languages");
{
  const entries = allDocEntries();
  const ticks = (t: string) => (t.match(/`[^`]*`/g) ?? []).sort().join("|");
  for (const locale of ["ko", "ja", "zh"] as OracleLocale[]) {
    const untranslated = entries.filter((e) => localizeDoc(e, locale).summary === e.summary).map((e) => e.id);
    eq(`${locale}: every summary translated`, untranslated, []);
    const changedCode = entries.filter((e) => ticks(localizeDoc(e, locale).summary) !== ticks(e.summary)).map((e) => e.id);
    eq(`${locale}: code spans kept`, changedCode, []);
    const s = uiStrings(locale);
    eq(`${locale}: every action labelled`, Object.values(s.actions).filter((v) => !v || /^[A-Z][a-z]/.test(v)), []);
  }
  const ko = renderDoc(functionDoc("NVL")!, "19c", "ko");
  assert("ko help: heading kind, example label, link label", ko.startsWith("**NVL** — 함수") && ko.includes("예제:") && ko.includes("[Oracle 19c 매뉴얼 ↗]") && ko.includes("```oracle\nNVL("), ko);
  assert("ja topic title", renderDoc(docFor("CONNECT", { next: ["BY"] })!, "19c", "ja").startsWith("**CONNECT BY ("));
  assert("zh topic title translated", !renderDoc(docFor("CONNECT", { next: ["BY"] })!, "19c", "zh").includes("hierarchical"));
  eq("en unchanged", renderDoc(functionDoc("NVL")!, "19c", "en"), renderDoc(functionDoc("NVL")!));
  eq("ko object info", renderObjectInfo({ kind: "column", name: "SALARY", dataType: "NUMBER", parent: "HR.EMPLOYEES" }, 30, "ko"), "`SALARY NUMBER` — `HR.EMPLOYEES` 의 컬럼");
  eq("ja table header", renderObjectInfo({ kind: "table", name: "T", columns: [{ name: "A", type: "NUMBER", nullable: true }] }, 30, "ja").split("\n\n")[1].split("\n")[0], "| 列 | 型 |");
  eq("message: incomplete (ko)", localizeMessage("Incomplete statement", "ko"), "문장이 완성되지 않았습니다");
  eq("message: expected (ja)", localizeMessage("Syntax error at 'FORM': expected FROM", "ja"), "'FORM' で構文エラー: FROM が必要です");
  eq("message: 23ai (zh)", localizeMessage("IF NOT EXISTS requires Oracle 23ai (target: 19c)", "zh"), "IF NOT EXISTS 需要 Oracle 23ai 或更高版本（目标：19c）");
  eq("message: no FROM (ko)", localizeMessage("SELECT without FROM requires Oracle 23ai (target: 21c); use FROM dual", "ko"), "FROM 없는 SELECT 는 Oracle 23ai 이상에서만 지원됩니다 (대상: 21c). FROM dual 을 사용하세요");
  eq("message: unknown passes through", localizeMessage("something else", "ko"), "something else");
}

done();
