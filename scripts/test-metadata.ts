/* Node test for the dictionary metadata provider over a mock transport. Run: npx tsx scripts/test-metadata.ts */
import { createMockTransport } from "../src/oracle/transport/mock.js";
import { createOracleMetadataProvider } from "../src/oracle/metadata.js";
import type { MetadataProviderContext } from "../src/oracle/completion.js";
import type { ExecuteRequest } from "../src/oracle/transport/types.js";
import { assert, done, eq, section } from "./harness.js";

type B = Record<string, string>;
const binds = (r: ExecuteRequest) => (r.binds ?? {}) as B;

/** A tiny fake dictionary: HR owns EMPLOYEES, EMP_SEQ, EMP_PKG; synonym STAFF -> HR.EMPLOYEES. */
function setup() {
  const t = createMockTransport({ session: { currentSchema: "HR" } });
  const objects: Record<string, [string, string][]> = {
    HR: [["DEPARTMENTS", "TABLE"], ["EMPLOYEES", "TABLE"], ["EMP_PKG", "PACKAGE"], ["EMP_SEQ", "SEQUENCE"], ["EMP_V", "VIEW"], ["STAFF", "SYNONYM"], ["REMOTE_EMP", "SYNONYM"]],
    PUBLIC: [["DBMS_OUTPUT", "SYNONYM"]],
    SYS: [["DBMS_OUTPUT", "PACKAGE"]],
  };
  t.on(/FROM all_objects\s+WHERE owner = :owner AND object_type IN/i, (req) => {
    const { owner, p } = binds(req);
    const like = new RegExp(`^${p.replace(/\\(.)/g, "$1").replace(/%$/, "")}`);
    const types = [...req.sql.matchAll(/'([A-Z ]+)'/g)].map((m) => m[1]);
    const rows = (objects[owner] ?? []).filter(([n, ty]) => like.test(n) && types.includes(ty));
    return { columns: [], rows: rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) }; // ORDER BY object_name (binary)
  });
  t.on(/FROM all_objects\s+WHERE owner = :owner AND object_name = :name/i, (req) => {
    const { owner, name } = binds(req);
    return { columns: [], rows: (objects[owner] ?? []).filter(([n]) => n === name).map(([, ty]) => [ty]) };
  });
  t.on(/FROM all_synonyms WHERE owner = :owner AND synonym_name = :name/i, (req) => {
    const { owner, name } = binds(req);
    if (owner === "HR" && name === "STAFF") return { columns: [], rows: [["HR", "EMPLOYEES", null]] };
    if (owner === "HR" && name === "REMOTE_EMP") return { columns: [], rows: [["SCOTT", "EMP", "PROD"]] };
    if (owner === "PUBLIC" && name === "DBMS_OUTPUT") return { columns: [], rows: [["SYS", "DBMS_OUTPUT", null]] };
    return { columns: [], rows: [] };
  });
  t.on(/FROM all_tab_columns c/i, (req) =>
    binds(req).name === "EMPLOYEES"
      ? {
          columns: [],
          rows: [
            ["EMPLOYEE_ID", "NUMBER", 22, 6, 0, "N", 0, null, null],
            ["LAST_NAME", "VARCHAR2", 25, null, null, "N", 25, "B", "Family name"],
            ["SALARY", "NUMBER", 22, 8, 2, "Y", 0, null, null],
            ["Nick", "VARCHAR2", 80, null, null, "Y", 20, "C", null],
          ],
        }
      : { columns: [], rows: [] },
  );
  t.on(/FROM all_users\s+WHERE username LIKE/i, (req) => ({ columns: [], rows: [["HR"], ["SCOTT"]].filter(([u]) => u.startsWith(binds(req).p.replace("%", ""))) }));
  t.on(/FROM all_users WHERE username = :u/i, (req) => ({ columns: [], rows: ["HR", "SCOTT"].includes(binds(req).u) ? [[1]] : [] }));
  t.on(/FROM all_synonyms\s+WHERE owner = 'PUBLIC'/i, { columns: [], rows: [["DBMS_OUTPUT", "SYS", "DBMS_OUTPUT"]] });
  t.on(/FROM all_procedures/i, { columns: [], rows: [["GET_LINE", "PROCEDURE"], ["PUT_LINE", "PROCEDURE"]] });
  t.on(/FROM all_db_links/i, { columns: [], rows: [["PROD.EXAMPLE.COM"]] });
  const meta = createOracleMetadataProvider({ transport: t });
  const ctx = (c: Partial<MetadataProviderContext>): MetadataProviderContext => ({ text: "", position: { line: 1, column: 1 }, word: "", ...c });
  const labels = async (c: Partial<MetadataProviderContext>) => (await meta(ctx(c))).map((m) => m.label);
  return { t, meta, ctx, labels };
}

section("FROM |");
{
  const { t, labels } = setup();
  const got = await labels({ expectTable: true });
  eq("relations of the current schema + schemas", got, ["DEPARTMENTS", "EMPLOYEES", "EMP_V", "REMOTE_EMP", "STAFF", "HR", "SCOTT"]);
  const objCall = t.calls.find((c) => /object_type IN/.test(c.sql))!;
  eq("bound owner and prefix", binds(objCall), { owner: "HR", p: "%" });
  assert("no public synonyms without a 2-char prefix", !t.calls.some((c) => /owner = 'PUBLIC' AND synonym_name LIKE/.test(c.sql)));
  assert("system schemas hidden without a prefix", /oracle_maintained = 'N'/.test(t.calls.find((c) => /all_users/.test(c.sql))!.sql));
}
{
  const { t, labels } = setup();
  eq("typed prefix filters (upper-cased)", await labels({ expectTable: true, word: "em" }), ["EMPLOYEES", "EMP_V", "DBMS_OUTPUT"]);
  eq("LIKE pattern escapes _", binds(t.calls.find((c) => /object_type IN/.test(c.sql))!).p, "EM%");
  await labels({ expectTable: true, word: "EMP_" });
  eq("underscore escaped", binds(t.calls.filter((c) => /object_type IN/.test(c.sql)).pop()!).p, "EMP\\_%");
  await labels({ expectTable: true, word: '"Mi' });
  eq("quoted prefix keeps case", binds(t.calls.filter((c) => /object_type IN/.test(c.sql)).pop()!).p, "Mi%");
}
eq("FROM hr. -> objects of schema HR", await setup().labels({ expectTable: true, qualifier: ["hr"] }), ["DEPARTMENTS", "EMPLOYEES", "EMP_V", "REMOTE_EMP", "STAFF"]);
eq("FROM x. for a non-schema -> nothing", await setup().labels({ expectTable: true, qualifier: ["nobody"] }), []);

section("columns");
{
  const { meta, ctx } = setup();
  const items = await meta(ctx({ expectColumn: true, qualifier: ["e"], aliases: [{ alias: "e", table: "employees", kind: "table" }] }));
  eq("e. -> columns via alias", items.map((m) => m.label), ["EMPLOYEE_ID", "LAST_NAME", "SALARY", "Nick"]);
  eq("details", items.map((m) => m.detail), [
    "NUMBER(6) NOT NULL · EMPLOYEES",
    "VARCHAR2(25) NOT NULL · EMPLOYEES",
    "NUMBER(8,2) · EMPLOYEES",
    "VARCHAR2(20 CHAR) · EMPLOYEES",
  ]);
  eq("comment as documentation", items[1].documentation, "Family name");
}
eq("alias case-insensitive, synonym followed", await setup().labels({ expectColumn: true, qualifier: ["S"], aliases: [{ alias: "s", table: "staff", kind: "table" }] }), ["EMPLOYEE_ID", "LAST_NAME", "SALARY", "Nick"]);
eq("table name as qualifier", await setup().labels({ expectColumn: true, qualifier: ["employees"] }), ["EMPLOYEE_ID", "LAST_NAME", "SALARY", "Nick"]);
eq("schema.table qualifier", await setup().labels({ expectColumn: true, qualifier: ["hr", "employees"] }), ["EMPLOYEE_ID", "LAST_NAME", "SALARY", "Nick"]);
eq("SELECT | -> columns of tables in scope", await setup().labels({ expectColumn: true, aliases: [{ alias: "e", table: "hr.employees", kind: "table" }, { alias: "v", table: "(subquery)", kind: "subquery", columns: ["a"] }] }), ["EMPLOYEE_ID", "LAST_NAME", "SALARY", "Nick"]);
eq("aliases with local columns need no lookup", await setup().labels({ expectColumn: true, qualifier: ["x"], aliases: [{ alias: "x", table: "(subquery)", kind: "subquery", columns: ["a"] }] }), []);
{
  const { t, labels } = setup();
  eq("remote tables skipped by default", await labels({ expectColumn: true, qualifier: ["r"], aliases: [{ alias: "r", table: "emp", kind: "table", dbLink: "prod" }] }), []);
  eq("synonym over a db link skipped too", await labels({ expectColumn: true, qualifier: ["remote_emp"] }), []);
  assert("no remote query sent", !t.calls.some((c) => /@/.test(c.sql)));
}

section("packages, sequences, links, types");
{
  const { t, labels } = setup();
  eq("dbms_output. via public synonym", await labels({ expectProcedure: true, qualifier: ["dbms_output"] }), ["GET_LINE", "PUT_LINE"]);
  eq("members looked up in SYS", binds(t.calls.find((c) => /all_procedures/.test(c.sql))!).owner, "SYS");
}
eq("sequence pseudo-columns", await setup().labels({ expectColumn: true, qualifier: ["emp_seq"] }), ["NEXTVAL", "CURRVAL"]);
eq("db links", await setup().labels({ expectDbLink: true }), ["PROD.EXAMPLE.COM"]);
{
  const { t, labels } = setup();
  await labels({ expectFunction: true, expectColumn: true });
  assert("functions are not listed until the user types", !t.calls.some((c) => /'FUNCTION'/.test(c.sql)));
  await labels({ expectProcedure: true });
  assert("procedures listed at statement start", t.calls.some((c) => /'PROCEDURE'/.test(c.sql)));
}

section("cache and rounds");
{
  const { t, meta, ctx } = setup();
  await meta(ctx({ expectTable: true }));
  const n = t.calls.length;
  await meta(ctx({ expectTable: true }));
  eq("second identical round served from cache", t.calls.length, n);
  meta.invalidate();
  await meta(ctx({ expectTable: true }));
  assert("invalidate() forces new lookups", t.calls.length > n);
}
{
  const t = createMockTransport({ latencyMs: 50, session: { currentSchema: "HR" } });
  const seen: AbortSignal[] = [];
  const orig = t.execute.bind(t);
  t.execute = (req, signal) => {
    if (signal) seen.push(signal);
    return orig(req, signal);
  };
  const meta = createOracleMetadataProvider({ transport: t });
  const first = meta({ text: "", position: { line: 1, column: 1 }, word: "", expectTable: true });
  await new Promise((r) => setTimeout(r, 10));
  await meta({ text: "", position: { line: 1, column: 1 }, word: "x", expectTable: true });
  eq("aborted round resolves to []", await first, []);
  assert("previous round's requests were aborted", seen.some((s) => s.aborted));
}

done();
