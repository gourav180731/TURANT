package com.turant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.UUID;

/**
 * Item #2 Layer 10 — Immutable/Tamper-Evident Audit Trail
 * Each record hashes canonical representation + previous hash → chain.
 * Stored in security_audit (PostgreSQL). DB permissions should be REVOKE UPDATE/DELETE for app user (documented).
 */
@Service
public class AuditService {

    private static final Logger log = LoggerFactory.getLogger(AuditService.class);
    private final JdbcTemplate jdbc;

    public AuditService(@Autowired(required = false) JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public enum AuditEvent {
        AUTHENTICATION_SUCCESS, AUTHENTICATION_FAILURE, CERTIFICATE_FAILURE,
        AUTHORIZATION_ALLOWED, AUTHORIZATION_DENIED,
        CAP_VALIDATION_SUCCESS, CAP_VALIDATION_FAILURE,
        SIGNATURE_VALID, SIGNATURE_INVALID,
        REPLAY_DETECTED, RATE_LIMIT_EXCEEDED, NETWORK_REJECTED,
        ALERT_ACCEPTED, ALERT_REJECTED,
        CREDENTIAL_CREATED, CREDENTIAL_ROTATED, CREDENTIAL_REVOKED,
        SECURITY_CONFIGURATION_CHANGED
    }

    public record AuditRecord(String requestId, String clientId, String certSubject, String sourceIp,
                              String endpoint, String method, String capId, AuditEvent event,
                              String result, String reason, Instant timestamp, String previousHash, String currentHash) {}

    private static String val(Object o) {
        if (o == null) return "-";
        String s = o.toString().trim();
        return s.isEmpty() ? "-" : s;
    }

    public synchronized void audit(HttpContext ctx, AuditEvent event, String result, String reason) {
        if (jdbc == null) { log.warn("AuditService no DB — log only {} {}", event, reason); return; }
        try {
            String requestId = ctx.requestId != null ? ctx.requestId : UUID.randomUUID().toString();
            String previousHash = fetchPreviousHash();
            String canonical = String.join("|",
                    val(requestId),
                    val(ctx.clientId),
                    val(ctx.certSubject),
                    val(ctx.sourceIp),
                    val(ctx.endpoint),
                    val(ctx.method),
                    val(ctx.capId),
                    val(event != null ? event.name() : null),
                    val(result),
                    val(reason),
                    previousHash != null ? previousHash : "GENESIS");
            String currentHash = sha256Hex(canonical);
            jdbc.update("""
                INSERT INTO security_audit
                (id, timestamp, request_id, client_id, cert_subject, source_ip, endpoint, method, cap_id, event, result, reason, previous_hash, current_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    UUID.randomUUID().toString(), java.sql.Timestamp.from(Instant.now()), requestId, ctx.clientId, ctx.certSubject,
                    ctx.sourceIp, ctx.endpoint, ctx.method, ctx.capId, event != null ? event.name() : "UNKNOWN", result, reason, previousHash, currentHash);
            log.info("AUDIT {} requestId={} client={} cap={} result={}", event, requestId, ctx.clientId, ctx.capId, result);
        } catch (Exception e) {
            log.error("Audit insert failed", e);
        }
    }

    private String fetchPreviousHash() {
        try {
            var list = jdbc.queryForList("SELECT current_hash FROM security_audit ORDER BY seq DESC LIMIT 1", String.class);
            return list.isEmpty() ? null : list.get(0);
        } catch (Exception e) {
            try {
                var list = jdbc.queryForList("SELECT current_hash FROM security_audit ORDER BY timestamp DESC, id DESC LIMIT 1", String.class);
                return list.isEmpty() ? null : list.get(0);
            } catch (Exception ignore) { return null; }
        }
    }

    public boolean verifyChain() {
        if (jdbc == null) return true;
        try {
            java.util.List<java.util.Map<String, Object>> rows;
            try {
                rows = jdbc.queryForList("SELECT id, request_id, client_id, cert_subject, source_ip, endpoint, method, cap_id, event, result, reason, previous_hash, current_hash, timestamp, seq FROM security_audit ORDER BY seq ASC");
            } catch (Exception e) {
                rows = jdbc.queryForList("SELECT id, request_id, client_id, cert_subject, source_ip, endpoint, method, cap_id, event, result, reason, previous_hash, current_hash, timestamp FROM security_audit ORDER BY timestamp ASC, id ASC");
            }
            String prev = null;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (var r : rows) {
                String canonical = String.join("|",
                        val(r.get("request_id")),
                        val(r.get("client_id")),
                        val(r.get("cert_subject")),
                        val(r.get("source_ip")),
                        val(r.get("endpoint")),
                        val(r.get("method")),
                        val(r.get("cap_id")),
                        val(r.get("event")),
                        val(r.get("result")),
                        val(r.get("reason")),
                        r.get("previous_hash") != null ? (String) r.get("previous_hash") : "GENESIS");
                String computed = HexFormat.of().formatHex(md.digest(canonical.getBytes(StandardCharsets.UTF_8)));
                String stored = (String) r.get("current_hash");
                String storedPrev = (String) r.get("previous_hash");
                if (!computed.equals(stored)) { log.error("Audit tamper detected id={} computed {} != stored {}", r.get("id"), computed, stored); return false; }
                if (prev != null && !prev.equals(storedPrev)) { log.error("Chain break id={}", r.get("id")); return false; }
                prev = stored;
            }
            log.info("Audit chain verified {} records", rows.size());
            return true;
        } catch (Exception e) { log.error("Verify failed", e); return false; }
    }

    private String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    public record HttpContext(String requestId, String clientId, String certSubject, String sourceIp, String endpoint, String method, String capId) {
        public static HttpContext from(jakarta.servlet.http.HttpServletRequest req, String clientId, String certSubject, String capId) {
            String rid = req.getHeader("X-Request-Id");
            if (rid == null || rid.isBlank()) rid = (String) req.getAttribute("turant.requestId");
            if (rid == null) rid = UUID.randomUUID().toString();
            return new HttpContext(rid, clientId, certSubject, req.getRemoteAddr(), req.getRequestURI(), req.getMethod(), capId);
        }
    }
}
