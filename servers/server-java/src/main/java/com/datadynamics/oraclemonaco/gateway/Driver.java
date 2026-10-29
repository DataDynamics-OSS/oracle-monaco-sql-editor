package com.datadynamics.oraclemonaco.gateway;

import java.util.List;
import java.util.Map;

/**
 * The slice of a database driver the gateway uses. {@link JdbcDriver} implements it
 * with Oracle JDBC Thin; tests run the whole HTTP layer against a fake driver
 * without a database.
 *
 * <p>Values come back as plain Java objects ({@code BigDecimal}, {@code LocalDateTime},
 * {@code OffsetDateTime}, {@code byte[]}, {@code String} …); the gateway turns them into
 * JSON cells.
 */
public interface Driver {

  Connection connect(String user, String password, String connectString) throws DriverException;

  interface Connection {
    /** e.g. 19 */
    int majorVersion();

    /** e.g. "19.3.0.0.0" */
    String version();

    /** Set after login when the password is about to expire (ORA-28002). */
    DriverException warning();

    /** Per round-trip timeout in ms; 0 disables. */
    void setCallTimeout(int ms);

    /**
     * Run one statement. {@code binds} is a {@code Map<String, Bind>} (by name), a
     * {@code List<Bind>} (by position) or {@code null}.
     */
    ExecuteResult execute(String sql, Object binds, int fetchSize) throws DriverException;

    /** Lines buffered by DBMS_OUTPUT since the last call. */
    List<String> dbmsOutput() throws DriverException;

    /** Interrupt whatever the connection is running right now (from another thread). */
    void cancel();

    void commit() throws DriverException;

    void rollback() throws DriverException;

    void close();
  }

  interface RowSource {
    List<List<Object>> fetch(int n) throws DriverException;

    void close();
  }

  /** {@code type} is the Oracle type name, e.g. "VARCHAR2", "TIMESTAMP WITH TIME ZONE". */
  record Column(String name, String type, Integer precision, Integer scale, Boolean nullable) {
    public Column(String name, String type) {
      this(name, type, null, null, null);
    }
  }

  /**
   * @param type "string" | "number" | "date" | "timestamp" | "clob" | "cursor" | null
   * @param dir "in" | "out" | "inout"
   */
  record Bind(Object value, String type, String dir, Integer maxSize) {
    public static Bind in(Object value) {
      return new Bind(value, null, "in", null);
    }

    public boolean isIn() {
      return !"out".equals(dir);
    }

    public boolean isOut() {
      return !"in".equals(dir);
    }
  }

  /**
   * @param rows open cursor for queries; the gateway pages and closes it
   * @param outBinds {@code Map<String, Object>} or {@code List<Object>}, like the binds
   * @param warning success with info, e.g. ORA-24344 "success with compilation error"
   */
  record ExecuteResult(List<Column> columns, RowSource rows, Long rowsAffected, Object outBinds, DriverException warning) {
    public static ExecuteResult empty() {
      return new ExecuteResult(List.of(), null, null, null, null);
    }

    public static ExecuteResult query(List<Column> columns, RowSource rows) {
      return new ExecuteResult(columns, rows, null, null, null);
    }

    public static ExecuteResult affected(long n) {
      return new ExecuteResult(List.of(), null, n, null, null);
    }

    public static ExecuteResult outBinds(Map<String, Object> out) {
      return new ExecuteResult(List.of(), null, null, out, null);
    }
  }
}
