package com.datadynamics.oraclemonaco.gateway;

/** A driver / database error. */
public class DriverException extends Exception {
  /** e.g. "ORA-00942" */
  private final String code;
  /** 0-based character offset of a parse error in the statement, if known. */
  private final Integer offset;
  /** The connection is unusable (JDBC {@code SQLRecoverableException}). */
  private final boolean connectionLost;

  public DriverException(String code, String message, Integer offset, boolean connectionLost) {
    super(message);
    this.code = code;
    this.offset = offset;
    this.connectionLost = connectionLost;
  }

  public DriverException(String code, String message) {
    this(code, message, null, false);
  }

  public String code() {
    return code;
  }

  public Integer offset() {
    return offset;
  }

  public boolean connectionLost() {
    return connectionLost;
  }
}
