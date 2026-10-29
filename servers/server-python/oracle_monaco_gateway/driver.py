"""
The slice of a database driver the gateway uses, plus the python-oracledb
(Thin mode) implementation. The gateway only talks to these protocols, so tests
can run the whole HTTP layer against a fake driver without a database.

Values come back as plain Python objects (``Decimal``, ``datetime``, ``bytes``,
``str`` …); the gateway turns them into JSON cells.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, Union


class DriverError(Exception):
    """A driver / database error."""

    def __init__(self, code: str, message: str, offset: int | None = None):
        super().__init__(message)
        #: e.g. "ORA-00942", "DPY-4011"
        self.code = code
        self.message = message
        #: 0-based character offset of a parse error in the statement
        self.offset = offset


@dataclass
class Column:
    name: str
    #: Oracle type name as node-oracledb reports it, e.g. "VARCHAR2", "TIMESTAMP WITH TIME ZONE"
    type: str
    precision: int | None = None
    scale: int | None = None
    nullable: bool | None = None


@dataclass
class Bind:
    value: Any = None
    #: "string" | "number" | "date" | "timestamp" | "clob" | "cursor" | None
    type: str | None = None
    #: "in" | "out" | "inout"
    dir: str = "in"
    max_size: int | None = None


Binds = Union[dict[str, Bind], list[Bind], None]


class RowSource(Protocol):
    async def fetch(self, n: int) -> list[list[Any]]: ...
    async def close(self) -> None: ...


@dataclass
class ExecuteResult:
    columns: list[Column] = field(default_factory=list)
    #: Open cursor for queries; the gateway pages and closes it.
    cursor: RowSource | None = None
    rows_affected: int | None = None
    out_binds: dict[str, Any] | list[Any] | None = None
    #: Success with info, e.g. ORA-24344 "success with compilation error".
    warning: DriverError | None = None


class Connection(Protocol):
    #: e.g. "19.3.0.0.0"
    version: str
    #: Set after login when the password is about to expire (ORA-28002).
    warning: DriverError | None

    def set_call_timeout(self, ms: int) -> None: ...
    async def execute(self, sql: str, binds: Binds = None, fetch_size: int = 100) -> ExecuteResult: ...
    async def dbms_output(self) -> list[str]: ...
    def cancel(self) -> None: ...
    async def commit(self) -> None: ...
    async def rollback(self) -> None: ...
    async def close(self) -> None: ...


class Driver(Protocol):
    async def connect(self, user: str, password: str, dsn: str) -> Connection: ...


# ------------------------------------------------------------ python-oracledb

_TYPE_NAMES = {
    "VARCHAR": "VARCHAR2",
    "NVARCHAR": "NVARCHAR2",
    "TIMESTAMP_TZ": "TIMESTAMP WITH TIME ZONE",
    "TIMESTAMP_LTZ": "TIMESTAMP WITH LOCAL TIME ZONE",
    "LONG_RAW": "LONG RAW",
    "LONG_NVARCHAR": "LONG",
    "INTERVAL_DS": "INTERVAL DAY TO SECOND",
    "INTERVAL_YM": "INTERVAL YEAR TO MONTH",
}

_DML = re.compile(r"^(INSERT|UPDATE|DELETE|MERGE)\b", re.I)
_LEADING = re.compile(r"^(?:\s+|--[^\n]*\n?|/\*.*?\*/)*", re.S)
# NLS_TIMESTAMP_TZ_FORMAT set at login: 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'
_TZ_TEXT = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:\.(\d+))? ([+-]\d\d:\d\d)$")


def type_name(db_type: Any) -> str:
    name = getattr(db_type, "name", str(db_type)).removeprefix("DB_TYPE_")
    return _TYPE_NAMES.get(name, name.replace("_", " "))


def _tz_value(text: str | None) -> Any:
    """TIMESTAMP WITH TIME ZONE text → aware datetime (text unchanged if unparsable)."""
    if text is None:
        return None
    m = _TZ_TEXT.match(text)
    if not m:
        return text
    frac = (m.group(2) or "0")[:6].ljust(6, "0")
    return datetime.fromisoformat(f"{m.group(1)}.{frac}{m.group(3)}")


def _wrap(e: Exception) -> DriverError:
    err = e.args[0] if e.args else e
    code = getattr(err, "full_code", None) or "GATEWAY_ERROR"
    message = getattr(err, "message", None) or str(e)
    offset = getattr(err, "offset", None)
    return DriverError(code, message, offset if isinstance(offset, int) else None)


class OracledbDriver:
    """python-oracledb in Thin mode (no Oracle Client libraries)."""

    def __init__(self) -> None:
        import oracledb

        self._oracledb = oracledb
        # NUMBER exact (Decimal → string in the gateway), LOBs inline.
        oracledb.defaults.fetch_decimals = True
        oracledb.defaults.fetch_lobs = False

    async def connect(self, user: str, password: str, dsn: str) -> Connection:
        try:
            conn = await self._oracledb.connect_async(user=user, password=password, dsn=dsn)
        except self._oracledb.Error as e:
            raise _wrap(e) from e
        return _OracledbConnection(self._oracledb, conn)


class _OracledbRows:
    def __init__(self, cursor: Any, converters: list[Any]):
        self._cursor = cursor
        self._converters = converters

    async def fetch(self, n: int) -> list[list[Any]]:
        rows = await self._cursor.fetchmany(n)
        conv = self._converters
        return [[c(v) if c else v for v, c in zip(r, conv)] for r in rows]

    async def close(self) -> None:
        self._cursor.close()


class _OracledbConnection:
    def __init__(self, oracledb: Any, conn: Any):
        self._db = oracledb
        self._conn = conn
        self.version: str = conn.version
        self.warning = _wrap(conn.warning) if getattr(conn, "warning", None) else None

    def set_call_timeout(self, ms: int) -> None:
        self._conn.call_timeout = ms

    def _output_type_handler(self, cursor: Any, metadata: Any) -> Any:
        if metadata.type_code is self._db.DB_TYPE_TIMESTAMP_TZ:
            return cursor.var(self._db.DB_TYPE_VARCHAR, arraysize=cursor.arraysize)
        return None

    def _bind_vars(self, cursor: Any, binds: Binds) -> tuple[Any, dict[Any, Any]]:
        """Driver bind values, plus the out variables by name / index."""
        db = self._db
        outs: dict[Any, Any] = {}

        def one(key: Any, b: Bind) -> Any:
            if b.dir == "in":
                return b.value
            if b.type == "number":
                var = cursor.var(db.DB_TYPE_NUMBER)
            elif b.type in ("date", "timestamp"):
                var = cursor.var(db.DB_TYPE_DATE)
            elif b.type == "clob":
                var = cursor.var(db.DB_TYPE_CLOB)
            elif b.type == "cursor":
                var = cursor.var(db.DB_TYPE_CURSOR)
            else:
                var = cursor.var(str, b.max_size or 32767)
            if b.dir == "inout" and b.value is not None:
                var.setvalue(0, b.value)
            outs[key] = var
            return var

        if binds is None:
            return [], outs
        if isinstance(binds, list):
            return [one(i, b) for i, b in enumerate(binds)], outs
        return {k: one(k, b) for k, b in binds.items()}, outs

    async def _out_value(self, value: Any, max_rows: int = 500) -> Any:
        if isinstance(value, self._db.AsyncCursor):  # REF CURSOR → rows
            try:
                return [list(r) for r in await value.fetchmany(max_rows)]
            finally:
                value.close()
        if isinstance(value, self._db.AsyncLOB):
            return await value.read()
        return value

    async def execute(self, sql: str, binds: Binds = None, fetch_size: int = 100) -> ExecuteResult:
        cursor = self._conn.cursor()
        cursor.arraysize = fetch_size
        cursor.prefetchrows = fetch_size + 1
        cursor.outputtypehandler = self._output_type_handler
        try:
            params, outs = self._bind_vars(cursor, binds)
            await cursor.execute(sql, params)
            warning = _wrap(cursor.warning) if getattr(cursor, "warning", None) else None
            if cursor.description:
                columns = [
                    Column(d.name, type_name(d.type_code), d.precision, d.scale, d.null_ok)
                    for d in cursor.description
                ]
                converters = [_tz_value if d.type_code is self._db.DB_TYPE_TIMESTAMP_TZ else None for d in cursor.description]
                return ExecuteResult(columns=columns, cursor=_OracledbRows(cursor, converters), warning=warning)
            result = ExecuteResult(warning=warning)
            if _DML.match(_LEADING.sub("", sql, count=1)):
                result.rows_affected = cursor.rowcount
            if outs:
                values = {k: await self._out_value(v.getvalue()) for k, v in outs.items()}
                result.out_binds = (
                    [values.get(i) for i in range(len(binds))] if isinstance(binds, list) else values  # type: ignore[arg-type]
                )
            cursor.close()
            return result
        except self._db.Error as e:
            cursor.close()
            raise _wrap(e) from e

    async def dbms_output(self) -> list[str]:
        lines: list[str] = []
        batch = 500
        cursor = self._conn.cursor()
        try:
            lines_var = cursor.arrayvar(str, batch, 32767)
            n_var = cursor.var(int)
            for _ in range(1000):
                n_var.setvalue(0, batch)
                await cursor.callproc("DBMS_OUTPUT.GET_LINES", [lines_var, n_var])
                n = int(n_var.getvalue() or 0)
                lines.extend(line or "" for line in lines_var.getvalue()[:n])
                if n < batch:
                    break
            return lines
        except self._db.Error as e:
            raise _wrap(e) from e
        finally:
            cursor.close()

    def cancel(self) -> None:
        self._conn.cancel()

    async def commit(self) -> None:
        try:
            await self._conn.commit()
        except self._db.Error as e:
            raise _wrap(e) from e

    async def rollback(self) -> None:
        try:
            await self._conn.rollback()
        except self._db.Error as e:
            raise _wrap(e) from e

    async def close(self) -> None:
        try:
            await self._conn.close()
        except self._db.Error as e:
            raise _wrap(e) from e
