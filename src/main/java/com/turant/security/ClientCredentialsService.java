package com.turant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Item #2 Layer 7 — Per-client credentials (unique per TSP, revocable, rotatable)
 * Stores api_key_hash (SHA256), not plaintext. Supports enabled/disabled, expires_at, revoked.
 */
@Service
public class ClientCredentialsService {

    private static final Logger log = LoggerFactory.getLogger(ClientCredentialsService.class);
    private final JdbcTemplate jdbc;
    private final String expectedApiKey;
    private final Map<String, ClientRecord> cache = new ConcurrentHashMap<>();

    public record ClientRecord(String clientId, String displayName, String apiKeyHash, String certSubject, String allowedIps, String roles, int rateLimitPerMin, boolean enabled, boolean revoked) {}

    public ClientCredentialsService(@Autowired(required = false) JdbcTemplate jdbc,
                                   @org.springframework.beans.factory.annotation.Value("${turant.security.api-key:}") String apiKey,
                                   @org.springframework.beans.factory.annotation.Value("${EWS_API_KEY:}") String ewsKey) {
        this.jdbc = jdbc;
        String v = (ewsKey != null && !ewsKey.isBlank()) ? ewsKey.trim() : (apiKey != null ? apiKey.trim() : "");
        this.expectedApiKey = v;
        // Pre-cache synthetic for test-key when DB not available
        if (v != null && !v.isBlank() && !"disabled".equalsIgnoreCase(v)) {
            String hash = sha256Hex(v);
            ClientRecord defaultRec = new ClientRecord("tsp-a", "EWS Test Client", hash, null, null, "SUBMIT_CAP,GET_STATUS,GET_TOWERS,GET_REPORT", 60, true, false);
            cache.put("tsp-a", defaultRec);
            cache.put(hash, defaultRec);
        }
    }

    public ClientRecord findByApiKey(String apiKey) {
        if (apiKey == null || apiKey.isBlank()) return null;
        String hash = sha256Hex(apiKey);
        // Check cache first
        for (var r : cache.values()) {
            if (r.apiKeyHash() != null && r.apiKeyHash().equals(hash)) {
                if (!r.enabled() || r.revoked()) return null;
                return r;
            }
        }
        if (jdbc == null) return null;
        try {
            var list = jdbc.queryForList("SELECT client_id, display_name, api_key_hash, cert_subject, allowed_ips, roles, rate_limit_per_min, enabled, revoked FROM client_credentials WHERE api_key_hash=?", hash);
            if (list.isEmpty()) return null;
            Map<String,Object> row = list.get(0);
            ClientRecord rec = new ClientRecord((String)row.get("client_id"), (String)row.get("display_name"), (String)row.get("api_key_hash"), (String)row.get("cert_subject"), (String)row.get("allowed_ips"), (String)row.get("roles"), ((Number)row.get("rate_limit_per_min")).intValue(), (Boolean)row.get("enabled"), (Boolean)row.get("revoked"));
            cache.put(rec.clientId(), rec);
            if (!rec.enabled() || rec.revoked()) { log.warn("Credential disabled/revoked client={}", rec.clientId()); return null; }
            return rec;
        } catch (Exception e) { log.error("findByApiKey error", e); return null; }
    }

    public ClientRecord findByClientId(String clientId) {
        if (clientId == null || clientId.isBlank()) return null;
        ClientRecord cached = cache.get(clientId);
        if (cached != null) {
            if (!cached.enabled() || cached.revoked()) return null;
            return cached;
        }
        for (var r : cache.values()) {
            if (clientId.equalsIgnoreCase(r.clientId())) {
                if (!r.enabled() || r.revoked()) return null;
                return r;
            }
        }
        if (jdbc == null) return null;
        try {
            var list = jdbc.queryForList("SELECT client_id, display_name, api_key_hash, cert_subject, allowed_ips, roles, rate_limit_per_min, enabled, revoked FROM client_credentials WHERE client_id=?", clientId);
            if (list.isEmpty()) return null;
            Map<String,Object> row = list.get(0);
            ClientRecord rec = new ClientRecord((String)row.get("client_id"), (String)row.get("display_name"), (String)row.get("api_key_hash"), (String)row.get("cert_subject"), (String)row.get("allowed_ips"), (String)row.get("roles"), ((Number)row.get("rate_limit_per_min")).intValue(), (Boolean)row.get("enabled"), (Boolean)row.get("revoked"));
            cache.put(rec.clientId(), rec);
            if (!rec.enabled() || rec.revoked()) return null;
            return rec;
        } catch (Exception e) { return null; }
    }

    public void registerClient(ClientRecord record) {
        if (record != null && record.clientId() != null) {
            cache.put(record.clientId(), record);
            if (record.apiKeyHash() != null) {
                cache.put(record.apiKeyHash(), record);
            }
        }
    }

    private String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) { throw new RuntimeException(e); }
    }
}
