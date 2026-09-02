package com.turant.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.Set;

/**
 * Item #2 Layer 4 — Authorization / Policy Engine
 * Centralized, default-deny. Maps clientId + roles → allowed operations.
 */
@Service
public class AuthorizationService {

    private static final Logger log = LoggerFactory.getLogger(AuthorizationService.class);

    public enum Operation { SUBMIT_CAP, GET_STATUS, GET_TOWERS, GET_REPORT, DELETE_ALERT, ADMIN_CONFIG, HEALTH }

    public boolean isAllowed(String clientId, Set<String> roles, Operation op, String endpoint, String method) {
        if (op == Operation.HEALTH) return true; // health always allowed
        if (clientId == null) return false;
        if (roles == null || roles.isEmpty()) return false;
        // Default deny
        boolean allowed = switch (op) {
            case SUBMIT_CAP -> roles.contains("SUBMIT_CAP") || roles.contains("EWS_SUBMIT");
            case GET_STATUS -> roles.contains("GET_STATUS") || roles.contains("EWS_SUBMIT");
            case GET_TOWERS -> roles.contains("GET_TOWERS") || roles.contains("EWS_SUBMIT");
            case GET_REPORT -> roles.contains("GET_REPORT") || roles.contains("EWS_SUBMIT");
            case DELETE_ALERT -> roles.contains("ADMIN") || roles.contains("DELETE_ALERT");
            case ADMIN_CONFIG -> roles.contains("ADMIN");
            case HEALTH -> true;
        };
        log.info("AUTHZ client={} roles={} op={} endpoint={} -> {}", clientId, roles, op, endpoint, allowed ? "ALLOWED" : "DENIED");
        return allowed;
    }

    public Operation operationFor(String path, String method) {
        if (path.equals("/api/v1/pipeline/trigger-by-cap") && "POST".equalsIgnoreCase(method)) return Operation.SUBMIT_CAP;
        if (path.equals("/api/v1/pipeline/trigger") && "POST".equalsIgnoreCase(method)) return Operation.SUBMIT_CAP;
        if (path.startsWith("/api/v1/pipeline/status/") && "GET".equalsIgnoreCase(method)) return Operation.GET_STATUS;
        if (path.startsWith("/api/v1/pipeline/towers/") && "GET".equalsIgnoreCase(method)) return Operation.GET_TOWERS;
        if (path.startsWith("/api/v1/pipeline/report/") && "GET".equalsIgnoreCase(method)) return Operation.GET_REPORT;
        if (path.startsWith("/api/v1/pipeline/status/") && "DELETE".equalsIgnoreCase(method)) return Operation.DELETE_ALERT;
        if (path.equals("/healthz") && "GET".equalsIgnoreCase(method)) return Operation.HEALTH;
        if (path.startsWith("/api/v1/alerts/") && "POST".equalsIgnoreCase(method)) return Operation.SUBMIT_CAP;
        return Operation.GET_STATUS;
    }

    public Set<String> rolesFor(ClientCredentialsService.ClientRecord rec) {
        if (rec == null || rec.roles() == null) return Set.of();
        return java.util.Arrays.stream(rec.roles().split(","))
                .map(String::trim)
                .filter(s -> !s.isBlank())
                .collect(java.util.stream.Collectors.toSet());
    }
}
