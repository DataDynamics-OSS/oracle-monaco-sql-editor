/**
 * Transport for ORDS REST-Enabled SQL (`POST /ords/{schema}/_/sql`).
 *
 * No server of your own is needed, but ORDS runs every request in a fresh
 * database session, so compared with the gateway:
 *   - no transactions across calls (ORDS commits each request), no
 *     ALTER SESSION / package state carried over
 *   - no server-side cursors: `fetchRows` re-runs the query with an offset
 *     (rows may shift if the data changes in between)
 *   - `cancel` only aborts the HTTP request; the database call runs on
 *   - DBMS_OUTPUT is captured by running the statement after SET SERVEROUTPUT ON
 *
 * Requires REST-Enabled SQL to be active in ORDS and the schema to be
 * REST-enabled (ORDS.ENABLE_SCHEMA). Authenticate with the schema user
 * (Basic) or an OAuth2 bearer token.
 */
import {
  OracleTransportError,
  randomId,
  type BindValue,
  type ExecuteRequest,
  type ExecuteResponse,
  type FetchResponse,
  type OracleColumn,
  type OracleSessionInfo,
  type OracleTransport,
} from "./types";

export interface OrdsTransportOptions {
  /** ORDS base, e.g. "https://host:8443/ords" or a same-origin proxy prefix "/ords". */
  baseUrl: string;
  /** REST-enabled schema alias (URL mapping pattern), e.g. "hr". */
  schemaAlias: string;
  /** "Basic …" or "Bearer …". */
  authorization?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

interface OrdsItem {
  statementType?: string;
  statementText?: string;
  response?: string[];
  /** DBMS_OUTPUT text when the script ran SET SERVEROUTPUT ON. */
  dbmsOutput?: string;
  result?: number;
  resultSet?: {
    metadata?: { columnName: string; jsonColumnName: string; columnTypeName?: string; precision?: number; scale?: number; isNullable?: number }[];
    items?: Record<string, unknown>[];
    hasMore?: boolean;
  };
  binds?: { name: string; result?: unknown }[];
  errorCode?: number;
  /** 1-based line of the error in the statement. */
  errorLine?: number;
  /** 0-based column of the error on that line. */
  errorColumn?: number;
  errorMessage?: string;
  errorDetails?: string;
}

interface PendingQuery {
  sql: string;
  binds?: ExecuteRequest["binds"];
  offset: number;
}

/** ORDS bind entries from named (`{ id: 1 }`) or positional binds. */
function ordsBinds(binds: ExecuteRequest["binds"]): unknown[] | undefined {
  if (!binds) return undefined;
  const entries: [string, BindValue][] = Array.isArray(binds)
    ? binds.map((v, i) => [String(i + 1), v])
    : Object.entries(binds);
  return entries.map(([name, b]) => {
    const value = b !== null && typeof b === "object" ? b.value ?? null : b;
    const declared = b !== null && typeof b === "object" ? b.type : undefined;
    const dataType =
      declared === "number" || (declared === undefined && typeof value === "number") ? "NUMBER"
      : declared === "date" ? "DATE"
      : declared === "timestamp" ? "TIMESTAMP"
      : declared === "clob" ? "CLOB"
      : "VARCHAR2";
    const mode = b !== null && typeof b === "object" && b.dir ? b.dir.toUpperCase() : undefined;
    return { name, data_type: dataType, value, ...(mode && mode !== "IN" ? { mode: mode === "INOUT" ? "INOUT" : "OUT" } : {}) };
  });
}

/** 0-based offset of a 1-based line and 0-based column in `text`. */
function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) break;
    offset = nl + 1;
  }
  return offset + Math.max(0, column);
}

/**
 * Values in the gateway's formats, so results look the same whichever
 * transport is used: NUMBER as exact strings, DATE / TIMESTAMP as wall-clock
 * text (ORDS sends them as UTC ISO strings: "2024-02-29T13:14:15.123Z").
 */
function normalize(value: unknown, type: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (type === "NUMBER" && typeof value === "number") return String(value);
  if ((type === "DATE" || type === "TIMESTAMP") && typeof value === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(value);
    if (m) return type === "DATE" ? `${m[1]} ${m[2]}` : `${m[1]} ${m[2]}${m[3] ?? ".000"}`;
  }
  return value;
}

export function createOrdsTransport(options: OrdsTransportOptions): OracleTransport {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error("No fetch available; pass options.fetch");
  const url = `${options.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(options.schemaAlias)}/_/sql`;
  const pending = new Map<string, PendingQuery>();

  async function post(statementText: string, extra: Record<string, unknown>, signal?: AbortSignal): Promise<OrdsItem[]> {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.authorization ? { Authorization: options.authorization } : {}),
        ...options.headers,
      },
      body: JSON.stringify({ statementText, ...extra }),
      signal,
    });
    const text = await res.text();
    let json: { items?: OrdsItem[]; message?: string; title?: string } | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      throw new OracleTransportError(
        { code: `HTTP_${res.status}`, message: json?.message ?? json?.title ?? (res.statusText || "ORDS error") },
        res.status,
      );
    }
    return json?.items ?? [];
  }

  function toResponse(item: OrdsItem, sql: string): ExecuteResponse {
    if (item.errorCode) {
      const message = (item.errorMessage ?? `ORA-${String(item.errorCode).padStart(5, "0")}`)
        .split("\n")
        .filter((l) => !/^https?:\/\//.test(l.trim()))
        .join("\n")
        .trim();
      throw new OracleTransportError({
        code: `ORA-${String(item.errorCode).padStart(5, "0")}`,
        message: /^ORA-\d{5}/.test(message) ? message : `ORA-${String(item.errorCode).padStart(5, "0")}: ${message}`,
        ...(item.errorLine ? { offset: offsetOf(sql, item.errorLine, item.errorColumn ?? 1) } : {}),
      });
    }
    const out: ExecuteResponse = {};
    const rs = item.resultSet;
    if (rs) {
      const meta = rs.metadata ?? [];
      out.columns = meta.map(
        (m): OracleColumn => ({
          name: m.columnName,
          type: m.columnTypeName ?? "",
          ...(m.precision !== undefined ? { precision: m.precision } : {}),
          ...(m.scale !== undefined ? { scale: m.scale } : {}),
          ...(m.isNullable !== undefined ? { nullable: m.isNullable !== 0 } : {}),
        }),
      );
      out.rows = (rs.items ?? []).map((row) => meta.map((m) => normalize(row[m.jsonColumnName], m.columnTypeName)));
    } else if (typeof item.result === "number") {
      out.rowsAffected = item.result;
    }
    if (item.binds?.length) out.outBinds = Object.fromEntries(item.binds.map((b) => [b.name, b.result]));
    return out;
  }

  async function run(
    sql: string,
    req: Omit<ExecuteRequest, "sql">,
    offset: number,
    signal?: AbortSignal,
  ): Promise<{ response: ExecuteResponse; item?: OrdsItem }> {
    const maxRows = req.maxRows ?? 500;
    // ORDS parses the text as a SQLcl script: PL/SQL needs its `/`.
    const plsql = req.category === "plsql" || /^\s*(DECLARE|BEGIN|CREATE\s+(OR\s+REPLACE\s+)?(\w+\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))\b/i.test(sql);
    const body = plsql ? `${sql}\n/` : sql;
    const script = req.captureDbmsOutput ? `SET SERVEROUTPUT ON\n${body}` : body;
    const items = await post(script, { offset, limit: maxRows, ...(req.binds ? { binds: ordsBinds(req.binds) } : {}) }, signal);
    const item = items.filter((i) => i.statementType !== "sqlplus").pop() ?? items[items.length - 1];
    if (!item) return { response: {}, item: undefined };
    const response = toResponse(item, sql);
    if (req.captureDbmsOutput) {
      const lines = (item.dbmsOutput ?? "").split("\n");
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      response.dbmsOutput = lines;
    }
    return { response, item };
  }

  return {
    stateless: true,

    async execute(req, signal) {
      const started = Date.now();
      const { response, item } = await run(req.sql, req, 0, signal);
      if (item?.resultSet?.hasMore) {
        const cursorId = randomId("ords");
        pending.set(cursorId, { sql: req.sql, binds: req.binds, offset: response.rows?.length ?? 0 });
        response.cursorId = cursorId;
      }
      response.elapsedMs = Date.now() - started;
      return response;
    },

    async fetchRows(cursorId, maxRows, signal): Promise<FetchResponse> {
      const q = pending.get(cursorId);
      if (!q) throw new OracleTransportError({ code: "CURSOR_CLOSED", message: "Cursor is closed" });
      const { response, item } = await run(q.sql, { binds: q.binds, maxRows, category: "query" }, q.offset, signal);
      const rows = response.rows ?? [];
      q.offset += rows.length;
      const hasMore = !!item?.resultSet?.hasMore;
      if (!hasMore) pending.delete(cursorId);
      return { rows, hasMore };
    },

    async closeCursor(cursorId) {
      pending.delete(cursorId);
    },

    async session(): Promise<OracleSessionInfo> {
      const { response } = await run(
        "SELECT USER, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), (SELECT version_full FROM product_component_version WHERE ROWNUM = 1) FROM dual",
        { category: "query" },
        0,
      );
      const [user, schema, version] = (response.rows?.[0] ?? []) as string[];
      return { user, currentSchema: schema, version };
    },
  };
}
