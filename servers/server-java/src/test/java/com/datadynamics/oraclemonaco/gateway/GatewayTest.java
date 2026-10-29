package com.datadynamics.oraclemonaco.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.datadynamics.oraclemonaco.gateway.Driver.Bind;
import com.datadynamics.oraclemonaco.gateway.Driver.Column;
import com.datadynamics.oraclemonaco.gateway.Driver.ExecuteResult;
import com.datadynamics.oraclemonaco.gateway.Driver.RowSource;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import tools.jackson.databind.json.JsonMapper;

/**
 * Gateway HTTP / session / auth tests against a fake driver (no database): each {@link Env} boots the
 * Spring Boot app on a random port with a fake {@link Driver} bean. Run: mvn test (in servers/server-java/)
 */
class GatewayTest {

  private static final JsonMapper JSON = JsonMapper.builder().build();
  private static final HttpClient HTTP = HttpClient.newHttpClient();

  static DriverException oraError(int num, String message, Integer offset) {
    String code = String.format("ORA-%05d", num);
    return new DriverException(code, code + ": " + message + "\nHelp: https://docs.oracle.com/error-help/db/ora-" + num + "/", offset, false);
  }

  static final class FakeRows implements RowSource {
    final List<List<Object>> rows;

    FakeRows(List<List<Object>> rows) {
      this.rows = new ArrayList<>(rows);
    }

    @Override
    public List<List<Object>> fetch(int n) {
      List<List<Object>> out = new ArrayList<>(rows.subList(0, Math.min(n, rows.size())));
      rows.subList(0, out.size()).clear();
      return out;
    }

    @Override
    public void close() {}
  }

  static final class FakeConn implements Driver.Connection {
    final String user;
    final List<String> log = new ArrayList<>();
    volatile boolean closed;
    volatile int rolledBack;
    int callTimeout;

    FakeConn(String user) {
      this.user = user;
    }

    @Override
    public int majorVersion() {
      return user.equals("old") ? 12 : 19;
    }

    @Override
    public String version() {
      return user.equals("old") ? "12.2.0.1.0" : "19.3.0.0.0";
    }

    @Override
    public DriverException warning() {
      return null;
    }

    @Override
    public void setCallTimeout(int ms) {
      callTimeout = ms;
    }

    @Override
    @SuppressWarnings("unchecked")
    public ExecuteResult execute(String sql, Object binds, int fetchSize) throws DriverException {
      log.add(sql);
      if (sql.contains("SYS_CONTEXT")) {
        return ExecuteResult.query(List.of(new Column("A", "VARCHAR2")), new FakeRows(List.of(List.of(user.toUpperCase(), user.toUpperCase()))));
      }
      if (sql.contains("FROM big")) {
        List<List<Object>> rows = new ArrayList<>();
        for (int i = 0; i < 7; i++) rows.add(List.of(BigDecimal.valueOf(i + 1), LocalDateTime.of(2024, 2, 29, 13, 14, 15), new byte[] {10, (byte) 255}));
        return ExecuteResult.query(List.of(new Column("N", "NUMBER"), new Column("D", "DATE"), new Column("R", "RAW")), new FakeRows(rows));
      }
      if (sql.contains("no_such")) throw oraError(942, "table or view does not exist", 14);
      if (sql.contains("lost")) throw oraError(3113, "end-of-file on communication channel", null);
      if (sql.startsWith("UPDATE")) return ExecuteResult.affected(3);
      if (sql.contains(":x")) {
        Map<String, Object> echo = new LinkedHashMap<>();
        ((Map<String, Bind>) binds).forEach((k, b) -> echo.put(k, Arrays.asList(b.value(), b.type(), b.dir())));
        return ExecuteResult.outBinds(Map.of("echo", echo));
      }
      return ExecuteResult.empty();
    }

    @Override
    public List<String> dbmsOutput() {
      log.add("GET_LINES");
      return List.of("a", "b");
    }

    @Override
    public void cancel() {
      log.add("BREAK");
    }

    @Override
    public void commit() {
      log.add("COMMIT");
    }

    @Override
    public void rollback() {
      rolledBack++;
    }

    @Override
    public void close() {
      closed = true;
    }
  }

  static final class FakeDriver implements Driver {
    final List<FakeConn> conns = new ArrayList<>();

    @Override
    public synchronized Connection connect(String user, String password, String connectString) throws DriverException {
      if (password.equals("bad")) throw oraError(1017, "invalid credential or not authorized; logon denied", null);
      if (password.equals("locked")) throw oraError(28000, "The account is locked.", null);
      FakeConn c = new FakeConn(user);
      conns.add(c);
      return c;
    }
  }

  record Res(int status, Object json, HttpResponse<String> raw) {
    @SuppressWarnings("unchecked")
    Map<String, Object> map() {
      return (Map<String, Object>) json;
    }

    @SuppressWarnings("unchecked")
    List<Object> errorCode() {
      return List.of(status, ((Map<String, Object>) map().get("error")).get("code"));
    }
  }

  static final class Env implements AutoCloseable {
    final FakeDriver driver = new FakeDriver();
    final ConfigurableApplicationContext app;
    final int port;

    /** @param args extra Spring properties, e.g. {@code --gateway.allow-ddl=false} */
    Env(String... args) {
      String[] base = {
        "--server.port=0",
        "--server.address=127.0.0.1",
        "--gateway.connect-aliases-json=",
        "--gateway.connect-aliases.dev.connect-string=db:1521/PDB",
        "--gateway.connect-aliases.dev.label=Development",
        "--gateway.login-rate-limit-max=3",
      };
      app = new SpringApplicationBuilder(GatewayApplication.class)
          .initializers(ctx -> ctx.getBeanFactory().registerSingleton("fakeDriver", driver))
          .run(Stream.concat(Stream.of(base), Stream.of(args)).toArray(String[]::new));
      port = app.getEnvironment().getRequiredProperty("local.server.port", Integer.class);
    }

    Res call(String method, String path, Map<String, String> headers, Object body) throws Exception {
      HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api" + path));
      headers.forEach(b::header);
      if (body != null) b.header("Content-Type", "application/json");
      b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
      HttpResponse<String> r = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString());
      return new Res(r.statusCode(), r.body().isEmpty() ? null : JSON.readValue(r.body(), Object.class), r);
    }

    Login login(String user, String password) throws Exception {
      return new Login(call("POST", "/sessions", Map.of(), Map.of("connectAlias", "dev", "user", user, "password", password)));
    }

    Login login(String user) throws Exception {
      return login(user, "tiger");
    }

    Res exec(Login s, Object payload) throws Exception {
      return call("POST", "/sessions/" + s.id + "/execute", s.headers, payload);
    }

    @Override
    public void close() {
      app.close();
    }
  }

  static final class Login {
    final Res res;
    final String id;
    final String setCookie;
    final Map<String, String> headers;

    Login(Res res) {
      this.res = res;
      this.id = res.status == 200 ? (String) res.map().get("sessionId") : null;
      this.setCookie = res.raw.headers().firstValue("set-cookie").orElse("");
      this.headers = Map.of("Cookie", "omsid=" + id);
    }
  }

  @Test
  void aliasesAndLogin() throws Exception {
    try (Env env = new Env()) {
      assertEquals(List.of(Map.of("alias", "dev", "label", "Development")), env.call("GET", "/aliases", Map.of(), null).json());
      Login s = env.login("scott");
      Map<String, Object> body = s.res.map();
      assertEquals(List.of(200, "SCOTT", "SCOTT", "19.3.0.0.0"), List.of(s.res.status, body.get("user"), body.get("currentSchema"), body.get("version")));
      List<String> flags = Arrays.stream(s.setCookie.split(";")).map(String::strip).toList();
      assertEquals("omsid=" + s.id, flags.get(0));
      assertTrue(flags.containsAll(List.of("HttpOnly", "SameSite=Strict", "Secure", "Path=/api")), s.setCookie);
      assertEquals(1, env.driver.conns.get(0).log.stream().filter(l -> l.contains("NLS_DATE_FORMAT")).count());
      assertEquals(300_000, env.driver.conns.get(0).callTimeout);

      Res unknown = env.call("POST", "/sessions", Map.of(), Map.of("connectAlias", "prod", "user", "a", "password", "b"));
      assertEquals(List.of(400, "UNKNOWN_ALIAS"), unknown.errorCode());
      Res injected = env.call("POST", "/sessions", Map.of(), Map.of("connectAlias", "dev", "user", "x/y@other", "password", "b"));
      assertEquals(400, injected.status);
      assertEquals(List.of(401, "INVALID_CREDENTIALS"), env.login("scott", "bad").res.errorCode());
      assertEquals(List.of(403, "ACCOUNT_LOCKED"), env.login("scott", "locked").res.errorCode());
      env.login("scott", "bad");
      assertEquals(List.of(429, "TOO_MANY_ATTEMPTS"), env.login("scott", "tiger").res.errorCode());
      assertEquals(List.of(400, "ORACLE_VERSION_UNSUPPORTED"), env.login("old").res.errorCode());
      assertTrue(env.driver.conns.get(env.driver.conns.size() - 1).closed);
    }
  }

  @Test
  void maxSessionsPerUser() throws Exception {
    try (Env env = new Env("--gateway.max-sessions-per-user=2")) {
      env.login("scott");
      env.login("scott");
      assertEquals(List.of(429, "TOO_MANY_SESSIONS"), env.login("scott").res.errorCode());
    }
  }

  @Test
  void authorisation() throws Exception {
    Map<String, String> select = Map.of("sql", "SELECT 1 FROM dual");
    try (Env env = new Env()) {
      Login a = env.login("alice");
      Login b = env.login("bob");
      assertEquals(200, env.call("POST", "/sessions/" + a.id + "/execute", a.headers, select).status);
      assertEquals(401, env.call("POST", "/sessions/" + a.id + "/execute", Map.of(), select).status);
      assertEquals(401, env.call("POST", "/sessions/" + b.id + "/execute", a.headers, select).status, "someone else's session id with my cookie");
      assertEquals(401, env.call("POST", "/sessions/" + a.id + "/execute", Map.of("X-Session-Id", a.id), select).status, "header auth off by default");
    }
    try (Env env = new Env("--gateway.allow-header-auth=true")) {
      Login a = env.login("scott");
      assertEquals(200, env.call("POST", "/sessions/" + a.id + "/execute", Map.of("X-Session-Id", a.id), select).status);
    }
  }

  @Test
  @SuppressWarnings("unchecked")
  void execute() throws Exception {
    try (Env env = new Env()) {
      Login s = env.login("scott");
      Map<String, Object> q = env.exec(s, Map.of("sql", "SELECT * FROM big", "maxRows", 3)).map();
      List<String> cols = ((List<Map<String, Object>>) q.get("columns")).stream().map(c -> c.get("name") + ":" + c.get("type")).toList();
      assertEquals(List.of("N:NUMBER", "D:DATE", "R:RAW"), cols);
      assertEquals(List.of("1", "2024-02-29 13:14:15", "0AFF"), ((List<Object>) q.get("rows")).get(0), "NUMBER exact text, DATE wall clock, RAW hex");
      String cid = (String) q.get("cursorId");
      Map<String, Object> page = env.call("POST", "/sessions/" + s.id + "/cursors/" + cid + "/fetch", s.headers, Map.of("maxRows", 3)).map();
      assertEquals(List.of(3, true), List.of(((List<?>) page.get("rows")).size(), page.get("hasMore")));
      Map<String, Object> last = env.call("POST", "/sessions/" + s.id + "/cursors/" + cid + "/fetch", s.headers, Map.of("maxRows", 3)).map();
      assertEquals(List.of(1, false), List.of(((List<?>) last.get("rows")).size(), last.get("hasMore")), "last page closes the cursor");
      assertEquals(404, env.call("POST", "/sessions/" + s.id + "/cursors/" + cid + "/fetch", s.headers, Map.of()).status);

      Res err = env.exec(s, Map.of("sql", "SELECT * FROM no_such"));
      assertEquals(422, err.status);
      assertEquals(Map.of("code", "ORA-00942", "message", "ORA-00942: table or view does not exist", "offset", 14), err.map().get("error"));
      assertEquals(3, env.exec(s, Map.of("sql", "UPDATE t SET a = 1")).map().get("rowsAffected"));
      Map<String, Object> out = env.exec(s, Map.of("sql", "BEGIN NULL; END;", "captureDbmsOutput", true)).map();
      assertEquals(List.of("a", "b"), out.get("dbmsOutput"));
      env.exec(s, Map.of("sql", "BEGIN NULL; END;", "captureDbmsOutput", true));
      assertEquals(1, env.driver.conns.get(0).log.stream().filter(l -> l.contains("ENABLE")).count(), "DBMS_OUTPUT enabled once");

      Map<String, Object> binds = new LinkedHashMap<>();
      binds.put("x", Map.of("dir", "out", "type", "number"));
      binds.put("y", 5);
      binds.put("z", Map.of("value", "s"));
      Map<String, Object> b = env.exec(s, Map.of("sql", "BEGIN :x := 1; END;", "binds", binds)).map();
      Map<String, Object> echo = (Map<String, Object>) ((Map<String, Object>) b.get("outBinds")).get("echo");
      assertEquals(Arrays.asList(null, "number", "out"), echo.get("x"));
      assertEquals(Arrays.asList(5, null, "in"), echo.get("y"));
      assertEquals(Arrays.asList("s", null, "in"), echo.get("z"));
      assertEquals(400, env.exec(s, Map.of("sql", "  ")).status);

      Res commit = env.call("POST", "/sessions/" + s.id + "/commit", s.headers, null);
      assertEquals(List.of(204, true), List.of(commit.status, env.driver.conns.get(0).log.contains("COMMIT")));

      assertEquals(List.of(401, "SESSION_LOST"), env.exec(s, Map.of("sql", "SELECT lost FROM dual")).errorCode());
      assertEquals(List.of(401, true), List.of(env.exec(s, Map.of("sql", "SELECT 1 FROM dual")).status, env.driver.conns.get(0).closed));
    }
  }

  @Test
  void ddlBlockedWhenDisabled() throws Exception {
    try (Env env = new Env("--gateway.allow-ddl=false")) {
      Login s = env.login("scott");
      assertEquals(List.of(403, "DDL_NOT_ALLOWED"), env.exec(s, Map.of("sql", "-- c\n  drop table t")).errorCode());
    }
  }

  @Test
  void cancelLogoutIdleTimeout() throws Exception {
    try (Env env = new Env("--gateway.idle-timeout=1500ms")) {
      Login s = env.login("scott");
      FakeConn conn = env.driver.conns.get(0);
      Res cancel = env.call("POST", "/sessions/" + s.id + "/cancel", s.headers, Map.of("executionId", "nope"));
      assertEquals(List.of(204, false), List.of(cancel.status, conn.log.contains("BREAK")), "cancel of an idle execution is a no-op");
      Res out = env.call("DELETE", "/sessions/" + s.id, s.headers, null);
      assertEquals(List.of(204, true, true), List.of(out.status, conn.rolledBack > 0, conn.closed));
      assertTrue(out.raw.headers().firstValue("set-cookie").orElse("x").startsWith("omsid=;"), "cookie cleared");

      Login t = env.login("scott");
      Thread.sleep(2600);
      FakeConn second = env.driver.conns.get(1);
      assertEquals(List.of(true, true), List.of(second.closed, second.rolledBack > 0), "idle session swept");
      assertEquals(401, env.call("GET", "/sessions/" + t.id, t.headers, null).status);
    }
  }

  @Test
  void errorsAreJson() throws Exception {
    try (Env env = new Env()) {
      assertEquals(List.of(404, "NOT_FOUND"), env.call("GET", "/nope", Map.of(), null).errorCode());
      HttpRequest bad = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + env.port + "/api/sessions"))
          .header("Content-Type", "application/json")
          .POST(HttpRequest.BodyPublishers.ofString("{oops"))
          .build();
      HttpResponse<String> r = HTTP.send(bad, HttpResponse.BodyHandlers.ofString());
      assertEquals(400, r.statusCode());
      assertTrue(r.body().contains("\"BAD_REQUEST\""), r.body());
    }
  }

  @Test
  void cells() {
    assertEquals("100", SessionManager.cell(new BigDecimal("1E+2"), "NUMBER"));
    assertEquals("0.0000001", SessionManager.cell(new BigDecimal("0.0000001"), "NUMBER"));
    assertEquals("2024-01-02 03:04:05.678", SessionManager.cell(LocalDateTime.of(2024, 1, 2, 3, 4, 5, 678_000_000), "TIMESTAMP"));
    assertEquals("2024-01-02T03:00:00.000Z", SessionManager.cell(OffsetDateTime.parse("2024-01-02T12:00:00+09:00"), "TIMESTAMP WITH TIME ZONE"));
  }

  @Test
  void placeholders() {
    assertEquals(
        List.of("OWNER", "NAME", "OWNER", "1"),
        JdbcDriver.placeholders("SELECT ':no', q'[:no]', \"A:B\" -- :no\n FROM t /* :no */ WHERE o = :owner AND n = :Name OR o = :OWNER AND x := :1"));
    assertEquals("drop table t", JdbcDriver.stripLeading("-- c\n /* d */ drop table t"));
  }
}
