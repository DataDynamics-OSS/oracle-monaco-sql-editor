/* Node test for signature help, hover and server validation (Phase 4). Run: npx tsx scripts/test-signature.ts */
import {
  activeSignature,
  BUILTIN_SIGNATURES,
  builtinSignatures,
  callAt,
  namedParameterCandidates,
  signatureLabel,
  type CallSite,
} from "../src/oracle/signatures.js";
import { hoverInfo, nameAtColumn, renderObjectInfo, type DescribeSource } from "../src/oracle/hover.js";
import { createServerValidator, isServerValidatable } from "../src/oracle/serverValidate.js";
import { createOracleMetadataProvider } from "../src/oracle/metadata.js";
import { createMockTransport } from "../src/oracle/transport/mock.js";
import { splitStatements } from "../src/oracle/splitter.js";
import { resolveLanguageElements } from "../src/oracle/keywords.js";
import { createModelRouter } from "../src/core/completionRouter.js";
import type { ExecuteRequest } from "../src/oracle/transport/types.js";
import { assert, done, eq, section } from "./harness.js";

/** Call site for `sql` with the caret marked by `|`. */
function call(sql: string): CallSite | undefined {
  const idx = sql.indexOf("|");
  return callAt(sql.slice(0, idx) + sql.slice(idx + 1), idx);
}

section("callAt");
{
  const c = call("SELECT nvl(a, |");
  eq("name", c?.parts, ["nvl"]);
  eq("second argument", c?.argIndex, 1);
  assert("at argument start", !!c?.atArgStart);
}
eq("first argument", call("SELECT substr(|")?.argIndex, 0);
eq("nested call: innermost", call("SELECT nvl(substr(x, 1, |), 0)")?.parts, ["substr"]);
eq("nested call: arg index", call("SELECT nvl(substr(x, 1, |), 0)")?.argIndex, 2);
eq("after inner call closes", call("SELECT nvl(substr(x, 1, 2), |")?.parts, ["nvl"]);
eq("commas in strings ignored", call("SELECT replace('a,b,c', |")?.argIndex, 1);
eq("parens in comments ignored", call("SELECT nvl( /* ) , */ x, |")?.argIndex, 1);
eq("qualified name", call("BEGIN hr.emp_pkg.raise_salary(|")?.parts, ["hr", "emp_pkg", "raise_salary"]);
eq("quoted part", call('BEGIN "Pkg".run(|')?.quoted, [true, false]);
eq("db link", call("BEGIN p@prod(|")?.dbLink, "PROD");
{
  const c = call("BEGIN pkg.p(p_id => 1, p_name => 'x', |");
  eq("named args seen", c?.namedArgs, ["P_ID", "P_NAME"]);
  eq("arg index with named", c?.argIndex, 2);
  const d = call("BEGIN pkg.p(p_id => |");
  eq("current named", d?.currentNamed, "P_ID");
  assert("not at arg start after =>", !d?.atArgStart);
}
assert("partial word is still an argument start", !!call("BEGIN pkg.p(p_|")?.atArgStart);
assert("expression is not an argument start", !call("SELECT nvl(a + |")?.atArgStart);
eq("IN list is not a call", call("SELECT * FROM t WHERE x IN (1, |"), undefined);
eq("VALUES is not a call", call("INSERT INTO t VALUES (1, |"), undefined);
eq("INSERT column list is not a call", call("INSERT INTO t (a, |"), undefined);
eq("CREATE TABLE is not a call", call("CREATE TABLE t (a NUMBER, |"), undefined);
eq("procedure declaration is not a call", call("CREATE PROCEDURE p (|"), undefined);
eq("CAST target type is not a call", call("SELECT CAST(x AS VARCHAR2(|"), undefined);
eq("JOIN ... ON nvl( is a call", call("SELECT * FROM a JOIN b ON nvl(|")?.parts, ["nvl"]);
eq("previous statement ignored", call("SELECT nvl(a, b) FROM t; SELECT |"), undefined);
eq("outside parens", call("SELECT nvl(a, b) |"), undefined);

section("built-in signatures");
{
  const [sub] = builtinSignatures({ parts: ["substr"], quoted: [false] });
  eq("SUBSTR parameters", sub.parameters.map((p) => p.name), ["char", "position", "length"]);
  eq("SUBSTR optional length", sub.parameters[2].optional, true);
  const { label, parameters } = signatureLabel(sub);
  eq("label", label, "SUBSTR(char VARCHAR2, position NUMBER, [length NUMBER]) RETURN VARCHAR2");
  eq("parameter range points at the text", label.slice(...parameters[1]), "position NUMBER");
  eq("quoted name is not a built-in", builtinSignatures({ parts: ["substr"], quoted: [true] }), []);
  eq("qualified name is not a built-in", builtinSignatures({ parts: ["x", "substr"], quoted: [false, false] }), []);
  const decode = BUILTIN_SIGNATURES.get("DECODE")![0];
  eq("DECODE repeats (search, result)", decode.repeat, [1, 2]);
  const at = (i: number) => activeSignature([decode], { ...call("SELECT decode(|")!, argIndex: i }).parameter;
  eq("DECODE args map onto search/result", [0, 1, 2, 3, 4, 5].map(at), [0, 1, 2, 1, 2, 1]);
  const coalesce = BUILTIN_SIGNATURES.get("COALESCE")![0];
  eq("COALESCE repeats its last", activeSignature([coalesce], { ...call("SELECT coalesce(|")!, argIndex: 5 }).parameter, 1);
  eq("every spec parsed", [...BUILTIN_SIGNATURES.values()].every((s) => s[0].name && s[0].kind === "function"), true);
}

section("overloads and named arguments");
{
  const sigs = [
    { name: "P", kind: "procedure" as const, parameters: [{ name: "P_ID", type: "NUMBER" }] },
    { name: "P", kind: "procedure" as const, parameters: [{ name: "P_NAME", type: "VARCHAR2" }, { name: "P_FLAG", type: "BOOLEAN", optional: true }] },
  ];
  eq("arity picks overload", activeSignature(sigs, call("BEGIN p(1, |")!), { signature: 1, parameter: 1 });
  eq("named arg picks overload", activeSignature(sigs, call("BEGIN p(p_name => |")!), { signature: 1, parameter: 0 });
  eq("named arg highlights its parameter", activeSignature(sigs, call("BEGIN p(p_name => 'x', p_flag => |")!), { signature: 1, parameter: 1 });
  eq("candidates: all unused", namedParameterCandidates(sigs, call("BEGIN p(|")!).map((p) => p.name), ["P_ID", "P_NAME", "P_FLAG"]);
  eq("candidates: minus used", namedParameterCandidates(sigs, call("BEGIN p(p_name => 'x', |")!).map((p) => p.name), ["P_ID", "P_FLAG"]);
  eq("candidates: positional consumes leading", namedParameterCandidates(sigs, call("BEGIN p('x', |")!).map((p) => p.name), ["P_FLAG"]);
}

// ---------------------------------------------------------------- dictionary

type B = Record<string, string>;
const binds = (r: ExecuteRequest) => (r.binds ?? {}) as B;

function dictionary() {
  const t = createMockTransport({ session: { currentSchema: "HR" } });
  const objects: Record<string, [string, string][]> = {
    HR: [["EMPLOYEES", "TABLE"], ["EMP_PKG", "PACKAGE"], ["EMP_SEQ", "SEQUENCE"], ["STAFF", "SYNONYM"], ["GET_BONUS", "FUNCTION"], ["REMOTE_EMP", "SYNONYM"], ["BAD_V", "VIEW"]],
    PUBLIC: [["DBMS_OUTPUT", "SYNONYM"]],
    SYS: [["DBMS_OUTPUT", "PACKAGE"]],
  };
  t.on(/FROM all_objects\s+WHERE owner = :owner AND object_name = :name\s+AND object_type IN/i, (req) => {
    const { owner, name } = binds(req);
    return { rows: (objects[owner] ?? []).filter(([n]) => n === name).map(([, ty]) => [ty]) };
  });
  t.on(/SELECT status FROM all_objects/i, (req) => ({ rows: [[binds(req).name === "BAD_V" ? "INVALID" : "VALID"]] }));
  t.on(/FROM all_synonyms WHERE owner = :owner AND synonym_name = :name/i, (req) => {
    const { owner, name } = binds(req);
    if (owner === "HR" && name === "STAFF") return { rows: [["HR", "EMPLOYEES", null]] };
    if (owner === "HR" && name === "REMOTE_EMP") return { rows: [["SCOTT", "EMP", "PROD"]] };
    if (owner === "PUBLIC" && name === "DBMS_OUTPUT") return { rows: [["SYS", "DBMS_OUTPUT", null]] };
    return { rows: [] };
  });
  t.on(/FROM all_tab_columns c/i, (req) =>
    binds(req).name === "EMPLOYEES"
      ? { rows: [["EMPLOYEE_ID", "NUMBER", 22, 6, 0, "N", 0, null, null], ["SALARY", "NUMBER", 22, 8, 2, "Y", 0, null, "Monthly salary"]] }
      : { rows: [] },
  );
  t.on(/_tab_columns@PROD/i, { rows: [["EMPNO", "NUMBER", 22, 4, 0, "N", 0, null, null]] });
  t.on(/FROM all_tab_comments/i, { rows: [["Employees of the company"]] });
  t.on(/FROM all_users WHERE username = :u/i, (req) => ({ rows: ["HR", "SCOTT", "SYS"].includes(binds(req).u) ? [[1]] : [] }));
  t.on(/FROM all_procedures/i, (req) =>
    binds(req).name === "DBMS_OUTPUT" ? { rows: [["NEW_LINE", "PROCEDURE"], ["PUT_LINE", "PROCEDURE"]] } : { rows: [["RAISE_SALARY", "PROCEDURE"], ["RESET", "PROCEDURE"]] },
  );
  // overload, position, argument_name, data_type, in_out, defaulted, pls_type, type_owner, type_name, type_subname
  t.on(/FROM all_arguments\s+WHERE owner/i, (req) => {
    const { owner, name, pkg } = binds(req);
    if (owner === "SYS" && pkg === "DBMS_OUTPUT" && name === "PUT_LINE") return { rows: [[null, 1, "A", "VARCHAR2", "IN", "N", "VARCHAR2", null, null, null]] };
    if (owner === "HR" && pkg === "EMP_PKG" && name === "RAISE_SALARY") {
      return {
        rows: [
          ["1", 1, "P_EMP_ID", "NUMBER", "IN", "N", "NUMBER", null, null, null],
          ["1", 2, "P_PCT", "NUMBER", "IN", "Y", "NUMBER", null, null, null],
          ["2", 1, "P_EMP", "PL/SQL RECORD", "IN", "N", null, "HR", "EMP_PKG", "EMP_REC"],
          ["2", 2, "P_NEW", "NUMBER", "IN/OUT", "N", "NUMBER", null, null, null],
        ],
      };
    }
    if (owner === "HR" && !pkg && name === "GET_BONUS") {
      return { rows: [[null, 0, null, "NUMBER", "OUT", "N", "NUMBER", null, null, null], [null, 1, "P_ID", "NUMBER", "IN", "N", "NUMBER", null, null, null]] };
    }
    return { rows: [] };
  });
  t.on(/FROM all_sequences/i, { rows: [[1, "9999999999", 1, "N", 20, 207]] });
  return { t, meta: createOracleMetadataProvider({ transport: t, dbLinkMetadata: true }) };
}

const site = (parts: string[]): CallSite => ({ parts, quoted: parts.map(() => false), argIndex: 0, namedArgs: [], atArgStart: true, openOffset: 0 });

section("metadata.signatures (ALL_ARGUMENTS)");
{
  const { t, meta } = dictionary();
  const put = await meta.signatures(site(["dbms_output", "put_line"]));
  eq("public synonym → SYS.DBMS_OUTPUT.PUT_LINE", put.map((s) => signatureLabel(s).label), ["DBMS_OUTPUT.PUT_LINE(A VARCHAR2)"]);
  const argCall = t.calls.find((c) => /all_arguments/.test(c.sql))!;
  eq("bound owner / package / name", binds(argCall), { owner: "SYS", name: "PUT_LINE", pkg: "DBMS_OUTPUT" });

  const raise = await meta.signatures(site(["emp_pkg", "raise_salary"]));
  eq("two overloads", raise.length, 2);
  eq("overload 1", signatureLabel(raise[0]).label, "EMP_PKG.RAISE_SALARY(P_EMP_ID NUMBER, [P_PCT NUMBER])");
  eq("overload 2: record type, IN OUT", signatureLabel(raise[1]).label, "EMP_PKG.RAISE_SALARY(P_EMP HR.EMP_PKG.EMP_REC, P_NEW IN OUT NUMBER)");

  const bonus = await meta.signatures(site(["get_bonus"]));
  eq("standalone function with return type", signatureLabel(bonus[0]).label, "GET_BONUS(P_ID NUMBER) RETURN NUMBER");
  assert("standalone uses package_name IS NULL", t.calls.some((c) => /package_name IS NULL/.test(c.sql)));
  eq("schema-qualified standalone", (await meta.signatures(site(["hr", "get_bonus"])))[0]?.name, "GET_BONUS");
  eq("schema.package.member", (await meta.signatures(site(["hr", "emp_pkg", "raise_salary"]))).length, 2);

  const reset = await meta.signatures(site(["emp_pkg", "reset"]));
  eq("parameterless member (no ALL_ARGUMENTS row) still found", reset.map((s) => signatureLabel(s).label), ["EMP_PKG.RESET()"]);
  eq("unknown routine", await meta.signatures(site(["nope"])), []);
  eq("db link calls are not looked up", await meta.signatures({ ...site(["p"]), dbLink: "PROD" }), []);
}

section("metadata.describe");
{
  const { meta } = dictionary();
  const d = (parts: string[], extra = {}) => meta.describe({ parts, quoted: parts.map(() => false), ...extra });

  const table = await d(["employees"]);
  eq("table kind / owner", [table?.kind, table?.owner, table?.name], ["table", "HR", "EMPLOYEES"]);
  eq("table comment", table?.comment, "Employees of the company");
  eq("table columns", table?.columns?.map((c) => `${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}`), ["EMPLOYEE_ID NUMBER(6) NOT NULL", "SALARY NUMBER(8,2)"]);

  const syn = await d(["staff"]);
  eq("synonym followed", [syn?.name, syn?.synonym], ["EMPLOYEES", "HR.STAFF"]);

  const col = await d(["e", "salary"], { aliases: [{ alias: "e", table: "hr.employees", kind: "table" }] });
  eq("alias.column", [col?.kind, col?.dataType, col?.nullable, col?.parent, col?.comment], ["column", "NUMBER(8,2)", true, "HR.EMPLOYEES", "Monthly salary"]);
  const alias = await d(["e"], { aliases: [{ alias: "e", table: "employees", kind: "table" }] });
  eq("alias → table", [alias?.alias, alias?.name], ["e", "EMPLOYEES"]);
  eq("table.column without alias", (await d(["employees", "employee_id"]))?.dataType, "NUMBER(6)");
  eq("schema.table.column", (await d(["hr", "employees", "salary"]))?.kind, "column");
  eq("schema.table", (await d(["hr", "employees"]))?.kind, "table");
  eq("unknown column", await d(["employees", "nope"]), undefined);

  const pkg = await d(["dbms_output"]);
  eq("package members", [pkg?.kind, pkg?.synonym, pkg?.members], ["package", "PUBLIC.DBMS_OUTPUT", ["NEW_LINE", "PUT_LINE"]]);
  const member = await d(["emp_pkg", "raise_salary"]);
  eq("package member signatures", [member?.kind, member?.signatures?.length], ["procedure", 2]);
  const fn = await d(["get_bonus"]);
  eq("function", [fn?.kind, fn?.signatures?.[0].returnType], ["function", "NUMBER"]);

  const seq = await d(["emp_seq"]);
  eq("sequence properties", seq?.properties?.find(([k]) => k === "last number")?.[1], "207");
  eq("seq.NEXTVAL", (await d(["emp_seq", "nextval"]))?.kind, "sequence");
  eq("schema", await d(["scott"]), { kind: "schema", name: "SCOTT" });
  eq("invalid view status", (await d(["bad_v"]))?.status, "INVALID");

  const remote = await d(["remote_emp"]);
  eq("synonym to a db link", [remote?.dbLink, remote?.columns?.map((c) => c.name)], ["PROD", ["EMPNO"]]);
  const link = await d(["emp"], { dbLink: "prod" });
  eq("name@link", [link?.dbLink, link?.columns?.length], ["PROD", 1]);
  eq("nothing", await d(["nothing_here"]), undefined);
}

section("renderObjectInfo");
{
  const md = renderObjectInfo({
    kind: "table", name: "EMPLOYEES", owner: "HR", comment: "Staff", synonym: "HR.STAFF",
    columns: [{ name: "ID", type: "NUMBER", nullable: false }, { name: "NAME", type: "VARCHAR2(20)", nullable: true }],
  });
  assert("heading", md.startsWith("`HR.EMPLOYEES` — table"), md);
  assert("synonym line", md.includes("via synonym `HR.STAFF`"));
  assert("column table", md.includes("| ID | NUMBER NOT NULL |") && md.includes("| NAME | VARCHAR2(20) |"));
  const colMd = renderObjectInfo({ kind: "column", name: "SAL", dataType: "NUMBER", nullable: false, parent: "HR.EMP" });
  eq("column heading", colMd, "`SAL NUMBER NOT NULL` — column of `HR.EMP`");
  assert("invalid status is bold", renderObjectInfo({ kind: "view", name: "V", owner: "X", status: "INVALID" }).includes("**(INVALID)**"));
  const many = renderObjectInfo({ kind: "table", name: "T", columns: Array.from({ length: 5 }, (_, i) => ({ name: `C${i}`, type: "NUMBER", nullable: true })) }, 3);
  assert("columns truncated", many.includes("… 2 more columns"));
}

section("hover");
{
  eq("name at column: part index", nameAtColumn("SELECT hr.employees.salary FROM x", 12)?.index, 1);
  eq("name at column: parts", nameAtColumn("SELECT hr.employees.salary FROM x", 22)?.parts, ["hr", "employees", "salary"]);
  eq("name at column: call", nameAtColumn("x := nvl(a, b)", 7)?.call, true);
  eq("bind variable has no name", nameAtColumn("WHERE id = :emp_id", 14), undefined);
  eq("db link", nameAtColumn("FROM emp@prod e", 7)?.dbLink, "PROD");

  const elements = resolveLanguageElements();
  const seen: unknown[] = [];
  const describe: DescribeSource = (t) => {
    seen.push(t);
    return t.parts.join(".").toUpperCase() === "EMPLOYEES" ? { kind: "table", name: "EMPLOYEES", owner: "HR" } : undefined;
  };
  const hover = (line: string, column: number, full = line) =>
    hoverInfo(full, line, { line: 1, column }, column - 1, { elements, describe: () => describe });

  const h1 = await hover("SELECT * FROM employees", 17);
  eq("table hover", h1?.markdown, "`HR.EMPLOYEES` — table");
  eq("hover range = the word", [h1?.start, h1?.end], [15, 24]);
  const h2 = await hover("SELECT nvl(a, b) FROM dual", 9);
  assert("built-in function hover shows the signature", !!h2?.markdown.includes("NVL(expr1 ANY, expr2 ANY) RETURN ANY"), h2);
  assert("pseudo-column help", !!(await hover("SELECT sysdate FROM dual", 10))?.markdown.startsWith("**SYSDATE** — pseudo-column"));
  assert("Oracle package without metadata", !!(await hover("BEGIN dbms_lob.x; END;", 9))?.markdown.startsWith("**DBMS_LOB** — Oracle-supplied package"));
  eq("inside a string: nothing", await hover("SELECT 'employees' FROM dual", 12), undefined);
  eq("inside a comment: nothing", await hover("-- employees", 6), undefined);
  eq("unknown: nothing", await hover("SELECT foo FROM dual", 9), undefined);
  await hover("SELECT e.salary FROM employees e", 11);
  eq("describe gets the prefix up to the hovered part", (seen.pop() as { parts: string[] }).parts, ["e", "salary"]);
  await hover("SELECT e.salary FROM employees e", 8);
  eq("hovering the qualifier describes just it", (seen.pop() as { parts: string[] }).parts, ["e"]);
}

section("server validation");
{
  const t = createMockTransport();
  t.on(/EXPLAIN PLAN .* FOR SELECT \* FROM nope/i, (req) => ({ error: { code: "ORA-00942", message: "ORA-00942: table or view does not exist", offset: req.sql.indexOf("nope") } }));
  t.on(/EXPLAIN PLAN .* FOR SELECT bad_col/i, { error: { code: "ORA-00904", message: 'ORA-00904: "BAD_COL": invalid identifier' } });
  t.on(/EXPLAIN PLAN .* FOR SELECT \* FROM secret/i, { error: { code: "ORA-01039", message: "ORA-01039: insufficient privileges on underlying objects of the view" } });
  t.on(/EXPLAIN PLAN .* FOR SELECT \* FROM gone/i, { error: { code: "SESSION_EXPIRED", message: "expired" } });
  const validate = createServerValidator({ transport: t, substitutionVariables: new Map([["TAB", "emp"]]) });
  const stmt = (sql: string) => splitStatements(sql)[0];

  eq("valid query → null", await validate(stmt("SELECT * FROM emp")), null);
  assert("sent as EXPLAIN PLAN", /^EXPLAIN PLAN SET STATEMENT_ID = 'OMV[A-Z0-9]+' FOR SELECT \* FROM emp$/.test(t.calls[0].sql), t.calls[0].sql);
  assert("plan rows deleted afterwards", /DELETE FROM plan_table/.test(t.calls[1].sql));

  const s = stmt("SELECT * FROM nope");
  const issue = await validate(s);
  eq("error located in the statement", issue && { code: issue.code, offset: issue.offset, length: issue.length }, { code: "ORA-00942", offset: 14, length: 4 });
  eq("no offset → statement start", (await validate(stmt("SELECT bad_col FROM dual")))?.offset, 0);

  t.calls.length = 0;
  eq("DDL is never sent", await validate(stmt("CREATE TABLE x (a NUMBER)")), undefined);
  eq("PL/SQL is never sent", await validate(stmt("BEGIN NULL; END;")), undefined);
  eq("ALTER SESSION is never sent", await validate(stmt("ALTER SESSION SET current_schema = hr")), undefined);
  eq("nothing reached the transport", t.calls.length, 0);
  eq("isServerValidatable: DML", ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "MERGE INTO t USING s ON (1=1) WHEN MATCHED THEN UPDATE SET a = 1", "WITH x AS (SELECT 1 FROM dual) SELECT * FROM x"].map((q) => isServerValidatable(stmt(q))), [true, true, true, true, true]);

  eq("binds bound to NULL", (await validate(stmt("SELECT * FROM emp WHERE id = :id")), binds(t.calls[0])), { id: null as unknown as string });
  t.calls.length = 0;
  await validate(stmt("SELECT * FROM &tab"));
  assert("defined &var substituted", / FOR SELECT \* FROM emp$/.test(t.calls[0].sql), t.calls[0].sql);
  t.calls.length = 0;
  eq("undefined &var skipped", await validate(stmt("SELECT * FROM &other")), undefined);
  eq("…without a round trip", t.calls.length, 0);

  eq("environment errors are not issues (ORA-01039)", await validate(stmt("SELECT * FROM secret")), undefined);
  eq("transport errors are not issues", await validate(stmt("SELECT * FROM gone")), undefined);

  const paused = createServerValidator({ transport: t, paused: () => true });
  eq("paused → not checked", await paused(stmt("SELECT 1 FROM dual")), undefined);

  const ords = createMockTransport();
  Object.assign(ords, { stateless: true });
  await createServerValidator({ transport: ords })(stmt("SELECT 1 FROM dual"));
  eq("stateless: no cleanup call", ords.calls.length, 1);
}

section("model router");
{
  const router = createModelRouter<string>("fallback");
  const model = (uri: string) => ({ uri: { toString: () => uri } }) as never;
  const detach = router.attach("a", "A");
  router.attach("b", "B");
  eq("routes per model", [router.pick(model("a")), router.pick(model("b")), router.pick(model("c"))], ["A", "B", "fallback"]);
  detach();
  eq("detached → fallback", router.pick(model("a")), "fallback");
  const stale = router.attach("b", "B2");
  router.attach("b", "B3");
  stale();
  eq("stale detach keeps the newer provider", router.pick(model("b")), "B3");
}

done();
