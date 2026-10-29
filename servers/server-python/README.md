# oracle-monaco gateway (Python / FastAPI)

Python port of the [Node reference gateway](../server-node/README.md): **one dedicated Oracle session per logged-in user**, same JSON API, same security model, same environment variables.
[FastAPI](https://fastapi.tiangolo.com/) + uvicorn + [python-oracledb](https://python-oracledb.readthedocs.io/) in **Thin mode** (no Oracle Client libraries needed, async API).

## Run

```bash
cd servers/server-python
python3 -m venv .venv && .venv/bin/pip install -e '.[test]'
CONNECT_ALIASES='{"dev":{"connectString":"db-host:1521/ORCLPDB1","label":"Development"}}' .venv/bin/python -m oracle_monaco_gateway
```

Configuration (`CONNECT_ALIASES`, `GATEWAY_HOST` / `GATEWAY_PORT`, `GATEWAY_PREFIX`, `SECURE_COOKIE`, `ALLOW_DDL`, `IDLE_TIMEOUT_MIN`, `CALL_TIMEOUT_SEC`, `MAX_SESSIONS_PER_USER`, `ALLOW_HEADER_AUTH`), the API, the error format and the security model are exactly as in [`server-node/README.md`](../server-node/README.md).
`GATEWAY_DOCS=true` additionally serves the OpenAPI schema and Swagger UI at `{prefix}/docs` (off by default).

Embedding in your own app:

```python
from oracle_monaco_gateway import ConnectTarget, GatewayOptions, OracledbDriver, create_gateway

app = create_gateway(GatewayOptions(
    driver=OracledbDriver(),
    connect_aliases={"dev": ConnectTarget("db-host:1521/ORCLPDB1", "Development")},
))  # a FastAPI app — serve it with any ASGI server, or app.mount() it into yours
```

## Layout

| File | |
|---|---|
| `oracle_monaco_gateway/gateway.py` | FastAPI routes + Pydantic request bodies, session dependency (cookie auth), rate limit, idle sweep, cell formatting, JSON error handlers |
| `oracle_monaco_gateway/driver.py` | `Driver` / `Connection` protocols + the python-oracledb implementation |
| `oracle_monaco_gateway/__main__.py` | Env configuration, uvicorn |
| `tests/test_gateway.py` | The Node test suite ported to pytest, against a fake driver |

## Differences from the Node gateway

- Cancel uses `connection.cancel()` (the python-oracledb equivalent of `break()`); round trips on one session run one at a time (an `asyncio.Lock`), cancel bypasses the lock.
- `TIMESTAMP WITH LOCAL TIME ZONE` is returned as wall-clock text in the session time zone (python-oracledb returns it without a zone); `TIMESTAMP WITH TIME ZONE` is an ISO instant as in Node.
- Request bodies are validated by Pydantic models; a malformed body is `400 BAD_REQUEST` (FastAPI's default would be 422, which this API uses for SQL errors).
- Connection-lost errors also include `DPY-1001` / `DPY-4011`.
- `NUMBER` out-binds are exact strings as well (Node returns JS numbers).

## Test

```bash
.venv/bin/python -m pytest      # HTTP / session / auth tests against a fake driver (no database)
```

The repository root's `npm run test:live` works against this gateway too (start it with `SECURE_COOKIE=false ALLOW_HEADER_AUTH=true`).
