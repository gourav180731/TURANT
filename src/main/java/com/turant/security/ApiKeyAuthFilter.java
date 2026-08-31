package com.turant.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.http.ApiError;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * Item #2 Security — API Key authentication for EWS.
 * Canonical EWS endpoint: POST /api/v1/pipeline/trigger-by-cap
 * Supports headers: X-API-KEY, X-EWS-API-KEY, Authorization: Bearer <key>
 * No hardcoded secrets — value from env EWS_API_KEY / turant.security.api-key.
 * When apiKey is blank/disabled, filter is pass-through (dev).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ApiKeyAuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(ApiKeyAuthFilter.class);

    private final String expectedApiKey;
    private final Set<String> protectedPrefixes = Set.of("/api/v1/pipeline/", "/api/v1/alerts/");
    private final Set<String> publicExact = Set.of("/healthz", "/api-docs", "/api-docs.yaml", "/swagger-ui.html");
    private final Set<String> publicPrefixes = Set.of("/swagger-ui/", "/v3/api-docs", "/api-docs/");

    private final ObjectMapper objectMapper = new ObjectMapper();

    public ApiKeyAuthFilter(@Value("${turant.security.api-key:}") String apiKey,
                            @Value("${EWS_API_KEY:}") String ewsApiKey) {
        // EWS_API_KEY env takes precedence, else turant.security.api-key
        String v = (ewsApiKey != null && !ewsApiKey.isBlank()) ? ewsApiKey.trim() : (apiKey != null ? apiKey.trim() : "");
        this.expectedApiKey = v;
        if (v == null || v.isBlank() || "disabled".equalsIgnoreCase(v)) {
            log.warn("ApiKeyAuthFilter: No API key configured (turant.security.api-key / EWS_API_KEY empty) — filter is PASS-THROUGH (dev). Set EWS_API_KEY in production!");
        } else {
            log.info("ApiKeyAuthFilter: API key authentication ENABLED for {} protected prefixes", protectedPrefixes);
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        // Public exact
        if (publicExact.contains(path)) return true;
        for (String p : publicPrefixes) if (path.startsWith(p)) return true;
        // Not protected → public (e.g., /api/v1/sim/clusters in dev)
        boolean protectedPath = protectedPrefixes.stream().anyMatch(path::startsWith);
        if (!protectedPath) return true;
        // If no key configured, allow all (dev)
        if (expectedApiKey == null || expectedApiKey.isBlank() || "disabled".equalsIgnoreCase(expectedApiKey)) return true;
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        // Already filtered public, but double-check
        boolean isProtected = protectedPrefixes.stream().anyMatch(path::startsWith);
        if (!isProtected) {
            chain.doFilter(request, response);
            return;
        }
        if (expectedApiKey == null || expectedApiKey.isBlank() || "disabled".equalsIgnoreCase(expectedApiKey)) {
            chain.doFilter(request, response);
            return;
        }

        String provided = extractApiKey(request);
        if (provided == null || provided.isBlank()) {
            log.warn("Missing API key for {} from {}", path, request.getRemoteAddr());
            writeUnauthorized(request, response, "Missing API key. Send X-API-KEY or Authorization: Bearer <key>");
            return;
        }
        if (!constantTimeEquals(expectedApiKey, provided)) {
            log.warn("Invalid API key for {} from {}", path, request.getRemoteAddr());
            writeUnauthorized(request, response, "Invalid API key");
            return;
        }
        chain.doFilter(request, response);
    }

    private String extractApiKey(HttpServletRequest req) {
        String v = req.getHeader("X-API-KEY");
        if (v != null && !v.isBlank()) return v.trim();
        v = req.getHeader("X-EWS-API-KEY");
        if (v != null && !v.isBlank()) return v.trim();
        v = req.getHeader("X-API-Key");
        if (v != null && !v.isBlank()) return v.trim();
        String auth = req.getHeader("Authorization");
        if (auth != null && auth.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return auth.substring(7).trim();
        }
        return null;
    }

    private void writeUnauthorized(HttpServletRequest req, HttpServletResponse res, String message) throws IOException {
        ApiError err = ApiError.of(req, 401, "Unauthorized", "UNAUTHORIZED", message);
        res.setStatus(401);
        res.setContentType("application/json");
        res.setHeader("WWW-Authenticate", "ApiKey realm=\"turant\"");
        res.getWriter().write(objectMapper.writeValueAsString(err));
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int result = 0;
        for (int i = 0; i < a.length(); i++) result |= a.charAt(i) ^ b.charAt(i);
        return result == 0;
    }
}
