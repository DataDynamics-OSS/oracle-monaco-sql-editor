package com.datadynamics.oraclemonaco.gateway;

import java.io.StringReader;
import java.sql.Array;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLRecoverableException;
import java.sql.SQLWarning;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import oracle.jdbc.OracleConnection;
import oracle.jdbc.OracleDatabaseException;
import oracle.jdbc.OracleTypes;

/** {@link Driver} on Oracle JDBC Thin (ojdbc11). */
public final class JdbcDriver implements Driver {

  private static final Pattern DML = Pattern.compile("^(INSERT|UPDATE|DELETE|MERGE)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern PLSQL = Pattern.compile("^(BEGIN|DECLARE)\\b", Pattern.CASE_INSENSITIVE);
  private static final Pattern VERSION = Pattern.compile("Version (\\d+(?:\\.\\d+)+)");
  private static final Pattern RELEASE = Pattern.compile("Release (\\d+(?:\\.\\d+)+)");

  @Override
  public Connection connect(String user, String password, String connectString) throws DriverException {
    Properties p = new Properties();
    p.setProperty("user", user);
    p.setProperty("password", password);
    // Statements are sent as written: no JDBC {escape} rewriting.
    p.setProperty(OracleConnection.CONNECTION_PROPERTY_PROCESS_ESCAPES, "false");
    try {
      java.sql.Connection c = DriverManager.getConnection("jdbc:oracle:thin:@" + connectString, p);
      c.setAutoCommit(false);
      return new JdbcConnection(c);
    } catch (SQLException e) {
      throw wrap(e);
    }
  }

  static DriverException wrap(SQLException e) {
    int n = e.getErrorCode();
    String code = n > 0 ? String.format("ORA-%05d", n) : "GATEWAY_ERROR";
    Integer offset = null;
    for (Throwable t = e.getCause(); t != null; t = t.getCause()) {
      if (t instanceof OracleDatabaseException ode) {
        offset = ode.getErrorPosition();
        break;
      }
    }
    String message = e.getMessage() == null ? code : e.getMessage();
    return new DriverException(code, message, offset, e instanceof SQLRecoverableException);
  }

  /** Leading comments and whitespace removed (for statement classification). */
  static String stripLeading(String sql) {
    int i = 0;
    int n = sql.length();
    while (i < n) {
      char ch = sql.charAt(i);
      if (Character.isWhitespace(ch)) {
        i++;
      } else if (sql.startsWith("--", i)) {
        int eol = sql.indexOf('\n', i);
        i = eol < 0 ? n : eol + 1;
      } else if (sql.startsWith("/*", i)) {
        int end = sql.indexOf("*/", i + 2);
        if (end < 0) break;
        i = end + 2;
      } else {
        break;
      }
    }
    return sql.substring(i);
  }

  /**
   * Bind placeholder names in statement order (outside literals, quoted identifiers and
   * comments), upper-cased; e.g. {@code [OWNER, NAME, OWNER]}.
   */
  static List<String> placeholders(String sql) {
    List<String> names = new ArrayList<>();
    int n = sql.length();
    int i = 0;
    while (i < n) {
      char ch = sql.charAt(i);
      if (ch == '-' && sql.startsWith("--", i)) {
        int eol = sql.indexOf('\n', i);
        i = eol < 0 ? n : eol + 1;
      } else if (ch == '/' && sql.startsWith("/*", i)) {
        int end = sql.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
      } else if ((ch == 'q' || ch == 'Q') && i + 2 < n && sql.charAt(i + 1) == '\''
          && (i == 0 || !identChar(sql.charAt(i - 1)) || ((sql.charAt(i - 1) == 'n' || sql.charAt(i - 1) == 'N') && (i == 1 || !identChar(sql.charAt(i - 2)))))) {
        char open = sql.charAt(i + 2);
        char close = switch (open) {
          case '[' -> ']';
          case '{' -> '}';
          case '(' -> ')';
          case '<' -> '>';
          default -> open;
        };
        int end = sql.indexOf(close + "'", i + 3);
        i = end < 0 ? n : end + 2;
      } else if (ch == '\'') {
        i++;
        while (i < n) {
          if (sql.charAt(i) == '\'') {
            if (i + 1 < n && sql.charAt(i + 1) == '\'') i += 2;
            else break;
          } else {
            i++;
          }
        }
        i++;
      } else if (ch == '"') {
        int end = sql.indexOf('"', i + 1);
        i = end < 0 ? n : end + 1;
      } else if (ch == ':' && i + 1 < n) {
        int j = i + 1;
        char c1 = sql.charAt(j);
        if (c1 == '"') {
          int end = sql.indexOf('"', j + 1);
          if (end < 0) break;
          names.add(sql.substring(j + 1, end));
          i = end + 1;
        } else if (Character.isLetter(c1) || Character.isDigit(c1)) {
          while (j < n && identChar(sql.charAt(j))) j++;
          names.add(sql.substring(i + 1, j).toUpperCase(Locale.ROOT));
          i = j;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    return names;
  }

  private static boolean identChar(char c) {
    return Character.isLetterOrDigit(c) || c == '_' || c == '$' || c == '#';
  }

  // ------------------------------------------------------------------------

  private static final class JdbcConnection implements Connection {
    private final java.sql.Connection c;
    private final int major;
    private final String version;
    private final DriverException warning;
    private volatile Statement current;
    private int callTimeoutSec;

    JdbcConnection(java.sql.Connection c) throws SQLException {
      this.c = c;
      var md = c.getMetaData();
      this.major = md.getDatabaseMajorVersion();
      String product = md.getDatabaseProductVersion();
      Matcher m = VERSION.matcher(product);
      Matcher r = RELEASE.matcher(product);
      this.version = m.find() ? m.group(1) : r.find() ? r.group(1) : product;
      SQLWarning w = c.getWarnings();
      this.warning = w == null ? null : wrap(w);
      c.clearWarnings();
    }

    @Override
    public int majorVersion() {
      return major;
    }

    @Override
    public String version() {
      return version;
    }

    @Override
    public DriverException warning() {
      return warning;
    }

    @Override
    public void setCallTimeout(int ms) {
      callTimeoutSec = ms <= 0 ? 0 : Math.max(1, (ms + 999) / 1000);
    }

    private void prepare(Statement st, int fetchSize) throws SQLException {
      st.setFetchSize(Math.max(1, fetchSize));
      if (callTimeoutSec > 0) st.setQueryTimeout(callTimeoutSec);
    }

    /** One bind per JDBC position: by occurrence in SQL, by unique name in PL/SQL. */
    private static List<String> positions(String sql) {
      List<String> names = placeholders(sql);
      return PLSQL.matcher(stripLeading(sql)).find() ? new ArrayList<>(new LinkedHashSet<>(names)) : names;
    }

    @Override
    @SuppressWarnings("unchecked")
    public ExecuteResult execute(String sql, Object binds, int fetchSize) throws DriverException {
      Statement st = null;
      try {
        boolean isQuery;
        // Position (1-based) of each out bind, by name or list index.
        Map<Object, Integer> outs = new LinkedHashMap<>();
        Map<Object, Bind> outBinds = new LinkedHashMap<>();
        boolean noBinds = binds == null
            || (binds instanceof Map<?, ?> m && m.isEmpty())
            || (binds instanceof List<?> l && l.isEmpty());
        if (noBinds) {
          st = c.createStatement();
          prepare(st, fetchSize);
          current = st;
          isQuery = st.execute(sql);
        } else {
          List<Bind> byPosition = new ArrayList<>();
          if (binds instanceof List<?> list) {
            for (int i = 0; i < list.size(); i++) {
              Bind b = (Bind) list.get(i);
              byPosition.add(b);
              if (b.isOut()) {
                outs.put(i, i + 1);
                outBinds.put(i, b);
              }
            }
          } else {
            Map<String, Bind> named = new LinkedHashMap<>();
            ((Map<String, Bind>) binds).forEach((k, v) -> named.put(k.replaceFirst("^:", "").toUpperCase(Locale.ROOT), v));
            Map<String, String> original = new LinkedHashMap<>();
            ((Map<String, Bind>) binds).keySet().forEach(k -> original.put(k.replaceFirst("^:", "").toUpperCase(Locale.ROOT), k));
            for (String name : positions(sql)) {
              Bind b = named.get(name);
              if (b == null) throw new DriverException("ORA-01008", "ORA-01008: not all variables bound (:" + name + ")");
              byPosition.add(b);
              if (b.isOut() && !outs.containsKey(original.get(name))) {
                outs.put(original.get(name), byPosition.size());
                outBinds.put(original.get(name), b);
              }
            }
          }
          PreparedStatement ps = outs.isEmpty() ? c.prepareStatement(sql) : c.prepareCall(sql);
          st = ps;
          prepare(ps, fetchSize);
          for (int i = 0; i < byPosition.size(); i++) {
            Bind b = byPosition.get(i);
            if (b.isIn()) setValue(ps, i + 1, b);
            if (b.isOut()) ((CallableStatement) ps).registerOutParameter(i + 1, sqlType(b.type()));
          }
          current = ps;
          isQuery = ps.execute();
        }
        current = null;

        SQLWarning w = st.getWarnings();
        DriverException warning = w == null ? null : wrap(w);
        if (isQuery) {
          ResultSet rs = st.getResultSet();
          Rows rows = new Rows(this, st, rs);
          return new ExecuteResult(rows.columns, rows, null, null, warning);
        }
        Long affected = DML.matcher(stripLeading(sql)).find() ? (long) st.getUpdateCount() : null;
        Object out = null;
        if (!outs.isEmpty()) {
          CallableStatement cs = (CallableStatement) st;
          if (binds instanceof List<?> list) {
            List<Object> values = new ArrayList<>();
            for (int i = 0; i < list.size(); i++) values.add(outs.containsKey(i) ? outValue(cs, outs.get(i), outBinds.get(i)) : null);
            out = values;
          } else {
            Map<String, Object> values = new LinkedHashMap<>();
            for (var e : outs.entrySet()) values.put((String) e.getKey(), outValue(cs, e.getValue(), outBinds.get(e.getKey())));
            out = values;
          }
        }
        st.close();
        return new ExecuteResult(List.of(), null, affected, out, warning);
      } catch (SQLException e) {
        closeQuietly(st);
        throw wrap(e);
      } catch (DriverException e) {
        closeQuietly(st);
        throw e;
      } finally {
        current = null;
      }
    }

    private static int sqlType(String type) {
      if (type == null) return Types.VARCHAR;
      return switch (type) {
        case "number" -> Types.NUMERIC;
        case "date", "timestamp" -> Types.TIMESTAMP;
        case "clob" -> Types.CLOB;
        case "cursor" -> OracleTypes.CURSOR;
        default -> Types.VARCHAR;
      };
    }

    private static void setValue(PreparedStatement ps, int i, Bind b) throws SQLException {
      Object v = b.value();
      if (v == null) {
        ps.setNull(i, sqlType(b.type()));
      } else if (v instanceof String s && "clob".equals(b.type())) {
        ps.setCharacterStream(i, new StringReader(s), s.length());
      } else if (v instanceof String s) {
        ps.setString(i, s);
      } else if (v instanceof Boolean bool) {
        ps.setBoolean(i, bool);
      } else if (v instanceof Number) {
        ps.setObject(i, v);
      } else {
        ps.setString(i, String.valueOf(v));
      }
    }

    private Object outValue(CallableStatement cs, int i, Bind b) throws SQLException, DriverException {
      Object v = cs.getObject(i);
      if (v instanceof ResultSet rs) { // REF CURSOR → rows
        Rows rows = new Rows(this, null, rs);
        try {
          return rows.fetch(500);
        } finally {
          rows.close();
        }
      }
      if (v instanceof Clob clob) return clob.getSubString(1, (int) Math.min(Integer.MAX_VALUE, clob.length()));
      if (v instanceof Timestamp t) return t.toLocalDateTime();
      return v;
    }

    @Override
    public List<String> dbmsOutput() throws DriverException {
      List<String> lines = new ArrayList<>();
      int batch = 500;
      try (CallableStatement cs = c.prepareCall("BEGIN DBMS_OUTPUT.GET_LINES(?, ?); END;")) {
        cs.registerOutParameter(1, Types.ARRAY, "SYS.DBMSOUTPUT_LINESARRAY");
        cs.registerOutParameter(2, Types.INTEGER);
        for (int guard = 0; guard < 1000; guard++) {
          cs.setInt(2, batch);
          cs.execute();
          int n = cs.getInt(2);
          Array arr = cs.getArray(1);
          Object[] got = arr == null ? new Object[0] : (Object[]) arr.getArray();
          for (int k = 0; k < Math.min(n, got.length); k++) lines.add(got[k] == null ? "" : got[k].toString());
          if (arr != null) arr.free();
          if (n < batch) break;
        }
        return lines;
      } catch (SQLException e) {
        throw wrap(e);
      }
    }

    @Override
    public void cancel() {
      Statement st = current;
      if (st != null) {
        try {
          st.cancel();
        } catch (SQLException ignored) {
          // nothing running any more
        }
      }
    }

    @Override
    public void commit() throws DriverException {
      try {
        c.commit();
      } catch (SQLException e) {
        throw wrap(e);
      }
    }

    @Override
    public void rollback() throws DriverException {
      try {
        c.rollback();
      } catch (SQLException e) {
        throw wrap(e);
      }
    }

    @Override
    public void close() {
      try {
        c.close();
      } catch (SQLException ignored) {
        // already gone
      }
    }
  }

  private interface Reader {
    Object read(ResultSet rs, int i) throws SQLException;
  }

  private static final class Rows implements RowSource {
    final List<Column> columns = new ArrayList<>();
    private final JdbcConnection owner;
    private final Statement st;
    private final ResultSet rs;
    private final Reader[] readers;

    Rows(JdbcConnection owner, Statement st, ResultSet rs) throws SQLException {
      this.owner = owner;
      this.st = st;
      this.rs = rs;
      ResultSetMetaData md = rs.getMetaData();
      int n = md.getColumnCount();
      readers = new Reader[n];
      for (int i = 1; i <= n; i++) {
        int t = md.getColumnType(i);
        String typeName = md.getColumnTypeName(i);
        int precision = md.getPrecision(i);
        int nullable = md.isNullable(i);
        boolean numeric = t == Types.NUMERIC || t == Types.DECIMAL;
        columns.add(new Column(
            md.getColumnLabel(i),
            typeName,
            numeric && precision > 0 ? precision : null,
            numeric && precision > 0 ? md.getScale(i) : null,
            nullable == ResultSetMetaData.columnNullableUnknown ? null : nullable == ResultSetMetaData.columnNullable));
        readers[i - 1] = reader(t);
      }
    }

    private static Reader reader(int type) {
      return switch (type) {
        case Types.NUMERIC, Types.DECIMAL -> ResultSet::getBigDecimal;
        case OracleTypes.BINARY_FLOAT -> (rs, i) -> {
          float f = rs.getFloat(i);
          return rs.wasNull() ? null : f;
        };
        case OracleTypes.BINARY_DOUBLE -> (rs, i) -> {
          double d = rs.getDouble(i);
          return rs.wasNull() ? null : d;
        };
        case Types.DATE, Types.TIMESTAMP -> (rs, i) -> rs.getObject(i, LocalDateTime.class);
        case OracleTypes.TIMESTAMPTZ, Types.TIMESTAMP_WITH_TIMEZONE -> (rs, i) -> rs.getObject(i, OffsetDateTime.class);
        case OracleTypes.TIMESTAMPLTZ -> (rs, i) -> {
          Timestamp ts = rs.getTimestamp(i);
          return ts == null ? null : ts.toInstant();
        };
        case Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY, Types.BLOB -> ResultSet::getBytes;
        case Types.BOOLEAN -> (rs, i) -> {
          boolean b = rs.getBoolean(i);
          return rs.wasNull() ? null : b;
        };
        default -> ResultSet::getString;
      };
    }

    @Override
    public List<List<Object>> fetch(int n) throws DriverException {
      List<List<Object>> out = new ArrayList<>();
      owner.current = st;
      try {
        while (out.size() < n && rs.next()) {
          List<Object> row = new ArrayList<>(readers.length);
          for (int i = 0; i < readers.length; i++) row.add(readers[i].read(rs, i + 1));
          out.add(row);
        }
        return out;
      } catch (SQLException e) {
        throw wrap(e);
      } finally {
        owner.current = null;
      }
    }

    @Override
    public void close() {
      try {
        rs.close();
      } catch (SQLException ignored) {
        // closing anyway
      }
      closeQuietly(st);
    }
  }

  private static void closeQuietly(Statement st) {
    if (st == null) return;
    try {
      st.close();
    } catch (SQLException ignored) {
      // closing anyway
    }
  }
}
