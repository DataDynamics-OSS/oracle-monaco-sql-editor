package com.datadynamics.oraclemonaco.gateway;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * {@code gateway.*} settings, with the Node gateway's defaults.
 *
 * @param prefix route prefix (also the cookie path)
 * @param connectAliases the only databases clients may connect to, by alias
 * @param connectAliasesJson the same as JSON ({@code CONNECT_ALIASES}); merged into {@code connectAliases}
 * @param idleTimeout close sessions idle this long (rolling back open work)
 * @param maxSessionsPerUser concurrent sessions per alias + user
 * @param callTimeout per round-trip timeout; 0 disables
 * @param defaultMaxRows rows per page when the client does not say
 * @param maxRowsCap hard cap on rows per page
 * @param allowDdl allow DDL statements (CREATE / ALTER / DROP / …)
 * @param minVersion minimum Oracle major version
 * @param secureCookie mark the session cookie Secure (HTTPS only); disable only for local http dev
 * @param allowHeaderAuth also accept {@code X-Session-Id} (non-browser clients)
 * @param sessionInit statements run right after login (NLS formats when unset)
 * @param loginRateLimitMax failed logins allowed per client + user within the window
 */
@ConfigurationProperties("gateway")
public record GatewayProperties(
    @DefaultValue("/api") String prefix,
    @DefaultValue Map<String, ConnectTarget> connectAliases,
    String connectAliasesJson,
    @DefaultValue("30m") Duration idleTimeout,
    @DefaultValue("3") int maxSessionsPerUser,
    @DefaultValue("5m") Duration callTimeout,
    @DefaultValue("500") int defaultMaxRows,
    @DefaultValue("5000") int maxRowsCap,
    @DefaultValue("true") boolean allowDdl,
    @DefaultValue("19") int minVersion,
    @DefaultValue("true") boolean secureCookie,
    @DefaultValue("omsid") String cookieName,
    @DefaultValue("false") boolean allowHeaderAuth,
    List<String> sessionInit,
    @DefaultValue("5") int loginRateLimitMax,
    @DefaultValue("1m") Duration loginRateLimitWindow) {

  /** @param connectString Easy Connect string or TNS alias, e.g. "db-host:1521/ORCLPDB1" */
  public record ConnectTarget(String connectString, String label) {}

  public static final List<String> DEFAULT_SESSION_INIT = List.of(
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
      "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'");

  public GatewayProperties {
    if (sessionInit == null) sessionInit = DEFAULT_SESSION_INIT;
  }
}
