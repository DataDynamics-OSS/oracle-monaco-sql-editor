package com.datadynamics.oraclemonaco.gateway;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** Rejects request bodies over 2 MiB (the Node gateway's bodyLimit). */
@Component
class BodyLimitFilter extends OncePerRequestFilter {
  static final long LIMIT = 2 * 1024 * 1024;

  @Override
  protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
      throws ServletException, IOException {
    if (req.getContentLengthLong() > LIMIT) {
      res.setStatus(413);
      res.setContentType("application/json");
      res.getWriter().write("{\"error\":{\"code\":\"BODY_TOO_LARGE\",\"message\":\"Request body too large\"}}");
      return;
    }
    chain.doFilter(req, res);
  }
}
