package com.datadynamics.oraclemonaco.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.annotation.Bean;

/**
 * Start the gateway with Oracle JDBC Thin (no Oracle Client needed).
 *
 * <pre>java -jar target/oracle-monaco-gateway.jar</pre>
 *
 * Configuration: the Node gateway's environment variables (CONNECT_ALIASES, GATEWAY_HOST,
 * GATEWAY_PORT, GATEWAY_PREFIX, SECURE_COOKIE, ALLOW_DDL, IDLE_TIMEOUT_MIN, CALL_TIMEOUT_SEC,
 * MAX_SESSIONS_PER_USER, ALLOW_HEADER_AUTH) — see application.properties — or any
 * {@code gateway.*} Spring property ({@link GatewayProperties}).
 *
 * <p>Run behind HTTPS (reverse proxy) in production.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class GatewayApplication {

  /** Oracle JDBC; an application (or test) can supply its own {@link Driver} bean instead. */
  @Bean
  @ConditionalOnMissingBean(Driver.class)
  Driver driver() {
    return new JdbcDriver();
  }

  public static void main(String[] args) {
    SpringApplication.run(GatewayApplication.class, args);
  }
}
