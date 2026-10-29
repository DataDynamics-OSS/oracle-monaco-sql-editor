/**
 * The connection seam between the editor and an Oracle database.
 *
 * Browsers cannot speak Oracle Net, so every transport goes through a server:
 * the oracle-monaco gateway (`createGatewayTransport`, recommended — one
 * dedicated Oracle session per user), ORDS REST-Enabled SQL
 * (`createOrdsTransport`, stateless), or an in-memory mock for tests.
 * The runner and metadata provider depend only on this interface.
 */

/** A bind value: a plain value, or a typed / OUT bind. */
export type BindValue =
  | string
  | number
  | boolean
  | null
  | {
      value?: string | number | boolean | null;
      type?: "string" | "number" | "date" | "timestamp" | "clob" | "cursor";
      dir?: "in" | "out" | "inout";
      /** Max size for OUT string binds. */
      maxSize?: number;
    };

/** Statement category, used by servers for policy (e.g. `allowDdl`). */
export type StatementCategory = "query" | "dml" | "ddl" | "plsql" | "tcl" | "other";

export interface ExecuteRequest {
  sql: string;
  /** Named (`{ id: 1 }` for `:id`) or positional (`[1]` for `:1`) binds. */
  binds?: Record<string, BindValue> | BindValue[];
  category?: StatementCategory;
  /** Rows to return with the first page (default 500). */
  maxRows?: number;
  /** Collect DBMS_OUTPUT lines produced by the call. */
  captureDbmsOutput?: boolean;
  /** Client-chosen id so the call can be cancelled with `cancel()`. */
  executionId?: string;
}

export interface OracleColumn {
  name: string;
  /** Database type name, e.g. "VARCHAR2", "NUMBER", "DATE". */
  type: string;
  precision?: number;
  scale?: number;
  nullable?: boolean;
}

export interface ExecuteResponse {
  /** Present for queries. */
  columns?: OracleColumn[];
  rows?: unknown[][];
  /** Set when more rows are available via `fetchRows`. */
  cursorId?: string;
  rowsAffected?: number;
  outBinds?: Record<string, unknown> | unknown[];
  dbmsOutput?: string[];
  /** Success with a warning, e.g. ORA-24344 (created with compilation errors). */
  warning?: OracleErrorInfo;
  elapsedMs?: number;
}

export interface FetchResponse {
  rows: unknown[][];
  /** False once the cursor is exhausted (and closed). */
  hasMore: boolean;
}

export interface OracleErrorInfo {
  /** "ORA-00942" (or a gateway code such as "SESSION_EXPIRED"). */
  code: string;
  message: string;
  /** 0-based character offset of the error in the executed statement. */
  offset?: number;
}

export interface OracleSessionInfo {
  user: string;
  currentSchema: string;
  /** e.g. "19.21.0.0.0" */
  version: string;
  /** Connect alias chosen at login (gateway). */
  connectAlias?: string;
}

export interface OracleTransport {
  /**
   * Each call runs in a fresh database session (ORDS): no transactions,
   * session state or session-private tables (PLAN_TABLE) across calls.
   */
  readonly stateless?: boolean;
  /** Execute one statement. Queries return their first page. */
  execute(req: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse>;
  /** Next page of an open cursor. */
  fetchRows?(cursorId: string, maxRows: number, signal?: AbortSignal): Promise<FetchResponse>;
  /** Close an open cursor early. */
  closeCursor?(cursorId: string): Promise<void>;
  /** Interrupt a running call (gateway: `connection.break()`). */
  cancel?(executionId: string): Promise<void>;
  /** Transaction control (session-keeping transports only). */
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  /** Current user / schema / version. */
  session?(): Promise<OracleSessionInfo>;
}

/** A failed call. `code` is the ORA code when the database raised the error. */
export class OracleTransportError extends Error implements OracleErrorInfo {
  readonly code: string;
  readonly offset?: number;
  /** HTTP status when the error came from a server. */
  readonly status?: number;

  constructor(info: OracleErrorInfo, status?: number) {
    super(info.message);
    this.name = "OracleTransportError";
    this.code = info.code;
    this.offset = info.offset;
    this.status = status;
  }
}

/** Random id for executions / statement ids (not security-sensitive). */
export function randomId(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
