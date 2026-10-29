/* Gateway HTTP / session / auth tests against a fake driver (no database). Run: npm test (in servers/server-node/) */
import { createGateway, type GatewayOptions } from "../src/gateway.js";
import type { Connection, DriverError, ExecuteResult, OracleDriver } from "../src/driver.js";

let pass = 0;
let fail = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok ? "" : `\n     got: ${JSON.stringify(actual)}\n     expected: ${JSON.stringify(expected)}`}`);
}
const section = (n: string) => console.log(`\n■ ${n}`);

function oraError(num: number, message: string, offset?: number): DriverError {
  return Object.assign(new Error(`ORA-${String(num).padStart(5, "0")}: ${message}\nHelp: https://docs.oracle.com/error-help/db/ora-${num}/`), { errorNum: num, offset });
}

interface FakeConn extends Connection {
  log: string[];
  closed: boolean;
  rolledBack: number;
}

function fakeDriver(): OracleDriver & { conns: FakeConn[] } {
  const conns: FakeConn[] = [];
  return {
    conns,
    fetchAsString: [],
    fetchAsBuffer: [],
    OUT_FORMAT_ARRAY: 4001,
    BIND_IN: 3001,
    BIND_OUT: 3003,
    BIND_INOUT: 3002,
    STRING: "STRING",
    NUMBER: "NUMBER",
    DATE: "DATE",
    CLOB: "CLOB",
    NCLOB: "NCLOB",
    BLOB: "BLOB",
    CURSOR: "CURSOR",
    async getConnection({ user, password }) {
      if (password === "bad") throw oraError(1017, "invalid credential or not authorized; logon denied");
      if (password === "locked") throw oraError(28000, "The account is locked.");
      const conn: FakeConn = {
        log: [],
        closed: false,
        rolledBack: 0,
        oracleServerVersion: user === "old" ? 1202000000 : 1903000000,
        oracleServerVersionString: user === "old" ? "12.2.0.1.0" : "19.3.0.0.0",
        async execute(sql: string, binds?: unknown): Promise<ExecuteResult> {
          conn.log.push(sql);
          if (/SYS_CONTEXT/.test(sql)) return { rows: [[user.toUpperCase(), user.toUpperCase()]] };
          if (/FROM big/.test(sql)) {
            const all = Array.from({ length: 7 }, (_, i) => [i + 1, new Date(2024, 1, 29, 13, 14, 15), Buffer.from([10, 255])]);
            return {
              metaData: [{ name: "N", dbTypeName: "NUMBER" }, { name: "D", dbTypeName: "DATE" }, { name: "R", dbTypeName: "RAW" }],
              resultSet: { async getRows(n: number) { return all.splice(0, n); }, async close() {} },
            };
          }
          if (/no_such/.test(sql)) throw oraError(942, "table or view does not exist", 14);
          if (/lost/.test(sql)) throw oraError(3113, "end-of-file on communication channel");
          if (/GET_LINES/.test(sql)) return { outBinds: { lines: ["a", "b", null], n: 2 } };
          if (/^UPDATE/.test(sql)) return { rowsAffected: 3 };
          if (/:x/.test(sql)) return { outBinds: { echo: JSON.stringify(binds) } };
          return {};
        },
        async break() { conn.log.push("BREAK"); },
        async commit() { conn.log.push("COMMIT"); },
        async rollback() { conn.rolledBack++; },
        async close() { conn.closed = true; },
      };
      conns.push(conn);
      return conn;
    },
  };
}

function setup(extra: Partial<GatewayOptions> = {}) {
  const driver = fakeDriver();
  const app = createGateway({
    driver,
    connectAliases: { dev: { connectString: "db:1521/PDB", label: "Development" } },
    loginRateLimit: { max: 3, windowMs: 60_000 },
    ...extra,
  });
  return { app, driver };
}

async function login(app: ReturnType<typeof createGateway>, user = "scott", password = "tiger") {
  const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { connectAlias: "dev", user, password } });
  const id = res.json().sessionId as string;
  const cookie = res.cookies.find((c) => c.name === "omsid");
  return { res, id, cookie, headers: { cookie: `omsid=${cookie?.value}` } };
}

section("aliases and login");
{
  const { app, driver } = setup();
  eq("aliases", (await app.inject("/api/aliases")).json(), [{ alias: "dev", label: "Development" }]);
  const { res, id, cookie } = await login(app);
  eq("login ok", [res.statusCode, res.json().user, res.json().currentSchema, res.json().version], [200, "SCOTT", "SCOTT", "19.3.0.0.0"]);
  eq("session cookie flags", [cookie?.value === id, cookie?.httpOnly, cookie?.sameSite, cookie?.secure, cookie?.path], [true, true, "Strict", true, "/api"]);
  eq("NLS formats set at login", driver.conns[0].log.filter((l) => /NLS_DATE_FORMAT/.test(l)).length, 1);
  const unknown = await app.inject({ method: "POST", url: "/api/sessions", payload: { connectAlias: "prod", user: "a", password: "b" } });
  eq("unknown alias", [unknown.statusCode, unknown.json().error.code], [400, "UNKNOWN_ALIAS"]);
  const injected = await app.inject({ method: "POST", url: "/api/sessions", payload: { connectAlias: "dev", user: "x/y@other", password: "b" } });
  eq("user name validated", injected.statusCode, 400);
  const bad = await login(app, "scott", "bad");
  eq("invalid credentials", [bad.res.statusCode, bad.res.json().error.code], [401, "INVALID_CREDENTIALS"]);
  const locked = await login(app, "scott", "locked");
  eq("account locked", [locked.res.statusCode, locked.res.json().error.code], [403, "ACCOUNT_LOCKED"]);
  await login(app, "scott", "bad");
  const limited = await login(app, "scott", "tiger");
  eq("rate limited after 3 failures", [limited.res.statusCode, limited.res.json().error.code], [429, "TOO_MANY_ATTEMPTS"]);
  const old = await login(app, "old");
  eq("Oracle < 19c refused", [old.res.statusCode, old.res.json().error.code], [400, "ORACLE_VERSION_UNSUPPORTED"]);
  eq("…and its connection closed", driver.conns[driver.conns.length - 1].closed, true);
  await app.close();
}
{
  const { app } = setup({ maxSessionsPerUser: 2 });
  await login(app);
  await login(app);
  const third = await login(app);
  eq("max sessions per user", [third.res.statusCode, third.res.json().error.code], [429, "TOO_MANY_SESSIONS"]);
  await app.close();
}

section("authorisation");
{
  const { app } = setup();
  const a = await login(app, "alice");
  const b = await login(app, "bob");
  const exec = (id: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/execute`, headers, payload: { sql: "SELECT 1 FROM dual" } });
  eq("own cookie", (await exec(a.id, a.headers)).statusCode, 200);
  eq("no cookie", (await exec(a.id, {})).statusCode, 401);
  eq("someone else's session id with my cookie", (await exec(b.id, a.headers)).statusCode, 401);
  eq("header auth off by default", (await exec(a.id, { "x-session-id": a.id })).statusCode, 401);
  await app.close();
}
{
  const { app } = setup({ allowHeaderAuth: true });
  const a = await login(app);
  const r = await app.inject({ method: "POST", url: `/api/sessions/${a.id}/execute`, headers: { "x-session-id": a.id }, payload: { sql: "SELECT 1 FROM dual" } });
  eq("header auth when enabled", r.statusCode, 200);
  await app.close();
}

section("execute");
{
  const { app, driver } = setup();
  const s = await login(app);
  const exec = (payload: object) => app.inject({ method: "POST", url: `/api/sessions/${s.id}/execute`, headers: s.headers, payload });
  const q = (await exec({ sql: "SELECT * FROM big", maxRows: 3 })).json();
  eq("columns", q.columns.map((c: { name: string; type: string }) => `${c.name}:${c.type}`), ["N:NUMBER", "D:DATE", "R:RAW"]);
  eq("cells: DATE wall clock, RAW hex", q.rows[0], [1, "2024-02-29 13:14:15", "0AFF"]);
  eq("cursor kept", typeof q.cursorId, "string");
  const page = (await app.inject({ method: "POST", url: `/api/sessions/${s.id}/cursors/${q.cursorId}/fetch`, headers: s.headers, payload: { maxRows: 3 } })).json();
  eq("next page", [page.rows.length, page.hasMore], [3, true]);
  const last = (await app.inject({ method: "POST", url: `/api/sessions/${s.id}/cursors/${q.cursorId}/fetch`, headers: s.headers, payload: { maxRows: 3 } })).json();
  eq("last page closes the cursor", [last.rows.length, last.hasMore], [1, false]);
  const gone = await app.inject({ method: "POST", url: `/api/sessions/${s.id}/cursors/${q.cursorId}/fetch`, headers: s.headers, payload: {} });
  eq("closed cursor", gone.statusCode, 404);

  const err = await exec({ sql: "SELECT * FROM no_such" });
  eq("ORA error -> 422 with code/offset, help URL dropped", [err.statusCode, err.json().error], [422, { code: "ORA-00942", message: "ORA-00942: table or view does not exist", offset: 14 }]);
  eq("DML rows affected", (await exec({ sql: "UPDATE t SET a = 1" })).json().rowsAffected, 3);
  const out = (await exec({ sql: "BEGIN NULL; END;", captureDbmsOutput: true })).json();
  eq("DBMS_OUTPUT sliced to n", out.dbmsOutput, ["a", "b"]);
  eq("DBMS_OUTPUT enabled once", driver.conns[0].log.filter((l) => /ENABLE/.test(l)).length, 1);
  const b = (await exec({ sql: "BEGIN :x := 1; END;", binds: { x: { dir: "out", type: "number" }, y: 5, z: { value: "s" } } })).json();
  eq("bind mapping", JSON.parse(b.outBinds.echo), { x: { dir: 3003, type: "NUMBER" }, y: 5, z: { dir: 3001, val: "s" } });
  eq("empty sql rejected", (await exec({ sql: "  " })).statusCode, 400);

  const commit = await app.inject({ method: "POST", url: `/api/sessions/${s.id}/commit`, headers: s.headers });
  eq("commit", [commit.statusCode, driver.conns[0].log.includes("COMMIT")], [204, true]);

  const lost = await exec({ sql: "SELECT lost FROM dual" });
  eq("dead connection -> SESSION_LOST", [lost.statusCode, lost.json().error.code], [401, "SESSION_LOST"]);
  eq("…session dropped and closed", [(await exec({ sql: "SELECT 1 FROM dual" })).statusCode, driver.conns[0].closed], [401, true]);
  await app.close();
}
{
  const { app } = setup({ allowDdl: false });
  const s = await login(app);
  const r = await app.inject({ method: "POST", url: `/api/sessions/${s.id}/execute`, headers: s.headers, payload: { sql: "-- c\n  drop table t" } });
  eq("DDL blocked when disabled (after leading comments)", [r.statusCode, r.json().error.code], [403, "DDL_NOT_ALLOWED"]);
  await app.close();
}

section("cancel, logout, idle timeout");
{
  const { app, driver } = setup({ idleTimeoutMs: 1500 });
  const s = await login(app);
  const conn = driver.conns[0];
  const cancel = await app.inject({ method: "POST", url: `/api/sessions/${s.id}/cancel`, headers: s.headers, payload: { executionId: "nope" } });
  eq("cancel of an idle execution is a no-op", [cancel.statusCode, conn.log.includes("BREAK")], [204, false]);
  const out = await app.inject({ method: "DELETE", url: `/api/sessions/${s.id}`, headers: s.headers });
  eq("logout rolls back and closes", [out.statusCode, conn.rolledBack > 0, conn.closed], [204, true, true]);
  eq("cookie cleared", out.cookies.find((c) => c.name === "omsid")?.value, "");

  const t = await login(app);
  await new Promise((r) => setTimeout(r, 2600));
  eq("idle session swept", [driver.conns[1].closed, driver.conns[1].rolledBack > 0], [true, true]);
  const after = await app.inject({ method: "GET", url: `/api/sessions/${t.id}`, headers: t.headers });
  eq("…and gone", after.statusCode, 401);
  await app.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
