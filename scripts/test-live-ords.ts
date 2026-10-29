/*
 * End-to-end test of the ORDS REST-Enabled SQL transport (opt-in).
 *
 *   ORDS_URL=http://host:8080/ords ORDS_SCHEMA=scott ORDS_USER=scott \
 *   ORDS_PASSWORD=... npx tsx scripts/test-live-ords.ts
 *
 * Requires restEnabledSql.active=true and ORDS.ENABLE_SCHEMA for the schema.
 * Creates and drops OM_ORDS_* objects.
 */
import { createOrdsTransport } from "../src/oracle/transport/ords.js";
import { createOracleQueryRunner, type OracleQueryError, type StatementResult } from "../src/oracle/runner.js";
import { createOracleMetadataProvider } from "../src/oracle/metadata.js";
import { basicAuthHeader } from "../src/oracle/transport/auth.js";
import { splitStatements } from "../src/oracle/splitter.js";
import { assert, done, eq, section } from "./harness.js";

const url = process.env.ORDS_URL;
if (!url) {
  console.log("ORDS_URL not set — skipping ORDS live test.");
  process.exit(0);
}

const transport = createOrdsTransport({
  baseUrl: url,
  schemaAlias: process.env.ORDS_SCHEMA ?? "scott",
  authorization: basicAuthHeader(process.env.ORDS_USER ?? "scott", process.env.ORDS_PASSWORD ?? ""),
});
const metadata = createOracleMetadataProvider({ transport });
const runner = createOracleQueryRunner({ transport, metadata, maxRows: 4 });

async function script(sql: string): Promise<StatementResult[]> {
  const out: StatementResult[] = [];
  for await (const r of runner.runScript(sql)) out.push(r);
  return out;
}

section("session");
{
  const s = await transport.session!();
  eq("user / schema", [s.user, s.currentSchema], ["SCOTT", "SCOTT"]);
  console.log(`  Oracle ${s.version}`);
}

section("setup");
{
  const results = await script(`
BEGIN
  EXECUTE IMMEDIATE 'DROP TABLE om_ords_t PURGE';
EXCEPTION WHEN OTHERS THEN NULL;
END;
/
CREATE TABLE om_ords_t (id NUMBER(4) PRIMARY KEY, name VARCHAR2(20), created DATE);
INSERT INTO om_ords_t SELECT level, 'N' || level, DATE '2024-02-29' + level FROM dual CONNECT BY level <= 10;
`);
  eq("no errors", results.filter((r) => r.error).map((r) => r.error?.message), []);
  eq("feedback", results.map((r) => r.message), ["PL/SQL procedure successfully completed.", "Table created.", "10 rows created."]);
}

section("queries, paging, values");
{
  const r = await runner.run("SELECT id, name, created FROM om_ords_t ORDER BY id");
  eq("first page", [r.rows?.length, r.hasMore], [4, true]);
  eq("NUMBER string, DATE wall clock", r.rows?.[0], ["1", "N1", "2024-03-01 00:00:00"]);
  while (r.hasMore) await runner.fetchMore(r);
  eq("paged by offset", r.rows?.map((x) => x[0]), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  eq("binds", (await runner.run("SELECT name FROM om_ords_t WHERE id = :id", { binds: { id: 7 } })).rows, [["N7"]]);
}

section("errors and output");
{
  const doc = "SELECT 1 FROM dual;\nSELECT *\n  FROM om_missing";
  try {
    await runner.run(splitStatements(doc)[1]);
  } catch (e) {
    const err = e as OracleQueryError;
    eq("ORA code and document position", [err.code, err.line, err.column], ["ORA-00942", 3, 8]);
    assert("message without doc URL", !/https?:/.test(err.message));
  }
  runner.serverOutput = true;
  const out = await runner.run("BEGIN DBMS_OUTPUT.PUT_LINE('a'); DBMS_OUTPUT.PUT_LINE('b'); END;");
  eq("DBMS_OUTPUT", out.dbmsOutput, ["a", "b"]);
  runner.serverOutput = false;
  const bad = await runner.run("CREATE OR REPLACE PROCEDURE om_ords_bad IS BEGIN x := 1; END;\n/");
  eq("compilation errors", [bad.message, bad.compileErrors?.[0]?.message.slice(0, 9)], ["Procedure created with compilation errors.", "PLS-00201"]);
  await runner.run("DROP PROCEDURE om_ords_bad");
}

section("explain (single request on a stateless transport)");
{
  const plan = await runner.explain("SELECT * FROM om_ords_t WHERE id = :id");
  assert("DBMS_XPLAN output", plan.lines.some((l) => /INDEX UNIQUE SCAN|TABLE ACCESS/.test(l)));
}

section("metadata");
{
  const cols = await metadata({ text: "", position: { line: 1, column: 1 }, word: "", expectColumn: true, qualifier: ["t"], aliases: [{ alias: "t", table: "om_ords_t", kind: "table" }] });
  eq("columns", cols.map((c) => c.label), ["ID", "NAME", "CREATED"]);
}

section("cleanup");
eq("dropped", (await runner.run("DROP TABLE om_ords_t PURGE")).message, "Table dropped.");

done();
