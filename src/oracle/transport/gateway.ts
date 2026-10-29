/**
 * Client for the oracle-monaco gateway (see `servers/`).
 *
 * The gateway keeps one dedicated Oracle session per logged-in user, so
 * transactions, `ALTER SESSION`, package state, server-side cursors and
 * cancellation (`connection.break()`) all work. Authentication is a
 * per-user Oracle login: the password is sent once to `POST /sessions`, and
 * every later call is authorised by the httpOnly session cookie the gateway
 * sets — the browser never stores credentials.
 */
import {
  OracleTransportError,
  randomId,
  type ExecuteRequest,
  type ExecuteResponse,
  type FetchResponse,
  type OracleSessionInfo,
  type OracleTransport,
} from "./types";

export interface GatewayTransportOptions {
  /** Gateway API prefix, e.g. "/api" (same-origin proxy) or "https://gw.example.com/api". */
  baseUrl?: string;
  /** Extra headers on every request (e.g. an SSO token your proxy checks). */
  headers?: Record<string, string>;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /**
   * Authenticate with an `X-Session-Id` header instead of the cookie — for
   * non-browser clients (Node tests, CLIs) without a cookie jar. The gateway
   * must enable `allowHeaderAuth`. Browsers should leave this off.
   */
  headerAuth?: boolean;
}

export interface ConnectAlias {
  alias: string;
  label?: string;
}

export interface LoginRequest {
  connectAlias: string;
  user: string;
  password: string;
}

export interface LoginResponse extends OracleSessionInfo {
  sessionId: string;
  /** e.g. ORA-28002 "password will expire" — login succeeded. */
  warning?: { code: string; message: string };
}

export interface GatewayTransport extends OracleTransport {
  /** Connect aliases configured on the gateway (for a login form). */
  aliases(): Promise<ConnectAlias[]>;
  /** Open a dedicated Oracle session as this user. */
  login(req: LoginRequest): Promise<LoginResponse>;
  /** Roll back and close the session. */
  logout(): Promise<void>;
  /** Current session id, if logged in. */
  readonly sessionId: string | undefined;
  fetchRows(cursorId: string, maxRows: number, signal?: AbortSignal): Promise<FetchResponse>;
  closeCursor(cursorId: string): Promise<void>;
  cancel(executionId: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  session(): Promise<OracleSessionInfo>;
}

export function createGatewayTransport(options: GatewayTransportOptions = {}): GatewayTransport {
  const base = (options.baseUrl ?? "/api").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error("No fetch available; pass options.fetch");
  let sessionId: string | undefined;

  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.headerAuth && sessionId) headers["X-Session-Id"] = sessionId;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = json?.error ?? { code: `HTTP_${res.status}`, message: res.statusText || "Gateway error" };
      if (res.status === 401) sessionId = undefined;
      throw new OracleTransportError(err, res.status);
    }
    return json as T;
  }

  const sessionPath = (suffix = "") => {
    if (!sessionId) throw new OracleTransportError({ code: "NOT_CONNECTED", message: "Not connected" }, 401);
    return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  };

  return {
    get sessionId() {
      return sessionId;
    },

    aliases: () => call<ConnectAlias[]>("GET", "/aliases"),

    async login(req) {
      const res = await call<LoginResponse>("POST", "/sessions", req);
      sessionId = res.sessionId;
      return res;
    },

    async logout() {
      if (!sessionId) return;
      try {
        await call("DELETE", sessionPath());
      } finally {
        sessionId = undefined;
      }
    },

    async execute(req: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse> {
      const executionId = req.executionId ?? randomId("ex");
      const onAbort = () => {
        void call("POST", sessionPath("/cancel"), { executionId }).catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await call<ExecuteResponse>("POST", sessionPath("/execute"), { ...req, executionId }, signal);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    fetchRows: (cursorId, maxRows, signal) =>
      call<FetchResponse>("POST", sessionPath(`/cursors/${encodeURIComponent(cursorId)}/fetch`), { maxRows }, signal),

    closeCursor: (cursorId) =>
      call<void>("DELETE", sessionPath(`/cursors/${encodeURIComponent(cursorId)}`)),

    cancel: (executionId) => call<void>("POST", sessionPath("/cancel"), { executionId }),

    commit: () => call<void>("POST", sessionPath("/commit")),

    rollback: () => call<void>("POST", sessionPath("/rollback")),

    session: () => call<OracleSessionInfo>("GET", sessionPath()),
  };
}
