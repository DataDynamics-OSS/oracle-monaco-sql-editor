/**
 * oracle-monaco gateway: per-user Oracle sessions over HTTP.
 *
 * Each user logs in with their OWN Oracle account. The gateway opens a
 * dedicated connection for that browser session and keeps it until logout or
 * idle timeout, so transactions, ALTER SESSION, package state, server-side
 * cursors, DBMS_OUTPUT and cancellation (`connection.break()`) behave like a
 * desktop SQL client — and Oracle privileges / auditing apply per user.
 *
 * Security model (see docs/DESIGN.md §8.3):
 *   - the password is sent once to POST /sessions and never stored; later
 *     calls are authorised by an httpOnly, SameSite=Strict session cookie
 *     that must match the session id in the URL
 *   - clients pick a server-configured connect alias, never a connect string
 *   - failed logins are rate-limited per client address + user
 *   - servers older than `minVersion` (19c) are refused at login
 *   - call timeout, row limits and DDL policy are enforced here; everything
 *     else is the user's own database privileges
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import type { Connection, DriverError, OracleDriver, ResultSet } from "./driver.js";

export interface ConnectTarget {
  /** Easy Connect string or TNS alias, e.g. "db-host:1521/ORCLPDB1". */
  connectString: string;
  /** Shown in the login form. */
  label?: string;
}

export interface GatewayOptions {
  /** node-oracledb (or a compatible fake in tests). */
  driver: OracleDriver;
  /** The only databases clients may connect to, by alias. */
  connectAliases: Record<string, ConnectTarget>;
  /** Route prefix. Default "/api". */
  prefix?: string;
  /** Close sessions idle this long (rolling back open work). Default 30 min. */
  idleTimeoutMs?: number;
  /** Concurrent sessions per alias + user. Default 3. */
  maxSessionsPerUser?: number;
  /** Per round-trip timeout (`connection.callTimeout`); 0 disables. Default 5 min. */
  callTimeoutMs?: number;
  /** Rows per page when the client does not say. Default 500. */
  defaultMaxRows?: number;
  /** Hard cap on rows per page. Default 5000. */
  maxRowsCap?: number;
  /** Allow DDL statements (CREATE / ALTER / DROP / …). Default true. */
  allowDdl?: boolean;
  /** Minimum Oracle major version. Default 19. */
  minVersion?: number;
  /** Mark the session cookie Secure (HTTPS only). Default true; disable only for local http dev. */
  secureCookie?: boolean;
  /** Session cookie name. Default "omsid". */
  cookieName?: string;
  /** Also accept `X-Session-Id` (non-browser clients). Default false. */
  allowHeaderAuth?: boolean;
  /** Statements run right after login (NLS formats by default). */
  sessionInit?: string[];
  /** Failed logins allowed per client + user within the window. Default 5 per minute. */
  loginRateLimit?: { max: number; windowMs: number };
  /** Fastify logger. Default false. */
  logger?: boolean;
}

interface OpenCursor {
  rs: ResultSet;
  types: (string | undefined)[];
}

interface Session {
  id: string;
  user: string;
  connectAlias: string;
  conn: Connection;
  currentSchema: string;
  version: string;
  lastUsed: number;
  cursors: Map<string, OpenCursor>;
  running: Set<string>;
  dbmsOutputEnabled: boolean;
}

interface ApiError {
  code: string;
  message: string;
  offset?: number;
}

type BindIn =
  | string
  | number
  | boolean
  | null
  | { value?: unknown; type?: string; dir?: "in" | "out" | "inout"; maxSize?: number };

interface ExecuteBody {
  sql?: unknown;
  binds?: Record<string, BindIn> | BindIn[];
  maxRows?: number;
  captureDbmsOutput?: boolean;
  executionId?: string;
}

const DEFAULT_SESSION_INIT = [
  "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
  "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
  "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'",
];

const DDL = /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE|AUDIT|NOAUDIT|PURGE|FLASHBACK|ANALYZE|ASSOCIATE|DISASSOCIATE)\b/i;

/** Leading comments and whitespace removed (for statement classification). */
function stripLeading(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, "");
}

/** Errors that mean the connection is gone and the session must be dropped. */
const DEAD_CONNECTION = /^(ORA-0(1012|3113|3114|3135|0028)|DPI-1080|NJS-(003|500|501|503))/;

function oraCode(e: DriverError): string {
  if (e.errorNum) return `ORA-${String(e.errorNum).padStart(5, "0")}`;
  return e.code ?? "GATEWAY_ERROR";
}

function toApiError(e: unknown): ApiError {
  const err = e as DriverError;
  const message = String(err?.message ?? e)
    .split("\n")
    .filter((l) => !/^Help: https?:/.test(l.trim()))
    .join("\n")
    .trim();
  const out: ApiError = { code: oraCode(err), message };
  if (err?.errorNum && typeof err.offset === "number" && err.offset > 0) out.offset = err.offset;
  return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * DATE / TIMESTAMP (no time zone) as `YYYY-MM-DD HH24:MI:SS[.FFF]`. The driver
 * builds these Dates from the wall-clock fields in local time, so the local
 * getters return the stored values whatever the process time zone is.
 */
function wallClock(d: Date, fraction: boolean): string {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return fraction ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/** JSON-safe cell values: RAW/BLOB buffers as hex, dates as text. */
function cell(v: unknown, dbType: string | undefined): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex").toUpperCase();
  if (v instanceof Date) {
    if (dbType === "DATE") return wallClock(v, false);
    if (dbType === "TIMESTAMP") return wallClock(v, true);
    return v.toISOString(); // WITH (LOCAL) TIME ZONE: an absolute instant
  }
  if (typeof v === "bigint") return v.toString();
  return v;
}

const rowsOut = (rows: unknown[][], types: (string | undefined)[]) =>
  rows.map((r) => r.map((v, i) => cell(v, types[i])));

const IDENT = /^(?:[A-Za-z][\w$#]{0,127}|"[^"]{1,128}")$/;

export function createGateway(options: GatewayOptions): FastifyInstance {
  const {
    driver,
    connectAliases,
    prefix = "/api",
    idleTimeoutMs = 30 * 60_000,
    maxSessionsPerUser = 3,
    callTimeoutMs = 5 * 60_000,
    defaultMaxRows = 500,
    maxRowsCap = 5000,
    allowDdl = true,
    minVersion = 19,
    secureCookie = true,
    cookieName = "omsid",
    allowHeaderAuth = false,
    sessionInit = DEFAULT_SESSION_INIT,
    loginRateLimit = { max: 5, windowMs: 60_000 },
  } = options;

  // NUMBER as strings (exact precision), LOBs inline. Dates are formatted per
  // column type in `cell()`.
  driver.fetchAsString = [driver.NUMBER, driver.CLOB, driver.NCLOB];
  driver.fetchAsBuffer = [driver.BLOB];

  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; resetAt: number }>();

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  void app.register(cookie);

  const fail = (reply: FastifyReply, status: number, error: ApiError) => reply.code(status).send({ error });

  async function closeSession(s: Session): Promise<void> {
    sessions.delete(s.id);
    for (const c of s.cursors.values()) await c.rs.close().catch(() => {});
    s.cursors.clear();
    await s.conn.rollback().catch(() => {});
    await s.conn.close().catch(() => {});
  }

  // Idle sweeper.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.running.size && now - s.lastUsed > idleTimeoutMs) void closeSession(s);
    }
  }, Math.min(60_000, Math.max(1_000, idleTimeoutMs / 2)));
  sweep.unref();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    await Promise.all([...sessions.values()].map(closeSession));
  });

  /** Resolve and authorise the session named in the URL. */
  function sessionFor(req: FastifyRequest, reply: FastifyReply): Session | undefined {
    const { id } = req.params as { id: string };
    const fromCookie = req.cookies?.[cookieName];
    const fromHeader = allowHeaderAuth ? req.headers["x-session-id"] : undefined;
    const s = sessions.get(id);
    if (!s || (fromCookie !== id && fromHeader !== id)) {
      fail(reply, 401, { code: "SESSION_EXPIRED", message: "Not connected or session expired" });
      return undefined;
    }
    s.lastUsed = Date.now();
    return s;
  }

  /** Map a driver error; drop the session when the connection is dead. */
  async function dbError(reply: FastifyReply, s: Session, e: unknown) {
    const err = toApiError(e);
    if (DEAD_CONNECTION.test(err.code)) {
      await closeSession(s);
      return fail(reply, 401, { code: "SESSION_LOST", message: `Database connection lost: ${err.message}` });
    }
    return fail(reply, 422, err);
  }

  function toDriverBinds(binds: ExecuteBody["binds"]): unknown {
    if (!binds) return [];
    const one = (b: BindIn): unknown => {
      if (b === null || typeof b !== "object") return b;
      const dir = b.dir === "out" ? driver.BIND_OUT : b.dir === "inout" ? driver.BIND_INOUT : driver.BIND_IN;
      const type =
        b.type === "number" ? driver.NUMBER
        : b.type === "date" || b.type === "timestamp" ? driver.DATE
        : b.type === "clob" ? driver.CLOB
        : b.type === "cursor" ? driver.CURSOR
        : b.type === "string" || dir !== driver.BIND_IN ? driver.STRING
        : undefined;
      return {
        dir,
        ...(type !== undefined ? { type } : {}),
        ...(b.value !== undefined ? { val: b.value } : {}),
        ...(dir !== driver.BIND_IN && type === driver.STRING ? { maxSize: b.maxSize ?? 32767 } : {}),
      };
    };
    return Array.isArray(binds) ? binds.map(one) : Object.fromEntries(Object.entries(binds).map(([k, v]) => [k, one(v)]));
  }

  async function readDbmsOutput(conn: Connection): Promise<string[]> {
    const lines: string[] = [];
    const batch = 500;
    for (let guard = 0; guard < 1000; guard++) {
      const r = await conn.execute("BEGIN DBMS_OUTPUT.GET_LINES(:lines, :n); END;", {
        lines: { dir: driver.BIND_OUT, type: driver.STRING, maxSize: 32767, maxArraySize: batch },
        n: { dir: driver.BIND_INOUT, type: driver.NUMBER, val: batch },
      });
      const out = r.outBinds as { lines?: (string | null)[]; n?: number | string };
      const n = Number(out.n ?? 0);
      for (const l of (out.lines ?? []).slice(0, n)) lines.push(l ?? "");
      if (n < batch) break;
    }
    return lines;
  }

  // ---------------------------------------------------------------- routes

  app.register(async (api) => {
    api.get("/aliases", async () =>
      Object.entries(connectAliases).map(([alias, t]) => ({ alias, label: t.label ?? alias })),
    );

    api.post("/sessions", async (req, reply) => {
      const { connectAlias, user, password } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof connectAlias !== "string" || typeof user !== "string" || typeof password !== "string") {
        return fail(reply, 400, { code: "BAD_REQUEST", message: "connectAlias, user and password are required" });
      }
      const target = connectAliases[connectAlias];
      if (!target) return fail(reply, 400, { code: "UNKNOWN_ALIAS", message: `Unknown connect alias '${connectAlias}'` });
      if (!IDENT.test(user) || password.length === 0 || password.length > 1024) {
        return fail(reply, 400, { code: "BAD_REQUEST", message: "Invalid user name or password" });
      }

      const key = `${req.ip}|${connectAlias}|${user.toUpperCase()}`;
      const f = failures.get(key);
      if (f && f.resetAt > Date.now() && f.count >= loginRateLimit.max) {
        return fail(reply, 429, { code: "TOO_MANY_ATTEMPTS", message: "Too many failed logins; try again later" });
      }
      const open = [...sessions.values()].filter(
        (s) => s.connectAlias === connectAlias && s.user === user.toUpperCase(),
      ).length;
      if (open >= maxSessionsPerUser) {
        return fail(reply, 429, { code: "TOO_MANY_SESSIONS", message: `At most ${maxSessionsPerUser} sessions per user` });
      }

      let conn: Connection;
      try {
        conn = await driver.getConnection({ user, password, connectString: target.connectString });
      } catch (e) {
        const err = toApiError(e);
        const entry = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + loginRateLimit.windowMs };
        entry.count++;
        failures.set(key, entry);
        if (err.code === "ORA-01017") return fail(reply, 401, { code: "INVALID_CREDENTIALS", message: "Invalid user name or password" });
        if (err.code === "ORA-28000") return fail(reply, 403, { code: "ACCOUNT_LOCKED", message: err.message });
        if (err.code === "ORA-28001") return fail(reply, 403, { code: "PASSWORD_EXPIRED", message: err.message });
        return fail(reply, 502, { code: err.code, message: err.message });
      }
      failures.delete(key);

      const major = Math.floor(conn.oracleServerVersion / 100_000_000);
      if (major < minVersion) {
        await conn.close().catch(() => {});
        return fail(reply, 400, {
          code: "ORACLE_VERSION_UNSUPPORTED",
          message: `Oracle ${conn.oracleServerVersionString} is not supported (minimum ${minVersion}c)`,
        });
      }

      try {
        if (callTimeoutMs > 0) conn.callTimeout = callTimeoutMs;
        for (const sql of sessionInit) await conn.execute(sql);
        const who = await conn.execute(
          "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), USER FROM dual",
          [],
          { outFormat: driver.OUT_FORMAT_ARRAY },
        );
        const [currentSchema, dbUser] = (who.rows?.[0] ?? []) as string[];
        const s: Session = {
          id: randomBytes(24).toString("base64url"),
          user: dbUser ?? user.toUpperCase(),
          connectAlias,
          conn,
          currentSchema: currentSchema ?? user.toUpperCase(),
          version: conn.oracleServerVersionString,
          lastUsed: Date.now(),
          cursors: new Map(),
          running: new Set(),
          dbmsOutputEnabled: false,
        };
        sessions.set(s.id, s);
        reply.setCookie(cookieName, s.id, {
          httpOnly: true,
          sameSite: "strict",
          secure: secureCookie,
          path: prefix,
        });
        return {
          sessionId: s.id,
          user: s.user,
          currentSchema: s.currentSchema,
          version: s.version,
          connectAlias,
          ...(conn.warning ? { warning: toApiError(conn.warning) } : {}),
        };
      } catch (e) {
        await conn.close().catch(() => {});
        return fail(reply, 502, toApiError(e));
      }
    });

    api.get("/sessions/:id", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      try {
        const r = await s.conn.execute("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual", [], {
          outFormat: driver.OUT_FORMAT_ARRAY,
        });
        s.currentSchema = String(r.rows?.[0]?.[0] ?? s.currentSchema);
      } catch (e) {
        return dbError(reply, s, e);
      }
      return { user: s.user, currentSchema: s.currentSchema, version: s.version, connectAlias: s.connectAlias };
    });

    api.delete("/sessions/:id", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      await closeSession(s);
      reply.clearCookie(cookieName, { path: prefix });
      return reply.code(204).send();
    });

    api.post("/sessions/:id/execute", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      const body = (req.body ?? {}) as ExecuteBody;
      if (typeof body.sql !== "string" || !body.sql.trim()) {
        return fail(reply, 400, { code: "BAD_REQUEST", message: "sql is required" });
      }
      const sql = body.sql;
      if (!allowDdl && DDL.test(stripLeading(sql))) {
        return fail(reply, 403, { code: "DDL_NOT_ALLOWED", message: "DDL is disabled on this gateway" });
      }
      const maxRows = Math.max(1, Math.min(maxRowsCap, Math.floor(body.maxRows ?? defaultMaxRows)));
      const executionId = typeof body.executionId === "string" ? body.executionId : randomBytes(8).toString("hex");

      s.running.add(executionId);
      const started = Date.now();
      try {
        if (body.captureDbmsOutput && !s.dbmsOutputEnabled) {
          await s.conn.execute("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;");
          s.dbmsOutputEnabled = true;
        }
        const result = await s.conn.execute(sql, toDriverBinds(body.binds), {
          outFormat: driver.OUT_FORMAT_ARRAY,
          resultSet: true,
          fetchArraySize: Math.min(maxRows, 1000),
          autoCommit: false,
        });

        const out: Record<string, unknown> = {};
        if (result.resultSet) {
          const rows = await result.resultSet.getRows(maxRows);
          const types = (result.metaData ?? []).map((m) => m.dbTypeName);
          out.columns = (result.metaData ?? []).map((m) => ({
            name: m.name,
            type: m.dbTypeName ?? "",
            ...(m.precision !== undefined ? { precision: m.precision } : {}),
            ...(m.scale !== undefined ? { scale: m.scale } : {}),
            ...(m.nullable !== undefined ? { nullable: m.nullable } : {}),
          }));
          out.rows = rowsOut(rows, types);
          if (rows.length === maxRows) {
            const cursorId = randomBytes(8).toString("hex");
            s.cursors.set(cursorId, { rs: result.resultSet, types });
            out.cursorId = cursorId;
          } else {
            await result.resultSet.close();
          }
        } else {
          if (result.rowsAffected !== undefined) out.rowsAffected = result.rowsAffected;
          if (result.outBinds !== undefined) out.outBinds = result.outBinds;
        }
        if (result.warning) out.warning = toApiError(result.warning);
        if (body.captureDbmsOutput) out.dbmsOutput = await readDbmsOutput(s.conn);
        out.elapsedMs = Date.now() - started;
        return out;
      } catch (e) {
        return dbError(reply, s, e);
      } finally {
        s.running.delete(executionId);
      }
    });

    api.post("/sessions/:id/cursors/:cid/fetch", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      const { cid } = req.params as { cid: string };
      const cur = s.cursors.get(cid);
      if (!cur) return fail(reply, 404, { code: "CURSOR_CLOSED", message: "Cursor is closed" });
      const maxRows = Math.max(1, Math.min(maxRowsCap, Math.floor(((req.body ?? {}) as { maxRows?: number }).maxRows ?? defaultMaxRows)));
      try {
        const rows = await cur.rs.getRows(maxRows);
        const hasMore = rows.length === maxRows;
        if (!hasMore) {
          s.cursors.delete(cid);
          await cur.rs.close();
        }
        return { rows: rowsOut(rows, cur.types), hasMore };
      } catch (e) {
        s.cursors.delete(cid);
        return dbError(reply, s, e);
      }
    });

    api.delete("/sessions/:id/cursors/:cid", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      const { cid } = req.params as { cid: string };
      const cur = s.cursors.get(cid);
      s.cursors.delete(cid);
      await cur?.rs.close().catch(() => {});
      return reply.code(204).send();
    });

    api.post("/sessions/:id/cancel", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      const { executionId } = (req.body ?? {}) as { executionId?: string };
      // break() interrupts whatever the connection is running right now.
      if (executionId && s.running.has(executionId)) await s.conn.break().catch(() => {});
      return reply.code(204).send();
    });

    api.post("/sessions/:id/commit", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      try {
        await s.conn.commit();
        return reply.code(204).send();
      } catch (e) {
        return dbError(reply, s, e);
      }
    });

    api.post("/sessions/:id/rollback", async (req, reply) => {
      const s = sessionFor(req, reply);
      if (!s) return;
      try {
        await s.conn.rollback();
        return reply.code(204).send();
      } catch (e) {
        return dbError(reply, s, e);
      }
    });
  }, { prefix });

  return app;
}
