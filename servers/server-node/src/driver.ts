/**
 * The slice of node-oracledb the gateway uses. Declared here (the driver ships
 * no TypeScript types) and injected into `createGateway`, so tests can run the
 * whole HTTP layer against a fake driver without a database.
 */

export interface DriverError extends Error {
  /** Oracle error number, e.g. 942 for ORA-00942. */
  errorNum?: number;
  /** 0-based character offset of a parse error in the statement. */
  offset?: number;
  /** Driver error code, e.g. "NJS-..." / "DPI-..." / "ORA-00942". */
  code?: string;
}

export interface MetaData {
  name: string;
  dbTypeName?: string;
  precision?: number;
  scale?: number;
  nullable?: boolean;
}

export interface ResultSet {
  getRows(n: number): Promise<unknown[][]>;
  close(): Promise<void>;
}

export interface ExecuteResult {
  metaData?: MetaData[];
  resultSet?: ResultSet;
  rows?: unknown[][];
  rowsAffected?: number;
  outBinds?: Record<string, unknown> | unknown[];
  /** Success with info, e.g. ORA-24344 "success with compilation error". */
  warning?: DriverError;
}

export interface ExecuteOptions {
  outFormat?: number;
  resultSet?: boolean;
  fetchArraySize?: number;
  autoCommit?: boolean;
}

export interface Connection {
  execute(sql: string, binds?: unknown, options?: ExecuteOptions): Promise<ExecuteResult>;
  break(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
  /** e.g. 1903000000 for 19.3 */
  oracleServerVersion: number;
  oracleServerVersionString: string;
  callTimeout?: number;
  /** Set after login when the password is about to expire (ORA-28002). */
  warning?: DriverError;
}

export interface OracleDriver {
  getConnection(attrs: { user: string; password: string; connectString: string }): Promise<Connection>;
  /** Global fetch settings (node-oracledb exposes these as writable properties). */
  fetchAsString: unknown[];
  fetchAsBuffer: unknown[];
  OUT_FORMAT_ARRAY: number;
  BIND_IN: number;
  BIND_OUT: number;
  BIND_INOUT: number;
  STRING: unknown;
  NUMBER: unknown;
  DATE: unknown;
  CLOB: unknown;
  NCLOB: unknown;
  BLOB: unknown;
  CURSOR: unknown;
  DB_TYPE_TIMESTAMP?: unknown;
}
