"""Gateway HTTP / session / auth tests against a fake driver (no database). Run: pytest (in servers/server-python/)"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict
from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient

from oracle_monaco_gateway import (
    Column,
    ConnectTarget,
    DriverError,
    ExecuteResult,
    GatewayOptions,
    create_gateway,
)


def ora_error(num: int, message: str, offset: int | None = None) -> DriverError:
    code = f"ORA-{num:05d}"
    return DriverError(code, f"{code}: {message}\nHelp: https://docs.oracle.com/error-help/db/ora-{num}/", offset)


class FakeRows:
    def __init__(self, rows: list[list[Any]]):
        self.rows = rows
        self.closed = False

    async def fetch(self, n: int) -> list[list[Any]]:
        out, self.rows = self.rows[:n], self.rows[n:]
        return out

    async def close(self) -> None:
        self.closed = True


class FakeConn:
    def __init__(self, user: str):
        self.user = user
        self.log: list[str] = []
        self.closed = False
        self.rolled_back = 0
        self.version = "12.2.0.1.0" if user == "old" else "19.3.0.0.0"
        self.warning = None
        self.call_timeout = 0

    def set_call_timeout(self, ms: int) -> None:
        self.call_timeout = ms

    async def execute(self, sql: str, binds: Any = None, fetch_size: int = 100) -> ExecuteResult:
        self.log.append(sql)
        if "SYS_CONTEXT" in sql:
            return ExecuteResult(columns=[Column("A", "VARCHAR2")], cursor=FakeRows([[self.user.upper(), self.user.upper()]]))
        if "FROM big" in sql:
            rows = [[Decimal(i + 1), datetime(2024, 2, 29, 13, 14, 15), bytes([10, 255])] for i in range(7)]
            return ExecuteResult(
                columns=[Column("N", "NUMBER"), Column("D", "DATE"), Column("R", "RAW")], cursor=FakeRows(rows)
            )
        if "no_such" in sql:
            raise ora_error(942, "table or view does not exist", 14)
        if "lost" in sql:
            raise ora_error(3113, "end-of-file on communication channel")
        if sql.startswith("UPDATE"):
            return ExecuteResult(rows_affected=3)
        if ":x" in sql:
            return ExecuteResult(out_binds={"echo": json.dumps({k: asdict(v) for k, v in binds.items()})})
        return ExecuteResult()

    async def dbms_output(self) -> list[str]:
        self.log.append("GET_LINES")
        return ["a", "b"]

    def cancel(self) -> None:
        self.log.append("BREAK")

    async def commit(self) -> None:
        self.log.append("COMMIT")

    async def rollback(self) -> None:
        self.rolled_back += 1

    async def close(self) -> None:
        self.closed = True


class FakeDriver:
    def __init__(self) -> None:
        self.conns: list[FakeConn] = []

    async def connect(self, user: str, password: str, dsn: str) -> FakeConn:
        if password == "bad":
            raise ora_error(1017, "invalid credential or not authorized; logon denied")
        if password == "locked":
            raise ora_error(28000, "The account is locked.")
        conn = FakeConn(user)
        self.conns.append(conn)
        return conn


def setup(**extra: Any) -> tuple[TestClient, FakeDriver]:
    driver = FakeDriver()
    opts = dict(
        driver=driver,
        connect_aliases={"dev": ConnectTarget("db:1521/PDB", "Development")},
        login_rate_limit=(3, 60_000),
    )
    opts.update(extra)
    return TestClient(create_gateway(GatewayOptions(**opts))), driver


class Login:
    def __init__(self, client: TestClient, user: str = "scott", password: str = "tiger"):
        self.res = client.post("/api/sessions", json={"connectAlias": "dev", "user": user, "password": password})
        client.cookies.clear()  # every test sends credentials explicitly
        self.id = self.res.json().get("sessionId")
        self.set_cookie = self.res.headers.get("set-cookie", "")
        self.headers = {"cookie": f"omsid={self.id}"}


def code(res: Any) -> list[Any]:
    return [res.status_code, res.json()["error"]["code"]]


def test_aliases_and_login() -> None:
    client, driver = setup()
    with client:
        assert client.get("/api/aliases").json() == [{"alias": "dev", "label": "Development"}]
        s = Login(client)
        body = s.res.json()
        assert [s.res.status_code, body["user"], body["currentSchema"], body["version"]] == [200, "SCOTT", "SCOTT", "19.3.0.0.0"]
        flags = [f.strip().lower() for f in s.set_cookie.split(";")]
        assert flags[0] == f"omsid={s.id}".lower()
        assert {"httponly", "samesite=strict", "secure", "path=/api"} <= set(flags)
        assert len([l for l in driver.conns[0].log if "NLS_DATE_FORMAT" in l]) == 1
        assert driver.conns[0].call_timeout == 300_000

        unknown = client.post("/api/sessions", json={"connectAlias": "prod", "user": "a", "password": "b"})
        assert code(unknown) == [400, "UNKNOWN_ALIAS"]
        injected = client.post("/api/sessions", json={"connectAlias": "dev", "user": "x/y@other", "password": "b"})
        assert injected.status_code == 400
        assert code(Login(client, "scott", "bad").res) == [401, "INVALID_CREDENTIALS"]
        assert code(Login(client, "scott", "locked").res) == [403, "ACCOUNT_LOCKED"]
        Login(client, "scott", "bad")
        assert code(Login(client, "scott", "tiger").res) == [429, "TOO_MANY_ATTEMPTS"]
        assert code(Login(client, "old").res) == [400, "ORACLE_VERSION_UNSUPPORTED"]
        assert driver.conns[-1].closed


def test_max_sessions_per_user() -> None:
    client, _ = setup(max_sessions_per_user=2)
    with client:
        Login(client)
        Login(client)
        assert code(Login(client).res) == [429, "TOO_MANY_SESSIONS"]


def test_authorisation() -> None:
    client, _ = setup()
    with client:
        a, b = Login(client, "alice"), Login(client, "bob")

        def exec_(sid: str, headers: dict[str, str]) -> int:
            return client.post(f"/api/sessions/{sid}/execute", headers=headers, json={"sql": "SELECT 1 FROM dual"}).status_code

        assert exec_(a.id, a.headers) == 200
        assert exec_(a.id, {}) == 401
        assert exec_(b.id, a.headers) == 401  # someone else's session id with my cookie
        assert exec_(a.id, {"x-session-id": a.id}) == 401  # header auth off by default

    client, _ = setup(allow_header_auth=True)
    with client:
        a = Login(client)
        r = client.post(f"/api/sessions/{a.id}/execute", headers={"x-session-id": a.id}, json={"sql": "SELECT 1 FROM dual"})
        assert r.status_code == 200


def test_execute() -> None:
    client, driver = setup()
    with client:
        s = Login(client)

        def exec_(payload: dict[str, Any]) -> Any:
            return client.post(f"/api/sessions/{s.id}/execute", headers=s.headers, json=payload)

        def fetch(cid: str, payload: dict[str, Any]) -> Any:
            return client.post(f"/api/sessions/{s.id}/cursors/{cid}/fetch", headers=s.headers, json=payload)

        q = exec_({"sql": "SELECT * FROM big", "maxRows": 3}).json()
        assert [f"{c['name']}:{c['type']}" for c in q["columns"]] == ["N:NUMBER", "D:DATE", "R:RAW"]
        assert q["rows"][0] == ["1", "2024-02-29 13:14:15", "0AFF"]  # NUMBER exact text, DATE wall clock, RAW hex
        assert isinstance(q["cursorId"], str)
        page = fetch(q["cursorId"], {"maxRows": 3}).json()
        assert [len(page["rows"]), page["hasMore"]] == [3, True]
        last = fetch(q["cursorId"], {"maxRows": 3}).json()
        assert [len(last["rows"]), last["hasMore"]] == [1, False]  # last page closes the cursor
        assert fetch(q["cursorId"], {}).status_code == 404

        err = exec_({"sql": "SELECT * FROM no_such"})
        assert [err.status_code, err.json()["error"]] == [
            422,
            {"code": "ORA-00942", "message": "ORA-00942: table or view does not exist", "offset": 14},
        ]
        assert exec_({"sql": "UPDATE t SET a = 1"}).json()["rowsAffected"] == 3
        out = exec_({"sql": "BEGIN NULL; END;", "captureDbmsOutput": True}).json()
        assert out["dbmsOutput"] == ["a", "b"]
        exec_({"sql": "BEGIN NULL; END;", "captureDbmsOutput": True})
        assert len([l for l in driver.conns[0].log if "ENABLE" in l]) == 1  # enabled once

        b = exec_({"sql": "BEGIN :x := 1; END;", "binds": {"x": {"dir": "out", "type": "number"}, "y": 5, "z": {"value": "s"}}}).json()
        assert json.loads(b["outBinds"]["echo"]) == {
            "x": {"value": None, "type": "number", "dir": "out", "max_size": None},
            "y": {"value": 5, "type": None, "dir": "in", "max_size": None},
            "z": {"value": "s", "type": None, "dir": "in", "max_size": None},
        }
        assert exec_({"sql": "  "}).status_code == 400

        commit = client.post(f"/api/sessions/{s.id}/commit", headers=s.headers)
        assert [commit.status_code, "COMMIT" in driver.conns[0].log] == [204, True]

        lost = exec_({"sql": "SELECT lost FROM dual"})
        assert code(lost) == [401, "SESSION_LOST"]
        assert [exec_({"sql": "SELECT 1 FROM dual"}).status_code, driver.conns[0].closed] == [401, True]


def test_ddl_blocked_when_disabled() -> None:
    client, _ = setup(allow_ddl=False)
    with client:
        s = Login(client)
        r = client.post(f"/api/sessions/{s.id}/execute", headers=s.headers, json={"sql": "-- c\n  drop table t"})
        assert code(r) == [403, "DDL_NOT_ALLOWED"]


def test_cancel_logout_idle_timeout() -> None:
    client, driver = setup(idle_timeout_ms=1500)
    with client:
        s = Login(client)
        conn = driver.conns[0]
        cancel = client.post(f"/api/sessions/{s.id}/cancel", headers=s.headers, json={"executionId": "nope"})
        assert [cancel.status_code, "BREAK" in conn.log] == [204, False]  # cancel of an idle execution is a no-op
        out = client.delete(f"/api/sessions/{s.id}", headers=s.headers)
        assert [out.status_code, conn.rolled_back > 0, conn.closed] == [204, True, True]
        assert re.match(r'omsid=(""|);', out.headers["set-cookie"])  # cookie cleared

        t = Login(client)
        time.sleep(2.6)
        assert [driver.conns[1].closed, driver.conns[1].rolled_back > 0] == [True, True]  # idle session swept
        assert client.get(f"/api/sessions/{t.id}", headers=t.headers).status_code == 401


def test_errors_are_json() -> None:
    client, _ = setup()
    with client:
        assert code(client.get("/api/nope")) == [404, "NOT_FOUND"]
        bad = client.post("/api/sessions", content=b"{oops", headers={"content-type": "application/json"})
        assert code(bad) == [400, "BAD_REQUEST"]
        missing = client.post("/api/sessions", json={"connectAlias": "dev"})
        assert code(missing) == [400, "BAD_REQUEST"]
        s = Login(client)
        assert code(client.post(f"/api/sessions/{s.id}/nope", headers=s.headers)) == [404, "NOT_FOUND"]
        big = client.post(f"/api/sessions/{s.id}/execute", headers=s.headers, content=b"x" * (2 * 1024 * 1024 + 1))
        assert code(big) == [413, "BODY_TOO_LARGE"]


def test_docs_off_by_default() -> None:
    client, _ = setup()
    with client:
        assert client.get("/api/docs").status_code == 404
    client, _ = setup(docs=True)
    with client:
        assert client.get("/api/openapi.json").json()["info"]["title"] == "oracle-monaco gateway"


@pytest.mark.parametrize(
    ("value", "db_type", "expected"),
    [
        (Decimal("1E+2"), "NUMBER", "100"),
        (Decimal("0.0000001"), "NUMBER", "0.0000001"),
        (datetime(2024, 1, 2, 3, 4, 5, 678000), "TIMESTAMP", "2024-01-02 03:04:05.678"),
        (datetime.fromisoformat("2024-01-02 12:00:00+09:00"), "TIMESTAMP WITH TIME ZONE", "2024-01-02T03:00:00.000Z"),
    ],
)
def test_cells(value: Any, db_type: str, expected: Any) -> None:
    from oracle_monaco_gateway.gateway import cell

    assert cell(value, db_type) == expected


def test_tz_text_parsed() -> None:
    from oracle_monaco_gateway.driver import _tz_value, type_name

    assert _tz_value("2024-01-02 12:00:00.123456789 +09:00") == datetime.fromisoformat("2024-01-02 12:00:00.123456+09:00")
    import oracledb

    assert [type_name(oracledb.DB_TYPE_VARCHAR), type_name(oracledb.DB_TYPE_TIMESTAMP_TZ), type_name(oracledb.DB_TYPE_NUMBER)] == [
        "VARCHAR2",
        "TIMESTAMP WITH TIME ZONE",
        "NUMBER",
    ]
