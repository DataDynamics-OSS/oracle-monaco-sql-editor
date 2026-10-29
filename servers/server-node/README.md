# oracle-monaco gateway

Reference HTTP gateway for `@datadynamics/oracle-monaco`: **one dedicated Oracle session per logged-in user**, served over a small JSON API.
Fastify + [node-oracledb](https://node-oracledb.readthedocs.io/) in **Thin mode** (no Oracle Client libraries needed).

Browsers cannot speak Oracle Net, so the editor's `createGatewayTransport()` talks to this service, which holds the connection.

The same API is also implemented in Python ([`../server-python`](../server-python/README.md), FastAPI + python-oracledb) and Java ([`../server-java`](../server-java/README.md), Spring Boot + ojdbc11); this README is the API and security reference for all three.

## Run

```bash
cd servers/server-node
npm install
CONNECT_ALIASES='{"dev":{"connectString":"db-host:1521/ORCLPDB1","label":"Development"}}' npm start
```

| Variable | Default | |
|---|---|---|
| `CONNECT_ALIASES` | — (required) | JSON `{ alias: { connectString, label? } }`. Clients pick an alias; they never send a connect string. |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `8787` | |
| `GATEWAY_PREFIX` | `/api` | Route prefix (also the cookie path). |
| `SECURE_COOKIE` | `true` | Set `false` **only** for local http development. |
| `ALLOW_DDL` | `true` | `false` rejects CREATE / ALTER / DROP / TRUNCATE / GRANT … (statement text check; PL/SQL `EXECUTE IMMEDIATE` is not inspected — rely on database privileges). |
| `IDLE_TIMEOUT_MIN` | `30` | Idle sessions are rolled back and closed. |
| `CALL_TIMEOUT_SEC` | `300` | `connection.callTimeout` per round trip; `0` disables. |
| `MAX_SESSIONS_PER_USER` | `3` | Per alias + user (browser tabs). |
| `ALLOW_HEADER_AUTH` | `false` | Accept `X-Session-Id` instead of the cookie (CLIs, Node tests). |

Run it behind an HTTPS reverse proxy on the same origin as the web app (the session cookie is `SameSite=Strict`).

## Security model

- Users log in with **their own Oracle account**; privileges, VPD and auditing apply per user.
- The password is sent once to `POST /sessions`, used to open the connection and never stored or logged.
- Later calls are authorised by an `httpOnly`, `SameSite=Strict`, `Secure` cookie that must equal the session id in the URL.
- Failed logins are rate-limited per client address + alias + user (5 per minute); ORA-01017 / 28000 / 28001 map to `INVALID_CREDENTIALS` / `ACCOUNT_LOCKED` / `PASSWORD_EXPIRED`.
- Databases older than **19c** are refused at login (`ORACLE_VERSION_UNSUPPORTED`).
- A lost connection (ORA-03113 etc.) drops the session (`SESSION_LOST`, 401).

## API (prefix `/api`)

| Method | Path | Body → Response |
|---|---|---|
| `GET` | `/aliases` | → `[{ alias, label }]` |
| `POST` | `/sessions` | `{ connectAlias, user, password }` → `{ sessionId, user, currentSchema, version, connectAlias, warning? }` + cookie |
| `GET` | `/sessions/:id` | → `{ user, currentSchema, version, connectAlias }` |
| `DELETE` | `/sessions/:id` | rollback + close → 204 |
| `POST` | `/sessions/:id/execute` | `{ sql, binds?, maxRows?, captureDbmsOutput?, executionId? }` → `{ columns?, rows?, cursorId?, rowsAffected?, outBinds?, dbmsOutput?, warning?, elapsedMs }` |
| `POST` | `/sessions/:id/cursors/:cid/fetch` | `{ maxRows? }` → `{ rows, hasMore }` |
| `DELETE` | `/sessions/:id/cursors/:cid` | → 204 |
| `POST` | `/sessions/:id/cancel` | `{ executionId }` → 204 (`connection.break()`; the call fails with ORA-01013) |
| `POST` | `/sessions/:id/commit` · `/rollback` | → 204 |

Errors: `{ error: { code, message, offset? } }` — SQL errors are `422` with the ORA code and the 0-based `offset` of the error in the statement.

Values: `NUMBER` as exact strings, `DATE` / `TIMESTAMP` as `YYYY-MM-DD HH24:MI:SS[.FFF]`, time-zone timestamps as ISO instants, `RAW` / `BLOB` as hex, `CLOB` inline. Nothing is auto-committed.

## Test

```bash
npm test              # HTTP / session / auth tests against a fake driver (no database)
```

The repository root has `npm run test:live`, which drives this gateway against a real database (see the root README).
