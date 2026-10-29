"""
Start the gateway with python-oracledb (Thin mode — no Oracle Client needed).

    python -m oracle_monaco_gateway

Configuration (environment) — the same variables as the Node gateway:
  CONNECT_ALIASES   JSON: {"dev":{"connectString":"db:1521/ORCLPDB1","label":"Dev"}}  (required)
  GATEWAY_HOST      default 127.0.0.1
  GATEWAY_PORT      default 8787
  GATEWAY_PREFIX    default /api
  SECURE_COOKIE     "false" only for local http development (default true)
  ALLOW_DDL         "false" to reject DDL statements (default true)
  IDLE_TIMEOUT_MIN  default 30
  CALL_TIMEOUT_SEC  default 300 (0 disables)
  MAX_SESSIONS_PER_USER default 3
  ALLOW_HEADER_AUTH "true" to accept X-Session-Id (non-browser clients)
  GATEWAY_DOCS      "true" to serve OpenAPI / Swagger UI at {prefix}/docs (default false)

Run behind HTTPS (reverse proxy) in production.
"""
import json
import os
import sys

import uvicorn

from .driver import OracledbDriver
from .gateway import ConnectTarget, GatewayOptions, create_gateway


def main() -> None:
    env = os.environ
    aliases = json.loads(env.get("CONNECT_ALIASES") or "null")
    if not isinstance(aliases, dict) or not aliases:
        print('CONNECT_ALIASES is required, e.g. {"dev":{"connectString":"localhost:1521/FREEPDB1"}}', file=sys.stderr)
        sys.exit(1)

    app = create_gateway(
        GatewayOptions(
            driver=OracledbDriver(),
            connect_aliases={
                k: ConnectTarget(connect_string=v["connectString"], label=v.get("label")) for k, v in aliases.items()
            },
            prefix=env.get("GATEWAY_PREFIX", "/api"),
            secure_cookie=env.get("SECURE_COOKIE") != "false",
            allow_ddl=env.get("ALLOW_DDL") != "false",
            allow_header_auth=env.get("ALLOW_HEADER_AUTH") == "true",
            idle_timeout_ms=int(float(env.get("IDLE_TIMEOUT_MIN", "30")) * 60_000),
            call_timeout_ms=int(float(env.get("CALL_TIMEOUT_SEC", "300")) * 1000),
            max_sessions_per_user=int(env.get("MAX_SESSIONS_PER_USER", "3")),
            docs=env.get("GATEWAY_DOCS") == "true",
        )
    )
    uvicorn.run(app, host=env.get("GATEWAY_HOST", "127.0.0.1"), port=int(env.get("GATEWAY_PORT", "8787")))


if __name__ == "__main__":
    main()
