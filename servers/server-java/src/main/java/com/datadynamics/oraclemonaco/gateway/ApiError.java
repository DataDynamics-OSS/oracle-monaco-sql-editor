package com.datadynamics.oraclemonaco.gateway;

import java.util.LinkedHashMap;
import java.util.Map;

/** An HTTP error response: {@code { error: { code, message, offset? } }}. */
public final class ApiError extends RuntimeException {
  final int status;
  final Map<String, Object> body = new LinkedHashMap<>();

  public ApiError(int status, String code, String message, Integer offset) {
    super(message, null, false, false);
    this.status = status;
    body.put("code", code);
    body.put("message", message);
    if (offset != null) body.put("offset", offset);
  }

  public ApiError(int status, String code, String message) {
    this(status, code, message, null);
  }

  public Map<String, Object> response() {
    return Map.of("error", body);
  }
}
