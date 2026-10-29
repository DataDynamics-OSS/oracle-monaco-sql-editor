package com.datadynamics.oraclemonaco.gateway;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The gateway HTTP API (servers/server-node/README.md) under {@code gateway.prefix}. */
@RestController
@RequestMapping("${gateway.prefix:/api}")
class GatewayController {

  private final SessionManager sessions;
  private final GatewayProperties o;

  GatewayController(SessionManager sessions, GatewayProperties properties) {
    this.sessions = sessions;
    this.o = properties;
  }

  private String cookie(HttpServletRequest req) {
    Cookie[] cookies = req.getCookies();
    if (cookies == null) return null;
    for (Cookie c : cookies) if (c.getName().equals(o.cookieName())) return c.getValue();
    return null;
  }

  private static String header(HttpServletRequest req) {
    return req.getHeader("X-Session-Id");
  }

  private static Map<String, Object> body(Map<String, Object> body) {
    return body == null ? Map.of() : body;
  }

  private static ResponseEntity<Void> noContent() {
    return ResponseEntity.noContent().build();
  }

  @GetMapping("/aliases")
  List<Map<String, String>> aliases() {
    return sessions.aliases();
  }

  @PostMapping("/sessions")
  ResponseEntity<Map<String, Object>> login(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
    SessionManager.Login login = sessions.login(body(body), req.getRemoteAddr());
    ResponseCookie cookie = ResponseCookie.from(o.cookieName(), login.sessionId())
        .httpOnly(true)
        .sameSite("Strict")
        .secure(o.secureCookie())
        .path(o.prefix())
        .build();
    return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, cookie.toString()).body(login.body());
  }

  @GetMapping("/sessions/{id}")
  Map<String, Object> session(@PathVariable String id, HttpServletRequest req) {
    return sessions.session(id, cookie(req), header(req));
  }

  @DeleteMapping("/sessions/{id}")
  ResponseEntity<Void> logout(@PathVariable String id, HttpServletRequest req) {
    sessions.logout(id, cookie(req), header(req));
    ResponseCookie clear = ResponseCookie.from(o.cookieName(), "").path(o.prefix()).maxAge(0).build();
    return ResponseEntity.noContent().header(HttpHeaders.SET_COOKIE, clear.toString()).build();
  }

  @PostMapping("/sessions/{id}/execute")
  Map<String, Object> execute(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
    return sessions.execute(id, cookie(req), header(req), body(body));
  }

  @PostMapping("/sessions/{id}/cursors/{cid}/fetch")
  Map<String, Object> fetch(
      @PathVariable String id, @PathVariable String cid, @RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
    return sessions.fetch(id, cookie(req), header(req), cid, body(body));
  }

  @DeleteMapping("/sessions/{id}/cursors/{cid}")
  ResponseEntity<Void> closeCursor(@PathVariable String id, @PathVariable String cid, HttpServletRequest req) {
    sessions.closeCursor(id, cookie(req), header(req), cid);
    return noContent();
  }

  @PostMapping("/sessions/{id}/cancel")
  ResponseEntity<Void> cancel(@PathVariable String id, @RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
    sessions.cancel(id, cookie(req), header(req), body(body));
    return noContent();
  }

  @PostMapping("/sessions/{id}/commit")
  ResponseEntity<Void> commit(@PathVariable String id, HttpServletRequest req) {
    sessions.transaction(id, cookie(req), header(req), true);
    return noContent();
  }

  @PostMapping("/sessions/{id}/rollback")
  ResponseEntity<Void> rollback(@PathVariable String id, HttpServletRequest req) {
    sessions.transaction(id, cookie(req), header(req), false);
    return noContent();
  }
}
