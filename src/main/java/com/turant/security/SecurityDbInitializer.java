package com.turant.security;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Initializes security tables (security_audit, cap_replay, client_credentials)
 * if they do not already exist, ensuring reliable startup in all environments
 * (PostgreSQL and in-memory test databases).
 */
@Component
public class SecurityDbInitializer {

    private static final Logger log = LoggerFactory.getLogger(SecurityDbInitializer.class);
    private final JdbcTemplate jdbcTemplate;

    public SecurityDbInitializer(@Autowired(required = false) JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostConstruct
    public void init() {
        if (jdbcTemplate == null) {
            log.info("SecurityDbInitializer: No DataSource configured — skipping DB table initialization.");
            return;
        }

        try {
            // 1. Audit Table
            jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS security_audit (
                    seq BIGSERIAL,
                    id VARCHAR(64) PRIMARY KEY,
                    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
                    request_id VARCHAR(128) NOT NULL,
                    client_id VARCHAR(128),
                    cert_subject VARCHAR(512),
                    source_ip VARCHAR(64),
                    endpoint VARCHAR(256),
                    method VARCHAR(16),
                    cap_id VARCHAR(128),
                    event VARCHAR(64) NOT NULL,
                    result VARCHAR(32),
                    reason VARCHAR(512),
                    previous_hash VARCHAR(128),
                    current_hash VARCHAR(128) NOT NULL
                )
            """);

            // 2. Replay Table
            jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS cap_replay (
                    cap_identifier VARCHAR(128) NOT NULL,
                    sender VARCHAR(256) NOT NULL,
                    first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    cap_hash VARCHAR(128) NOT NULL,
                    source_ip VARCHAR(64),
                    client_id VARCHAR(128),
                    PRIMARY KEY (cap_identifier, sender)
                )
            """);

            // 3. Client Credentials Table
            jdbcTemplate.execute("""
                CREATE TABLE IF NOT EXISTS client_credentials (
                    client_id VARCHAR(64) PRIMARY KEY,
                    display_name VARCHAR(128) NOT NULL,
                    api_key_hash VARCHAR(128) NOT NULL,
                    cert_subject VARCHAR(512),
                    allowed_ips VARCHAR(512),
                    roles VARCHAR(256) NOT NULL DEFAULT 'EWS_SUBMIT',
                    rate_limit_per_min INT NOT NULL DEFAULT 60,
                    enabled BOOLEAN NOT NULL DEFAULT true,
                    expires_at TIMESTAMP WITH TIME ZONE,
                    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    revoked BOOLEAN NOT NULL DEFAULT false
                )
            """);

            // Seed default development test clients if missing
            // test-key-12345 hash = 953a6f3acb148f7d0492a99ed5ce98dd442326f6438b39625fd5c85efa7f6f21
            // test-key-bbbbb hash = 3534c163fee49081cd4484c4894da4114f2c5093bbb0ceab406c24c59ebab5f9
            Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM client_credentials WHERE client_id='tsp-a'", Integer.class);
            if (count == null || count == 0) {
                jdbcTemplate.update("""
                    INSERT INTO client_credentials (client_id, display_name, api_key_hash, roles, rate_limit_per_min, enabled)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, "tsp-a", "TSP-A Primary Test", "953a6f3acb148f7d0492a99ed5ce98dd442326f6438b39625fd5c85efa7f6f21", "SUBMIT_CAP,GET_STATUS,GET_TOWERS,GET_REPORT", 60, true);
            }

            Integer countB = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM client_credentials WHERE client_id='tsp-b'", Integer.class);
            if (countB == null || countB == 0) {
                jdbcTemplate.update("""
                    INSERT INTO client_credentials (client_id, display_name, api_key_hash, roles, rate_limit_per_min, enabled)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, "tsp-b", "TSP-B Limited Test", "3534c163fee49081cd4484c4894da4114f2c5093bbb0ceab406c24c59ebab5f9", "GET_STATUS", 10, true);
            }

            log.info("SecurityDbInitializer: Successfully ensured security tables and seed records exist.");
        } catch (Exception e) {
            log.warn("SecurityDbInitializer: Non-fatal exception initializing tables (tables may already exist): {}", e.getMessage());
        }
    }
}
