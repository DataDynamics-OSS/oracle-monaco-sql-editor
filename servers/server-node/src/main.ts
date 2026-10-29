/**
 * Start the gateway with node-oracledb (Thin mode — no Oracle Client needed).
 *
 * Configuration (environment):
 *   CONNECT_ALIASES   JSON: {"dev":{"connectString":"db:1521/ORCLPDB1","label":"Dev"}}  (required)
 *   GATEWAY_HOST      default 127.0.0.1
 *   GATEWAY_PORT      default 8787
 *   GATEWAY_PREFIX    default /api
 *   SECURE_COOKIE     "false" only for local http development (default true)
 *   ALLOW_DDL         "false" to reject DDL statements (default true)
 *   IDLE_TIMEOUT_MIN  default 30
 *   CALL_TIMEOUT_SEC  default 300 (0 disables)
 *   MAX_SESSIONS_PER_USER default 3
 *   ALLOW_HEADER_AUTH "true" to accept X-Session-Id (non-browser clients)
 *
 * Run behind HTTPS (reverse proxy) in production.
 */
import { createRequire } from "node:module";
import { createGateway, type ConnectTarget } from "./gateway.js";
import type { OracleDriver } from "./driver.js";

const require = createRequire(import.meta.url);
const oracledb = require("oracledb") as OracleDriver;

const env = process.env;
const aliases = JSON.parse(env.CONNECT_ALIASES ?? "null") as Record<string, ConnectTarget> | null;
if (!aliases || !Object.keys(aliases).length) {
  console.error('CONNECT_ALIASES is required, e.g. {"dev":{"connectString":"localhost:1521/FREEPDB1"}}');
  process.exit(1);
}

const app = createGateway({
  driver: oracledb,
  connectAliases: aliases,
  prefix: env.GATEWAY_PREFIX ?? "/api",
  secureCookie: env.SECURE_COOKIE !== "false",
  allowDdl: env.ALLOW_DDL !== "false",
  allowHeaderAuth: env.ALLOW_HEADER_AUTH === "true",
  idleTimeoutMs: Number(env.IDLE_TIMEOUT_MIN ?? 30) * 60_000,
  callTimeoutMs: Number(env.CALL_TIMEOUT_SEC ?? 300) * 1000,
  maxSessionsPerUser: Number(env.MAX_SESSIONS_PER_USER ?? 3),
  logger: true,
});

const host = env.GATEWAY_HOST ?? "127.0.0.1";
const port = Number(env.GATEWAY_PORT ?? 8787);
await app.listen({ host, port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
