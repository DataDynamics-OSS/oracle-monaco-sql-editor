package com.datadynamics.oraclemonaco.gateway;

import com.datadynamics.oraclemonaco.gateway.Driver.Bind;
import com.datadynamics.oraclemonaco.gateway.Driver.Column;
import com.datadynamics.oraclemonaco.gateway.Driver.Connection;
import com.datadynamics.oraclemonaco.gateway.Driver.ExecuteResult;
import com.datadynamics.oraclemonaco.gateway.Driver.RowSource;
import com.datadynamics.oraclemonaco.gateway.GatewayProperties.ConnectTarget;
import java.math.BigDecimal;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Service;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/**
 * oracle-monaco gateway (Java): per-user Oracle sessions. {@link GatewayController} maps
 * these operations to HTTP.
 *
 * <p>Same API and security model as the Node reference gateway in {@code servers/server-node/}
 * (see servers/server-node/README.md and docs/DESIGN.md §8.3):
 * <ul>
 *   <li>each user logs in with their OWN Oracle account; the gateway keeps one dedicated
 *       connection per browser session until logout or idle timeout
 *   <li>the password is sent once to POST /sessions and never stored; later calls are
 *       authorised by an httpOnly, SameSite=Strict session cookie that must match the
 *       session id in the URL
 *   <li>clients pick a server-configured connect alias, never a connect string
 *   <li>failed logins are rate-limited per client address + alias + user
 *   <li>servers older than {@code minVersion} (19c) are refused at login
 *   <li>call timeout, row limits and DDL policy are enforced here; everything else is
 *       the user's own database privileges
 * </ul>
 */
@Service
public class SessionManager implements DisposableBean {

  private static final Pattern DDL = Pattern.compile(
      "^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE|AUDIT|NOAUDIT|PURGE|FLASHBACK|ANALYZE|ASSOCIATE|DISASSOCIATE)\\b",
      Pattern.CASE_INSENSITIVE);
  /** Errors that mean the connection is gone and the session must be dropped. */
  private static final Pattern DEAD_CONNECTION = Pattern.compile("^ORA-(0(1012|3113|3114|3135|0028)|1(7002|7008|7410|7447))");
  private static final Pattern IDENT = Pattern.compile("^(?:[A-Za-z][\\w$#]{0,127}|\"[^\"]{1,128}\")$");
  private static final Pattern HELP_LINE = Pattern.compile("^(Help: )?https?:");

  private static final DateTimeFormatter WALL = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
  private static final DateTimeFormatter WALL_MS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS");
  private static final DateTimeFormatter ISO_MS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private static final SecureRandom RANDOM = new SecureRandom();

  private final Driver driver;
  private final GatewayProperties o;
  private final Map<String, ConnectTarget> connectAliases = new LinkedHashMap<>();
  private final ScheduledExecutorService sweeper;
  private final Map<String, Session> sessions = new ConcurrentHashMap<>();
  /** key → {count, resetAt} */
  private final Map<String, long[]> failures = new ConcurrentHashMap<>();

  private static final class OpenCursor {
    final RowSource rows;
    final List<String> types;

    OpenCursor(RowSource rows, List<String> types) {
      this.rows = rows;
      this.types = types;
    }
  }

  private static final class Session {
    final String id;
    final String user;
    final String connectAlias;
    final Connection conn;
    final String version;
    volatile String currentSchema;
    volatile long lastUsed = System.currentTimeMillis();
    final Map<String, OpenCursor> cursors = new ConcurrentHashMap<>();
    final Set<String> running = ConcurrentHashMap.newKeySet();
    volatile boolean dbmsOutputEnabled;
    /** One round trip at a time per connection (cancel bypasses it). */
    final ReentrantLock lock = new ReentrantLock(true);

    Session(String id, String user, String connectAlias, Connection conn, String currentSchema) {
      this.id = id;
      this.user = user;
      this.connectAlias = connectAlias;
      this.conn = conn;
      this.version = conn.version();
      this.currentSchema = currentSchema;
    }
  }

  /** A successful login: the response body plus the id for the session cookie. */
  public record Login(String sessionId, Map<String, Object> body) {}

  public SessionManager(Driver driver, GatewayProperties properties, JsonMapper json) {
    this.driver = driver;
    this.o = properties;
    String raw = properties.connectAliasesJson();
    if (raw != null && !raw.isBlank()) {
      Map<String, ConnectTarget> parsed = json.readValue(raw, new TypeReference<LinkedHashMap<String, ConnectTarget>>() {});
      if (parsed != null) connectAliases.putAll(parsed);
    }
    connectAliases.putAll(properties.connectAliases());
    if (connectAliases.isEmpty()) {
      throw new IllegalStateException(
          "CONNECT_ALIASES is required, e.g. {\"dev\":{\"connectString\":\"localhost:1521/FREEPDB1\"}}");
    }
    sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "oracle-monaco-idle-sweeper");
      t.setDaemon(true);
      return t;
    });
    long interval = Math.min(60_000, Math.max(1_000, o.idleTimeout().toMillis() / 2));
    sweeper.scheduleAtFixedRate(this::sweep, interval, interval, TimeUnit.MILLISECONDS);
  }

  /** Roll back and close every session (application shutdown). */
  @Override
  public void destroy() {
    sweeper.shutdownNow();
    for (Session s : List.copyOf(sessions.values())) closeSession(s);
  }

  // ------------------------------------------------------------ helpers

  private static String randomId(int bytes) {
    byte[] b = new byte[bytes];
    RANDOM.nextBytes(b);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
  }

  private static String randomHex(int bytes) {
    byte[] b = new byte[bytes];
    RANDOM.nextBytes(b);
    return HexFormat.of().formatHex(b);
  }

  static Map<String, Object> toApiError(Exception e) {
    String code = e instanceof DriverException d ? d.code() : "GATEWAY_ERROR";
    String raw = e.getMessage() == null ? code : e.getMessage();
    List<String> kept = new ArrayList<>();
    for (String line : raw.split("\n", -1)) if (!HELP_LINE.matcher(line.strip()).find()) kept.add(line);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("code", code);
    out.put("message", String.join("\n", kept).strip());
    if (e instanceof DriverException d && code.startsWith("ORA-") && d.offset() != null && d.offset() > 0) out.put("offset", d.offset());
    return out;
  }

  /** JSON-safe cell values: NUMBER exact text, RAW/BLOB hex, dates as text. */
  static Object cell(Object v, String dbType) {
    if (v == null) return null;
    if (v instanceof byte[] b) return HexFormat.of().withUpperCase().formatHex(b);
    if (v instanceof LocalDateTime d) {
      // DATE / TIMESTAMP: wall clock as stored
      boolean fraction = dbType == null ? d.getNano() != 0 : !"DATE".equals(dbType);
      return (fraction ? WALL_MS : WALL).format(d);
    }
    if (v instanceof java.sql.Timestamp t) return cell(t.toLocalDateTime(), dbType);
    // WITH (LOCAL) TIME ZONE: an absolute instant
    if (v instanceof OffsetDateTime d) return ISO_MS.format(d.toInstant());
    if (v instanceof ZonedDateTime d) return ISO_MS.format(d.toInstant());
    if (v instanceof Instant d) return ISO_MS.format(d);
    if (v instanceof BigDecimal d) return d.toPlainString();
    if (v instanceof Double d && !Double.isFinite(d)) return d.toString();
    if (v instanceof Float f && !Float.isFinite(f)) return f.toString();
    if (v instanceof List<?> l) {
      List<Object> out = new ArrayList<>(l.size());
      for (Object x : l) out.add(cell(x, null));
      return out;
    }
    if (v instanceof Map<?, ?> m) {
      Map<Object, Object> out = new LinkedHashMap<>();
      m.forEach((k, x) -> out.put(k, cell(x, null)));
      return out;
    }
    return v;
  }

  private static List<List<Object>> rowsOut(List<List<Object>> rows, List<String> types) {
    List<List<Object>> out = new ArrayList<>(rows.size());
    for (List<Object> r : rows) {
      List<Object> row = new ArrayList<>(r.size());
      for (int i = 0; i < r.size(); i++) row.add(cell(r.get(i), i < types.size() ? types.get(i) : null));
      out.add(row);
    }
    return out;
  }

  private static Object toBinds(Object raw) {
    if (raw instanceof List<?> list) {
      List<Bind> out = new ArrayList<>();
      for (Object b : list) out.add(bind(b));
      return out;
    }
    if (raw instanceof Map<?, ?> map) {
      Map<String, Bind> out = new LinkedHashMap<>();
      map.forEach((k, v) -> out.put(String.valueOf(k), bind(v)));
      return out;
    }
    return null;
  }

  private static Bind bind(Object b) {
    if (!(b instanceof Map<?, ?> m)) return Bind.in(b);
    Object dir = m.get("dir");
    Object type = m.get("type");
    Object maxSize = m.get("maxSize");
    return new Bind(
        m.get("value"),
        type instanceof String s ? s : null,
        "out".equals(dir) || "inout".equals(dir) ? (String) dir : "in",
        maxSize instanceof Number n ? n.intValue() : null);
  }

  private int rowsParam(Object v) {
    double n = v instanceof Number num && Double.isFinite(num.doubleValue()) ? num.doubleValue() : o.defaultMaxRows();
    return (int) Math.max(1, Math.min(o.maxRowsCap(), Math.floor(n)));
  }

  private void closeSession(Session s) {
    sessions.remove(s.id);
    if (!s.running.isEmpty()) s.conn.cancel();
    s.lock.lock();
    try {
      for (OpenCursor c : s.cursors.values()) c.rows.close();
      s.cursors.clear();
      try {
        s.conn.rollback();
      } catch (DriverException ignored) {
        // closing anyway
      }
      s.conn.close();
    } finally {
      s.lock.unlock();
    }
  }

  private void sweep() {
    long now = System.currentTimeMillis();
    for (Session s : List.copyOf(sessions.values())) {
      if (s.running.isEmpty() && now - s.lastUsed > o.idleTimeout().toMillis()) closeSession(s);
    }
  }

  /** Map a driver error; drop the session when the connection is dead. */
  private ApiError dbError(Session s, Exception e) {
    Map<String, Object> err = toApiError(e);
    String code = (String) err.get("code");
    if ((e instanceof DriverException d && d.connectionLost()) || DEAD_CONNECTION.matcher(code).find()) {
      closeSession(s);
      return new ApiError(401, "SESSION_LOST", "Database connection lost: " + err.get("message"));
    }
    return new ApiError(422, code, (String) err.get("message"), (Integer) err.get("offset"));
  }

  private interface Locked<T> {
    T run() throws Exception;
  }

  private static <T> T locked(Session s, Locked<T> body) throws Exception {
    s.lock.lock();
    try {
      return body.run();
    } finally {
      s.lock.unlock();
    }
  }

  private static List<Object> queryOne(Connection conn, String sql) throws DriverException {
    ExecuteResult r = conn.execute(sql, null, 1);
    if (r.rows() == null) return List.of();
    try {
      List<List<Object>> rows = r.rows().fetch(1);
      return rows.isEmpty() ? List.of() : rows.get(0);
    } finally {
      r.rows().close();
    }
  }

  private static String str(List<Object> row, int i) {
    return row.size() > i && row.get(i) != null ? row.get(i).toString() : null;
  }

  /** Resolve and authorise the session named in the URL by its cookie or header. */
  private Session sessionFor(String id, String fromCookie, String fromHeader) {
    Session s = sessions.get(id);
    String header = o.allowHeaderAuth() ? fromHeader : null;
    if (s == null || (!id.equals(fromCookie) && !id.equals(header))) {
      throw new ApiError(401, "SESSION_EXPIRED", "Not connected or session expired");
    }
    s.lastUsed = System.currentTimeMillis();
    return s;
  }

  // ---------------------------------------------------------------- operations

  public List<Map<String, String>> aliases() {
    List<Map<String, String>> out = new ArrayList<>();
    connectAliases.forEach((alias, t) -> {
      Map<String, String> a = new LinkedHashMap<>();
      a.put("alias", alias);
      a.put("label", t.label() != null ? t.label() : alias);
      out.add(a);
    });
    return out;
  }

  public Login login(Map<String, Object> body, String clientIp) {
    if (!(body.get("connectAlias") instanceof String alias)
        || !(body.get("user") instanceof String user)
        || !(body.get("password") instanceof String password)) {
      throw new ApiError(400, "BAD_REQUEST", "connectAlias, user and password are required");
    }
    ConnectTarget target = connectAliases.get(alias);
    if (target == null) throw new ApiError(400, "UNKNOWN_ALIAS", "Unknown connect alias '" + alias + "'");
    if (!IDENT.matcher(user).matches() || password.isEmpty() || password.length() > 1024) {
      throw new ApiError(400, "BAD_REQUEST", "Invalid user name or password");
    }
    String upper = user.toUpperCase(Locale.ROOT);

    String key = clientIp + "|" + alias + "|" + upper;
    long now = System.currentTimeMillis();
    long[] f = failures.get(key);
    if (f != null && f[1] > now && f[0] >= o.loginRateLimitMax()) {
      throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed logins; try again later");
    }
    long open = sessions.values().stream().filter(s -> s.connectAlias.equals(alias) && s.user.equals(upper)).count();
    if (open >= o.maxSessionsPerUser()) {
      throw new ApiError(429, "TOO_MANY_SESSIONS", "At most " + o.maxSessionsPerUser() + " sessions per user");
    }

    Connection conn;
    try {
      conn = driver.connect(user, password, target.connectString());
    } catch (Exception e) {
      Map<String, Object> err = toApiError(e);
      failures.compute(key, (k, prev) -> {
        long t = System.currentTimeMillis();
        long[] entry = prev != null && prev[1] > t ? prev : new long[] {0, t + o.loginRateLimitWindow().toMillis()};
        entry[0]++;
        return entry;
      });
      String code = (String) err.get("code");
      String message = (String) err.get("message");
      throw switch (code) {
        case "ORA-01017" -> new ApiError(401, "INVALID_CREDENTIALS", "Invalid user name or password");
        case "ORA-28000" -> new ApiError(403, "ACCOUNT_LOCKED", message);
        case "ORA-28001" -> new ApiError(403, "PASSWORD_EXPIRED", message);
        default -> new ApiError(502, code, message);
      };
    }
    failures.remove(key);

    if (conn.majorVersion() < o.minVersion()) {
      conn.close();
      throw new ApiError(400, "ORACLE_VERSION_UNSUPPORTED",
          "Oracle " + conn.version() + " is not supported (minimum " + o.minVersion() + "c)");
    }

    List<Object> who;
    try {
      long callTimeoutMs = o.callTimeout().toMillis();
      if (callTimeoutMs > 0) conn.setCallTimeout((int) Math.min(Integer.MAX_VALUE, callTimeoutMs));
      for (String sql : o.sessionInit()) conn.execute(sql, null, 1);
      who = queryOne(conn, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'), USER FROM dual");
    } catch (Exception e) {
      conn.close();
      Map<String, Object> err = toApiError(e);
      throw new ApiError(502, (String) err.get("code"), (String) err.get("message"));
    }

    String dbUser = str(who, 1);
    String schema = str(who, 0);
    Session s = new Session(randomId(24), dbUser != null ? dbUser : upper, alias, conn, schema != null ? schema : upper);
    sessions.put(s.id, s);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("sessionId", s.id);
    out.put("user", s.user);
    out.put("currentSchema", s.currentSchema);
    out.put("version", s.version);
    out.put("connectAlias", alias);
    if (conn.warning() != null) out.put("warning", toApiError(conn.warning()));
    return new Login(s.id, out);
  }

  public Map<String, Object> session(String id, String cookie, String header) {
    Session s = sessionFor(id, cookie, header);
    try {
      List<Object> row = locked(s, () -> queryOne(s.conn, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual"));
      String schema = str(row, 0);
      if (schema != null) s.currentSchema = schema;
    } catch (Exception e) {
      throw dbError(s, e);
    }
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("user", s.user);
    out.put("currentSchema", s.currentSchema);
    out.put("version", s.version);
    out.put("connectAlias", s.connectAlias);
    return out;
  }

  public void logout(String id, String cookie, String header) {
    closeSession(sessionFor(id, cookie, header));
  }

  public Map<String, Object> execute(String id, String cookie, String header, Map<String, Object> body) {
    Session s = sessionFor(id, cookie, header);
    if (!(body.get("sql") instanceof String sql) || sql.isBlank()) throw new ApiError(400, "BAD_REQUEST", "sql is required");
    if (!o.allowDdl() && DDL.matcher(JdbcDriver.stripLeading(sql)).find()) {
      throw new ApiError(403, "DDL_NOT_ALLOWED", "DDL is disabled on this gateway");
    }
    int maxRows = rowsParam(body.get("maxRows"));
    String executionId = body.get("executionId") instanceof String e ? e : randomHex(8);
    boolean capture = Boolean.TRUE.equals(body.get("captureDbmsOutput"));
    Object binds = toBinds(body.get("binds"));

    s.running.add(executionId);
    long started = System.nanoTime();
    try {
      Map<String, Object> out = locked(s, () -> {
        if (capture && !s.dbmsOutputEnabled) {
          s.conn.execute("BEGIN DBMS_OUTPUT.ENABLE(NULL); END;", null, 1);
          s.dbmsOutputEnabled = true;
        }
        ExecuteResult result = s.conn.execute(sql, binds, Math.min(maxRows, 1000));
        Map<String, Object> res = new LinkedHashMap<>();
        if (result.rows() != null) {
          List<List<Object>> rows = result.rows().fetch(maxRows);
          List<String> types = new ArrayList<>();
          List<Map<String, Object>> columns = new ArrayList<>();
          for (Column c : result.columns()) {
            types.add(c.type());
            Map<String, Object> col = new LinkedHashMap<>();
            col.put("name", c.name());
            col.put("type", c.type() != null ? c.type() : "");
            if (c.precision() != null) col.put("precision", c.precision());
            if (c.scale() != null) col.put("scale", c.scale());
            if (c.nullable() != null) col.put("nullable", c.nullable());
            columns.add(col);
          }
          res.put("columns", columns);
          res.put("rows", rowsOut(rows, types));
          if (rows.size() == maxRows) {
            String cursorId = randomHex(8);
            s.cursors.put(cursorId, new OpenCursor(result.rows(), types));
            res.put("cursorId", cursorId);
          } else {
            result.rows().close();
          }
        } else {
          if (result.rowsAffected() != null) res.put("rowsAffected", result.rowsAffected());
          if (result.outBinds() != null) res.put("outBinds", cell(result.outBinds(), null));
        }
        if (result.warning() != null) res.put("warning", toApiError(result.warning()));
        if (capture) res.put("dbmsOutput", s.conn.dbmsOutput());
        return res;
      });
      out.put("elapsedMs", (System.nanoTime() - started) / 1_000_000);
      return out;
    } catch (ApiError e) {
      throw e;
    } catch (Exception e) {
      throw dbError(s, e);
    } finally {
      s.running.remove(executionId);
    }
  }

  public Map<String, Object> fetch(String id, String cookie, String header, String cid, Map<String, Object> body) {
    Session s = sessionFor(id, cookie, header);
    OpenCursor cur = s.cursors.get(cid);
    if (cur == null) throw new ApiError(404, "CURSOR_CLOSED", "Cursor is closed");
    int maxRows = rowsParam(body.get("maxRows"));
    try {
      List<List<Object>> rows = locked(s, () -> {
        List<List<Object>> r = cur.rows.fetch(maxRows);
        if (r.size() < maxRows) {
          s.cursors.remove(cid);
          cur.rows.close();
        }
        return r;
      });
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("rows", rowsOut(rows, cur.types));
      out.put("hasMore", rows.size() == maxRows);
      return out;
    } catch (Exception e) {
      s.cursors.remove(cid);
      throw dbError(s, e);
    }
  }

  public void closeCursor(String id, String cookie, String header, String cid) {
    Session s = sessionFor(id, cookie, header);
    OpenCursor cur = s.cursors.remove(cid);
    if (cur == null) return;
    s.lock.lock();
    try {
      cur.rows.close();
    } finally {
      s.lock.unlock();
    }
  }

  public void cancel(String id, String cookie, String header, Map<String, Object> body) {
    Session s = sessionFor(id, cookie, header);
    // cancel() interrupts whatever the connection is running right now.
    if (body.get("executionId") instanceof String executionId && s.running.contains(executionId)) s.conn.cancel();
  }

  public void transaction(String id, String cookie, String header, boolean commit) {
    Session s = sessionFor(id, cookie, header);
    try {
      locked(s, () -> {
        if (commit) s.conn.commit();
        else s.conn.rollback();
        return null;
      });
    } catch (Exception e) {
      throw dbError(s, e);
    }
  }
}
