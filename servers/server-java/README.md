# oracle-monaco gateway (Java / Spring Boot)

Java port of the [Node reference gateway](../server-node/README.md): **one dedicated Oracle session per logged-in user**, same JSON API, same security model, same environment variables.
Spring Boot 4 (Spring MVC on Tomcat, virtual threads) + Oracle JDBC Thin (`ojdbc11`) — no Oracle Client libraries needed.

## Run

```bash
cd servers/server-java
mvn package                          # target/oracle-monaco-gateway.jar (Spring Boot executable jar)
CONNECT_ALIASES='{"dev":{"connectString":"db-host:1521/ORCLPDB1","label":"Development"}}' java -jar target/oracle-monaco-gateway.jar
# or: mvn spring-boot:run
```

The Node gateway's environment variables work as-is (`CONNECT_ALIASES`, `GATEWAY_HOST` / `GATEWAY_PORT`, `GATEWAY_PREFIX`, `SECURE_COOKIE`, `ALLOW_DDL`, `IDLE_TIMEOUT_MIN`, `CALL_TIMEOUT_SEC`, `MAX_SESSIONS_PER_USER`, `ALLOW_HEADER_AUTH`; mapped in `src/main/resources/application.properties`).
The API, the error format and the security model are exactly as in [`server-node/README.md`](../server-node/README.md).
`connectString` is anything that follows `jdbc:oracle:thin:@` (Easy Connect, or a TNS alias with `TNS_ADMIN`).

Every setting is also a regular Spring property under `gateway.*` (`GatewayProperties`), e.g. in `application.yml`:

```yaml
gateway:
  prefix: /api
  secure-cookie: true
  idle-timeout: 30m
  call-timeout: 300s
  max-sessions-per-user: 3
  connect-aliases:
    dev:
      connect-string: db-host:1521/ORCLPDB1
      label: Development
```

Other settings: `default-max-rows` (500), `max-rows-cap` (5000), `min-version` (19), `cookie-name` (`omsid`), `session-init`, `login-rate-limit-max` (5) / `login-rate-limit-window` (1m).
To use another driver (e.g. a wrapped `DataSource`), define your own `Driver` bean; `JdbcDriver` is only created when none exists.
Behind a reverse proxy, set `server.forward-headers-strategy=native` so the login rate limit sees the client address.

## Layout (`com.datadynamics.oraclemonaco.gateway`)

| Class | |
|---|---|
| `GatewayApplication` | `@SpringBootApplication`, default `Driver` bean |
| `GatewayProperties` | `gateway.*` settings with the Node defaults |
| `GatewayController` | HTTP routes, session cookie |
| `SessionManager` | Sessions, auth check, rate limit, idle sweep, execute / fetch / cancel, cell formatting |
| `ApiError` / `ApiErrorHandler` | `{ error: { code, message, offset? } }` responses (also 400 / 404 / 405 / 415) |
| `BodyLimitFilter` | 2 MiB request body limit |
| `Driver` / `DriverException` | The driver slice the gateway uses (records + interfaces) |
| `JdbcDriver` | Oracle JDBC implementation: binds, column readers, DBMS_OUTPUT, cancel |
| `GatewayTest` (test) | The Node test suite ported to JUnit 5: boots the app on a random port with a fake `Driver` |

## Differences from the Node gateway

- Named binds (`:owner`) are bound by JDBC position: per occurrence in SQL, per unique name in PL/SQL blocks (Oracle's own rules). Statements without binds run as plain `Statement`s, so `:NEW` / `:OLD` in trigger DDL are left alone. JDBC `{escape}` processing is off.
- Cancel is `Statement.cancel()` on the running statement (ORA-01013, as in Node); round trips on one session run one at a time (a lock), cancel bypasses it.
- The call timeout is `Statement.setQueryTimeout()` (rounded up to whole seconds).
- Connection-lost errors also include `SQLRecoverableException` and ORA-17002 / 17008 / 17410 / 17447.
- `NUMBER` out-binds are exact strings as well (Node returns JS numbers).
- `IDLE_TIMEOUT_MIN` / `CALL_TIMEOUT_SEC` must be whole numbers (they become `30m` / `300s` durations).

## Test

```bash
mvn test        # HTTP / session / auth tests against a fake driver (no database)
```

The repository root's `npm run test:live` works against this gateway too (start it with `SECURE_COOKIE=false ALLOW_HEADER_AUTH=true`).
