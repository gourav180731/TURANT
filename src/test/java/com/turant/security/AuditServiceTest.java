package com.turant.security;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import javax.sql.DataSource;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Layer 10 — Immutable / Tamper-Evident Audit Trail tests.
 * Hash chaining (previous_hash -> current_hash), tamper detection, chain break detection.
 */
class AuditServiceTest {

    private AuditService auditService;
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void setUp() {
        DataSource ds = new EmbeddedDatabaseBuilder()
                .setType(EmbeddedDatabaseType.H2)
                .build();
        jdbcTemplate = new JdbcTemplate(ds);
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
        jdbcTemplate.execute("DELETE FROM security_audit");
        auditService = new AuditService(jdbcTemplate);
    }

    @Test
    void auditChain_validWhenUntampered() {
        var ctx1 = new AuditService.HttpContext("req-1", "tsp-a", "CN=TSP-A", "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-1");
        auditService.audit(ctx1, AuditService.AuditEvent.AUTHENTICATION_SUCCESS, "ALLOWED", "OK");

        var ctx2 = new AuditService.HttpContext("req-2", "tsp-a", "CN=TSP-A", "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-2");
        auditService.audit(ctx2, AuditService.AuditEvent.CAP_VALIDATION_SUCCESS, "ALLOWED", "Valid CAP XML");

        var ctx3 = new AuditService.HttpContext("req-3", "tsp-a", "CN=TSP-A", "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-3");
        auditService.audit(ctx3, AuditService.AuditEvent.ALERT_ACCEPTED, "ALLOWED", "Disseminated");

        assertTrue(auditService.verifyChain(), "Untampered audit chain must verify successfully");
    }

    @Test
    void tampering_detectedByVerifyChain() {
        var ctx1 = new AuditService.HttpContext("req-1", "tsp-a", "CN=TSP-A", "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-1");
        auditService.audit(ctx1, AuditService.AuditEvent.AUTHENTICATION_SUCCESS, "ALLOWED", "Original Reason");

        var ctx2 = new AuditService.HttpContext("req-2", "tsp-a", "CN=TSP-A", "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-2");
        auditService.audit(ctx2, AuditService.AuditEvent.ALERT_ACCEPTED, "ALLOWED", "OK");

        assertTrue(auditService.verifyChain(), "Baseline must verify");

        // Attacker tampers with the first record in the database
        jdbcTemplate.update("UPDATE security_audit SET reason='Tampered Reason' WHERE request_id='req-1'");

        // Verifier detects tampering immediately
        assertFalse(auditService.verifyChain(), "Tampering with an audit record must be detected by verifyChain");
    }

    @Test
    void recordDeletion_detectedAsChainBreak() {
        var ctx1 = new AuditService.HttpContext("req-1", "tsp-a", null, "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-1");
        auditService.audit(ctx1, AuditService.AuditEvent.AUTHENTICATION_SUCCESS, "ALLOWED", "1");

        var ctx2 = new AuditService.HttpContext("req-2", "tsp-a", null, "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-2");
        auditService.audit(ctx2, AuditService.AuditEvent.AUTHENTICATION_SUCCESS, "ALLOWED", "2");

        var ctx3 = new AuditService.HttpContext("req-3", "tsp-a", null, "10.0.0.1", "/api/v1/pipeline/trigger-by-cap", "POST", "CAP-3");
        auditService.audit(ctx3, AuditService.AuditEvent.AUTHENTICATION_SUCCESS, "ALLOWED", "3");

        assertTrue(auditService.verifyChain());

        // Attacker deletes the middle record
        jdbcTemplate.update("DELETE FROM security_audit WHERE request_id='req-2'");

        // Verifier detects the broken chain
        assertFalse(auditService.verifyChain(), "Deleting an audit record must break hash chain and be detected");
    }
}
