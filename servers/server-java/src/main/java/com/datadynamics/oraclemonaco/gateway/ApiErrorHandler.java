package com.datadynamics.oraclemonaco.gateway;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Every failure as {@code { error: { code, message } }}, like the Node gateway. */
@RestControllerAdvice
class ApiErrorHandler {

  @ExceptionHandler(ApiError.class)
  ResponseEntity<Object> api(ApiError e) {
    return ResponseEntity.status(e.status).body(e.response());
  }

  @ExceptionHandler(HttpMessageNotReadableException.class)
  ResponseEntity<Object> unreadable() {
    return api(new ApiError(400, "BAD_REQUEST", "Invalid JSON body"));
  }

  @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
  ResponseEntity<Object> mediaType() {
    return api(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json"));
  }

  @ExceptionHandler(NoResourceFoundException.class)
  ResponseEntity<Object> notFound(NoResourceFoundException e) {
    return api(new ApiError(404, "NOT_FOUND", "Route " + e.getHttpMethod() + ":/" + e.getResourcePath() + " not found"));
  }

  @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
  ResponseEntity<Object> method(HttpRequestMethodNotSupportedException e) {
    return api(new ApiError(405, "METHOD_NOT_ALLOWED", e.getMessage()));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<Object> other(Exception e) {
    return api(new ApiError(500, "GATEWAY_ERROR", String.valueOf(e.getMessage())));
  }
}
