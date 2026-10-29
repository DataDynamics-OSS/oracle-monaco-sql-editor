"""
oracle-monaco gateway (Python / FastAPI): per-user Oracle sessions over HTTP.

Same API and security model as the Node reference gateway in ``servers/server-node/``
(see servers/server-node/README.md and docs/DESIGN.md §8.3):

  - each user logs in with their OWN Oracle account; the gateway keeps one
    dedicated connection per browser session until logout or idle timeout
  - the password is sent once to POST /sessions and never stored; later calls
    are authorised by an httpOnly, SameSite=Strict session cookie that must
    match the session id in the URL
  - clients pick a server-configured connect alias, never a connect string
  - failed logins are rate-limited per client address + alias + user
  - servers older than ``min_version`` (19c) are refused at login
  - call timeout, row limits and DDL policy are enforced here; everything else
    is the user's own database privileges
"""
import asyncio
import contextlib
import json
import math
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated, Any, Literal, Union

from fastapi import APIRouter, Body, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from .driver import Bind, Binds, Connection, Driver, DriverError, RowSource

DEFAULT_SESSION_INIT = [
    "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
    "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
    "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'",
]

DDL = re.compile(
    r"^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE|AUDIT|NOAUDIT|PURGE|FLASHBACK|ANALYZE|ASSOCIATE|DISASSOCIATE)\b",
    re.I,
)
LEADING = re.compile(r"^(?:\s+|--[^\n]*\n?|/\*.*?\*/)*", re.S)
#: Errors that mean the connection is gone and the session must be dropped.
DEAD_CONNECTION = re.compile(r"^(ORA-0(1012|3113|3114|3135|0028)|DPY-(1001|4011))")
IDENT = re.compile(r"^(?:[A-Za-z][\w$#]{0,127}|\"[^\"]{1,128}\")$")
HELP_LINE = re.compile(r"^(Help: )?https?:")
BODY_LIMIT = 2 * 1024 * 1024


@dataclass
class ConnectTarget:
    #: Easy Connect string or TNS alias, e.g. "db-host:1521/ORCLPDB1".
    connect_string: str
    #: Shown in the login form.
    label: str | None = None


@dataclass
class GatewayOptions:
    driver: Driver
    #: The only databases clients may connect to, by alias.
    connect_aliases: dict[str, ConnectTarget]
    prefix: str = "/api"
    idle_timeout_ms: int = 30 * 60_000
    max_sessions_per_user: int = 3
    #: Per round-trip timeout; 0 disables.
    call_timeout_ms: int = 5 * 60_000
    default_max_rows: int = 500
    max_rows_cap: int = 5000
    allow_ddl: bool = True
    min_version: int = 19
    #: Disable only for local http development.
    secure_cookie: bool = True
    cookie_name: str = "omsid"
    #: Also accept X-Session-Id (non-browser clients).
    allow_header_auth: bool = False
    session_init: list[str] = field(default_factory=lambda: list(DEFAULT_SESSION_INIT))
    #: Failed logins allowed per client + user within the window.
    login_rate_limit: tuple[int, int] = (5, 60_000)
    #: Serve the OpenAPI schema and Swagger UI under {prefix}/docs.
    docs: bool = False


# ------------------------------------------------------------ request bodies


class _Body(BaseModel):
    model_config = ConfigDict(extra="ignore")


class LoginBody(_Body):
    connectAlias: str
    user: str
    password: str


class BindSpec(_Body):
    value: Any = None
    type: Literal["string", "number", "date", "timestamp", "clob", "cursor"] | None = None
    dir: Literal["in", "out", "inout"] = "in"
    maxSize: int | None = None


BindValue = Union[BindSpec, str, int, float, bool, None]


class ExecuteBody(_Body):
    sql: str
    binds: dict[str, BindValue] | list[BindValue] | None = None
    maxRows: float | None = None
    captureDbmsOutput: bool = False
    executionId: str | None = None


class FetchBody(_Body):
    maxRows: float | None = None


class CancelBody(_Body):
    executionId: str | None = None


# ------------------------------------------------------------ sessions


@dataclass
class _Cursor:
    rows: RowSource
    types: list[str | None]


@dataclass
class _Session:
    id: str
    user: str
    connect_alias: str
    conn: Connection
    current_schema: str
    version: str
    last_used: float
    cursors: dict[str, _Cursor] = field(default_factory=dict)
    running: set[str] = field(default_factory=set)
    dbms_output_enabled: bool = False
    #: One round trip at a time per connection (cancel bypasses it).
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, offset: int | None = None):
        super().__init__(message)
        self.status = status
        self.body: dict[str, Any] = {"code": code, "message": message}
        if offset is not None:
            self.body["offset"] = offset


def _now_ms() -> float:
    return time.monotonic() * 1000


def to_api_error(e: BaseException) -> dict[str, Any]:
    code = e.code if isinstance(e, DriverError) else "GATEWAY_ERROR"
    raw = e.message if isinstance(e, DriverError) else str(e)
    message = "\n".join(l for l in raw.split("\n") if not HELP_LINE.match(l.strip())).strip()
    out: dict[str, Any] = {"code": code, "message": message}
    offset = e.offset if isinstance(e, DriverError) else None
    if code.startswith("ORA-") and isinstance(offset, int) and offset > 0:
        out["offset"] = offset
    return out


def _wall_clock(d: datetime, fraction: bool) -> str:
    base = d.strftime("%Y-%m-%d %H:%M:%S")
    return f"{base}.{d.microsecond // 1000:03d}" if fraction else base


def _iso_instant(d: datetime) -> str:
    u = d.astimezone(timezone.utc)
    return u.strftime("%Y-%m-%dT%H:%M:%S.") + f"{u.microsecond // 1000:03d}Z"


def cell(v: Any, db_type: str | None) -> Any:
    """JSON-safe cell values: NUMBER exact text, RAW/BLOB hex, dates as text."""
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex().upper()
    if isinstance(v, datetime):
        if v.tzinfo is not None:
            return _iso_instant(v)  # WITH TIME ZONE: an absolute instant
        # DATE / TIMESTAMP (and LOCAL TIME ZONE, in the session time zone)
        return _wall_clock(v, db_type != "DATE" and (db_type is not None or v.microsecond != 0))
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return format(v, "f")
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    if isinstance(v, timedelta):
        return str(v)
    if isinstance(v, (list, tuple)):
        return [cell(x, None) for x in v]
    if isinstance(v, dict):
        return {k: cell(x, None) for k, x in v.items()}
    return v


def rows_out(rows: list[list[Any]], types: list[str | None]) -> list[list[Any]]:
    return [[cell(v, types[i] if i < len(types) else None) for i, v in enumerate(r)] for r in rows]


def _json(body: Any, status: int = 200) -> Response:
    # Cells are already JSON-safe; skip FastAPI's per-value jsonable_encoder walk.
    text = json.dumps(body, ensure_ascii=False, separators=(",", ":"), default=str)
    return Response(text, status_code=status, media_type="application/json")


def _error(status: int, code: str, message: str) -> Response:
    return _json({"error": {"code": code, "message": message}}, status)


def _to_binds(raw: dict[str, BindValue] | list[BindValue] | None) -> Binds:
    def one(b: BindValue) -> Bind:
        if isinstance(b, BindSpec):
            return Bind(value=b.value, type=b.type, dir=b.dir, max_size=b.maxSize)
        return Bind(value=b)

    if isinstance(raw, list):
        return [one(b) for b in raw]
    if isinstance(raw, dict):
        return {k: one(v) for k, v in raw.items()}
    return None


def create_gateway(options: GatewayOptions) -> FastAPI:
    o = options
    sessions: dict[str, _Session] = {}
    failures: dict[str, list[float]] = {}  # key -> [count, reset_at_ms]
    max_failures, window_ms = o.login_rate_limit

    def rows_param(v: float | None) -> int:
        n = v if v is not None and math.isfinite(v) else o.default_max_rows
        return max(1, min(o.max_rows_cap, math.floor(n)))

    async def close_session(s: _Session) -> None:
        sessions.pop(s.id, None)
        if s.running:
            with contextlib.suppress(Exception):
                s.conn.cancel()
        async with s.lock:
            for c in s.cursors.values():
                with contextlib.suppress(Exception):
                    await c.rows.close()
            s.cursors.clear()
            with contextlib.suppress(Exception):
                await s.conn.rollback()
            with contextlib.suppress(Exception):
                await s.conn.close()

    async def sweeper() -> None:
        interval = min(60.0, max(1.0, o.idle_timeout_ms / 2000))
        while True:
            await asyncio.sleep(interval)
            now = _now_ms()
            for s in list(sessions.values()):
                if not s.running and now - s.last_used > o.idle_timeout_ms:
                    await close_session(s)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = asyncio.create_task(sweeper())
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await asyncio.gather(*(close_session(s) for s in list(sessions.values())))

    def session_for(id: str, request: Request) -> _Session:
        """Dependency: resolve and authorise the session named in the URL."""
        from_cookie = request.cookies.get(o.cookie_name)
        from_header = request.headers.get("x-session-id") if o.allow_header_auth else None
        s = sessions.get(id)
        if not s or (from_cookie != id and from_header != id):
            raise ApiError(401, "SESSION_EXPIRED", "Not connected or session expired")
        s.last_used = _now_ms()
        return s

    SessionDep = Annotated[_Session, Depends(session_for)]

    async def db_error(s: _Session, e: BaseException) -> ApiError:
        """Map a driver error; drop the session when the connection is dead."""
        err = to_api_error(e)
        if DEAD_CONNECTION.match(err["code"]):
            await close_session(s)
            return ApiError(401, "SESSION_LOST", f"Database connection lost: {err['message']}")
        return ApiError(422, err["code"], err["message"], err.get("offset"))

    async def query_one(conn: Connection, sql: str) -> list[Any]:
        r = await conn.execute(sql, None, 1)
        if not r.cursor:
            return []
        try:
            rows = await r.cursor.fetch(1)
        finally:
            await r.cursor.close()
        return list(rows[0]) if rows else []

    # ---------------------------------------------------------------- routes

    api = APIRouter(prefix=o.prefix)

    @api.get("/aliases")
    async def aliases() -> Response:
        return _json([{"alias": a, "label": t.label or a} for a, t in o.connect_aliases.items()])

    @api.post("/sessions")
    async def login(body: LoginBody, request: Request) -> Response:
        alias, user, password = body.connectAlias, body.user, body.password
        target = o.connect_aliases.get(alias)
        if not target:
            raise ApiError(400, "UNKNOWN_ALIAS", f"Unknown connect alias '{alias}'")
        if not IDENT.match(user) or not 0 < len(password) <= 1024:
            raise ApiError(400, "BAD_REQUEST", "Invalid user name or password")

        key = f"{request.client.host if request.client else ''}|{alias}|{user.upper()}"
        f = failures.get(key)
        if f and f[1] > _now_ms() and f[0] >= max_failures:
            raise ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed logins; try again later")
        open_count = sum(1 for s in sessions.values() if s.connect_alias == alias and s.user == user.upper())
        if open_count >= o.max_sessions_per_user:
            raise ApiError(429, "TOO_MANY_SESSIONS", f"At most {o.max_sessions_per_user} sessions per user")

        try:
            conn = await o.driver.connect(user, password, target.connect_string)
        except Exception as e:  # noqa: BLE001 — every failure counts towards the limit
            err = to_api_error(e)
            entry = f if f and f[1] > _now_ms() else [0, _now_ms() + window_ms]
            entry[0] += 1
            failures[key] = entry
            if err["code"] == "ORA-01017":
                raise ApiError(401, "INVALID_CREDENTIALS", "Invalid user name or password") from None
            if err["code"] == "ORA-28000":
                raise ApiError(403, "ACCOUNT_LOCKED", err["message"]) from None
            if err["code"] == "ORA-28001":
                raise ApiError(403, "PASSWORD_EXPIRED", err["message"]) from None
            raise ApiError(502, err["code"], err["message"]) from None
        failures.pop(key, None)

        m = re.match(r"\d+", conn.version)
        if (int(m.group(0)) if m else 0) < o.min_version:
            with contextlib.suppress(Exception):
                await conn.close()
            raise ApiError(
                400,
                "ORACLE_VERSION_UNSUPPORTED",
                f"Oracle {conn.version} is not supported (minimum {o.min_version}c)",
            )

        try:
            if o.call_timeout_ms > 0:
                conn.set_call_timeout(o.call_timeout_ms)
            for sql in o.session_init:
                await conn.execute(sql)
            who = await query_one(conn, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), USER FROM dual")
        except Exception as e:  # noqa: BLE001
            with contextlib.suppress(Exception):
                await conn.close()
            err = to_api_error(e)
            raise ApiError(502, err["code"], err["message"]) from None

        s = _Session(
            id=secrets.token_urlsafe(24),
            user=(who[1] if len(who) > 1 and who[1] else user.upper()),
            connect_alias=alias,
            conn=conn,
            current_schema=(who[0] if who and who[0] else user.upper()),
            version=conn.version,
            last_used=_now_ms(),
        )
        sessions[s.id] = s
        out: dict[str, Any] = {
            "sessionId": s.id,
            "user": s.user,
            "currentSchema": s.current_schema,
            "version": s.version,
            "connectAlias": alias,
        }
        if conn.warning:
            out["warning"] = to_api_error(conn.warning)
        res = _json(out)
        res.set_cookie(
            o.cookie_name, s.id, httponly=True, samesite="strict", secure=o.secure_cookie, path=o.prefix
        )
        return res

    @api.get("/sessions/{id}")
    async def get_session(s: SessionDep) -> Response:
        try:
            async with s.lock:
                row = await query_one(s.conn, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual")
            if row and row[0]:
                s.current_schema = str(row[0])
        except Exception as e:  # noqa: BLE001
            raise await db_error(s, e) from None
        return _json(
            {"user": s.user, "currentSchema": s.current_schema, "version": s.version, "connectAlias": s.connect_alias}
        )

    @api.delete("/sessions/{id}", status_code=204)
    async def delete_session(s: SessionDep) -> Response:
        await close_session(s)
        res = Response(status_code=204)
        res.delete_cookie(o.cookie_name, path=o.prefix)
        return res

    @api.post("/sessions/{id}/execute")
    async def execute(s: SessionDep, body: ExecuteBody) -> Response:
        sql = body.sql
        if not sql.strip():
            raise ApiError(400, "BAD_REQUEST", "sql is required")
        if not o.allow_ddl and DDL.match(LEADING.sub("", sql, count=1)):
            raise ApiError(403, "DDL_NOT_ALLOWED", "DDL is disabled on this gateway")
        max_rows = rows_param(body.maxRows)
        execution_id = body.executionId or secrets.token_hex(8)
        capture = body.captureDbmsOutput

        s.running.add(execution_id)
        started = _now_ms()
        try:
            async with s.lock:
                if capture and not s.dbms_output_enabled:
                    await s.conn.execute("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;")
                    s.dbms_output_enabled = True
                result = await s.conn.execute(sql, _to_binds(body.binds), min(max_rows, 1000))

                out: dict[str, Any] = {}
                if result.cursor:
                    rows = await result.cursor.fetch(max_rows)
                    types = [c.type for c in result.columns]
                    columns = []
                    for c in result.columns:
                        col: dict[str, Any] = {"name": c.name, "type": c.type or ""}
                        if c.precision is not None:
                            col["precision"] = c.precision
                        if c.scale is not None:
                            col["scale"] = c.scale
                        if c.nullable is not None:
                            col["nullable"] = c.nullable
                        columns.append(col)
                    out["columns"] = columns
                    out["rows"] = rows_out(rows, types)
                    if len(rows) == max_rows:
                        cursor_id = secrets.token_hex(8)
                        s.cursors[cursor_id] = _Cursor(result.cursor, types)
                        out["cursorId"] = cursor_id
                    else:
                        await result.cursor.close()
                else:
                    if result.rows_affected is not None:
                        out["rowsAffected"] = result.rows_affected
                    if result.out_binds is not None:
                        out["outBinds"] = cell(result.out_binds, None)
                if result.warning:
                    out["warning"] = to_api_error(result.warning)
                if capture:
                    out["dbmsOutput"] = await s.conn.dbms_output()
            out["elapsedMs"] = round(_now_ms() - started)
            return _json(out)
        except ApiError:
            raise
        except Exception as e:  # noqa: BLE001
            raise await db_error(s, e) from None
        finally:
            s.running.discard(execution_id)

    @api.post("/sessions/{id}/cursors/{cid}/fetch")
    async def fetch(s: SessionDep, cid: str, body: Annotated[FetchBody | None, Body()] = None) -> Response:
        cur = s.cursors.get(cid)
        if not cur:
            raise ApiError(404, "CURSOR_CLOSED", "Cursor is closed")
        max_rows = rows_param(body.maxRows if body else None)
        try:
            async with s.lock:
                rows = await cur.rows.fetch(max_rows)
                has_more = len(rows) == max_rows
                if not has_more:
                    s.cursors.pop(cid, None)
                    await cur.rows.close()
            return _json({"rows": rows_out(rows, cur.types), "hasMore": has_more})
        except Exception as e:  # noqa: BLE001
            s.cursors.pop(cid, None)
            raise await db_error(s, e) from None

    @api.delete("/sessions/{id}/cursors/{cid}", status_code=204)
    async def close_cursor(s: SessionDep, cid: str) -> Response:
        cur = s.cursors.pop(cid, None)
        if cur:
            async with s.lock:
                with contextlib.suppress(Exception):
                    await cur.rows.close()
        return Response(status_code=204)

    @api.post("/sessions/{id}/cancel", status_code=204)
    async def cancel(s: SessionDep, body: Annotated[CancelBody | None, Body()] = None) -> Response:
        # cancel() interrupts whatever the connection is running right now.
        if body and body.executionId and body.executionId in s.running:
            with contextlib.suppress(Exception):
                s.conn.cancel()
        return Response(status_code=204)

    @api.post("/sessions/{id}/{action}", status_code=204)
    async def transaction(s: SessionDep, action: Literal["commit", "rollback"]) -> Response:
        try:
            async with s.lock:
                await (s.conn.commit() if action == "commit" else s.conn.rollback())
        except Exception as e:  # noqa: BLE001
            raise await db_error(s, e) from None
        return Response(status_code=204)

    # ---------------------------------------------------------------- app

    app = FastAPI(
        title="oracle-monaco gateway",
        lifespan=lifespan,
        docs_url=f"{o.prefix}/docs" if o.docs else None,
        redoc_url=None,
        openapi_url=f"{o.prefix}/openapi.json" if o.docs else None,
    )
    app.include_router(api)

    @app.middleware("http")
    async def body_limit(request: Request, call_next: Any) -> Response:
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > BODY_LIMIT:
            return _error(413, "BODY_TOO_LARGE", "Request body too large")
        return await call_next(request)

    # Every failure as { error: { code, message } }, like the Node gateway.
    @app.exception_handler(ApiError)
    async def api_error(_request: Request, e: ApiError) -> Response:
        return _json({"error": e.body}, e.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_body(_request: Request, e: RequestValidationError) -> Response:
        errors = e.errors()
        if any(err.get("type") == "json_invalid" for err in errors):
            return _error(400, "BAD_REQUEST", "Invalid JSON body")
        if any(err.get("loc", [None])[0] == "path" for err in errors):
            return _error(404, "NOT_FOUND", "Not found")
        fields = sorted({".".join(str(p) for p in err.get("loc", [])[1:]) or "body" for err in errors})
        return _error(400, "BAD_REQUEST", f"Invalid request body: {', '.join(fields)}")

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, e: StarletteHTTPException) -> Response:
        if e.status_code == 404:
            return _error(404, "NOT_FOUND", f"Route {request.method}:{request.url.path} not found")
        if e.status_code == 405:
            return _error(405, "METHOD_NOT_ALLOWED", "Method not allowed")
        return _error(e.status_code, f"HTTP_{e.status_code}", str(e.detail))

    return app
