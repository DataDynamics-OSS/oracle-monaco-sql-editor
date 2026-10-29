/**
 * In-memory transport for tests, demos and offline development.
 *
 * Statements are answered by the first matching rule. Query results larger
 * than `maxRows` are paged through a fake cursor, so paging code paths run
 * exactly as they would against a server.
 */
import {
  OracleTransportError,
  randomId,
  type ExecuteRequest,
  type ExecuteResponse,
  type FetchResponse,
  type OracleErrorInfo,
  type OracleSessionInfo,
  type OracleTransport,
} from "./types";

export type MockReply =
  | ExecuteResponse
  | { error: OracleErrorInfo }
  | ((req: ExecuteRequest) => ExecuteResponse | { error: OracleErrorInfo } | Promise<ExecuteResponse | { error: OracleErrorInfo }>);

export interface MockRule {
  /** Matched against the SQL: substring (case-insensitive), regex, or predicate. */
  match: string | RegExp | ((sql: string) => boolean);
  reply: MockReply;
}

export interface MockTransport extends OracleTransport {
  /** Every request received, in order. */
  readonly calls: ExecuteRequest[];
  /** Add rules at runtime (checked before earlier ones). */
  on(match: MockRule["match"], reply: MockReply): void;
  committed: number;
  rolledBack: number;
  cancelled: string[];
}

export interface MockTransportOptions {
  rules?: MockRule[];
  session?: Partial<OracleSessionInfo>;
  /** Simulated latency per call in ms. */
  latencyMs?: number;
}

function matches(rule: MockRule, sql: string): boolean {
  const m = rule.match;
  if (typeof m === "string") return sql.toLowerCase().includes(m.toLowerCase());
  if (m instanceof RegExp) return m.test(sql);
  return m(sql);
}

export function createMockTransport(options: MockTransportOptions = {}): MockTransport {
  const rules: MockRule[] = [...(options.rules ?? [])];
  const cursors = new Map<string, unknown[][]>();
  const calls: ExecuteRequest[] = [];
  const sleep = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (!options.latencyMs) return resolve();
      const t = setTimeout(resolve, options.latencyMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });

  const transport: MockTransport = {
    calls,
    committed: 0,
    rolledBack: 0,
    cancelled: [],

    on(match, reply) {
      rules.unshift({ match, reply });
    },

    async execute(req, signal) {
      calls.push(req);
      await sleep(signal);
      const rule = rules.find((r) => matches(r, req.sql));
      if (!rule) return { rowsAffected: 0 };
      const reply = typeof rule.reply === "function" ? await rule.reply(req) : rule.reply;
      if ("error" in reply) throw new OracleTransportError(reply.error);

      const max = req.maxRows ?? 500;
      if (reply.rows && reply.rows.length > max) {
        const cursorId = randomId("cur");
        cursors.set(cursorId, reply.rows.slice(max));
        return { ...reply, rows: reply.rows.slice(0, max), cursorId };
      }
      return reply;
    },

    async fetchRows(cursorId, maxRows): Promise<FetchResponse> {
      const rest = cursors.get(cursorId);
      if (!rest) throw new OracleTransportError({ code: "CURSOR_CLOSED", message: "Cursor is closed" });
      const rows = rest.splice(0, maxRows);
      if (!rest.length) cursors.delete(cursorId);
      return { rows, hasMore: rest.length > 0 };
    },

    async closeCursor(cursorId) {
      cursors.delete(cursorId);
    },

    async cancel(executionId) {
      transport.cancelled.push(executionId);
    },

    async commit() {
      transport.committed++;
    },

    async rollback() {
      transport.rolledBack++;
    },

    async session() {
      return { user: "SCOTT", currentSchema: "SCOTT", version: "19.3.0.0.0", ...options.session };
    },
  };
  return transport;
}
