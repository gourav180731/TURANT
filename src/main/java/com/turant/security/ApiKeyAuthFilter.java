package com.turant.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.http.ApiError;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * Item #2 Security — API Key authentication for EWS.
 * Supports per-client DB lookup (client_credentials) + fallback to single EWS_API_KEY env.
 * Also allows mTLS alternative when mTLS is valid.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ApiKeyAuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(ApiKeyAuthFilter.class);

    private final String expectedApiKey;
    private final MtlsIdentityService mtlsIdentityService;
    private final ClientCredentialsService clientCredentialsService;
    private final Set<String> protectedPrefixes = Set.of("/api/v1/pipeline/", "/api/v1/alerts/");
    private final Set<String> publicExact = Set.of("/healthz", "/api-docs", "/api-docs.yaml", "/swagger-ui.html");
    private final Set<String> publicPrefixes = Set.of("/swagger-ui/", "/v3/api-docs", "/api-docs/");

    private final ObjectMapper objectMapper = new ObjectMapper();

    public ApiKeyAuthFilter(@Value("${turant.security.api-key:}") String apiKey,
                            @Value("${EWS_API_KEY:}") String ewsApiKey,
                            @Autowired(required = false) MtlsIdentityService mtlsIdentityService,
                            @Autowired(required = false) ClientCredentialsService clientCredentialsService) {
        String v = (ewsApiKey != null && !ewsApiKey.isBlank()) ? ewsApiKey.trim() : (apiKey != null ? apiKey.trim() : "");
        this.expectedApiKey = v;
        this.mtlsIdentityService = mtlsIdentityService;
        this.clientCredentialsService = clientCredentialsService;
        if (v == null || v.isBlank() || "disabled".equalsIgnoreCase(v)) {
            log.warn("ApiKeyAuthFilter: No API key configured — filter is PASS-THROUGH (dev) unless mTLS required. Set EWS_API_KEY in production!");
        } else {
            log.info("ApiKeyAuthFilter: API key authentication ENABLED for {} (mTLS alternative allowed, per-client DB lookup enabled)", protectedPrefixes);
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        if (publicExact.contains(path)) return true;
        for (String p : publicPrefixes) if (path.startsWith(p)) return true;
        boolean protectedPath = protectedPrefixes.stream().anyMatch(path::startsWith);
        if (!protectedPath) return true;
        if (mtlsIdentityService != null && mtlsIdentityService.isMtlsRequired()) return false;
        if (expectedApiKey == null || expectedApiKey.isBlank() || "disabled".equalsIgnoreCase(expectedApiKey)) return true;
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        boolean isProtected = protectedPrefixes.stream().anyMatch(path::startsWith);
        if (!isProtected) {
            chain.doFilter(request, response);
            return;
        }
        // If mTLS required, let Mtls filter handle — don't fallback to API key
        if (mtlsIdentityService != null && mtlsIdentityService.isMtlsRequired()) {
            chain.doFilter(request, response);
            return;
        }
        if (expectedApiKey == null || expectedApiKey.isBlank() || "disabled".equalsIgnoreCase(expectedApiKey)) {
            // No single key configured — try per-client DB lookup if available
            String provided = extractApiKey(request);
            if (provided != null && !provided.isBlank() && clientCredentialsService != null) {
                var rec = clientCredentialsService.findByApiKey(provided);
                if (rec != null) {
                    request.setAttribute("turant.clientId", rec.clientId());
                    request.setAttribute("turant.clientRecord", rec);
                    chain.doFilter(request, response);
                    return;
                }
            }
            chain.doFilter(request, response);
            return;
        }

        String provided = extractApiKey(request);
        if (provided == null || provided.isBlank()) {
            if (mtlsIdentityService != null && mtlsIdentityService.extractIdentity(request).isPresent()) {
                chain.doFilter(request, response);
                return;
            }
            log.warn("Missing API key for {} from {}", path, request.getRemoteAddr());
            writeUnauthorized(request, response, "Missing API key. Send X-API-KEY or Authorization: Bearer <key>");
            return;
        }
        // Check per-client DB first, then fallback to single expected key
        boolean valid = false;
        String clientId = null;
        if (clientCredentialsService != null) {
            var rec = clientCredentialsService.findByApiKey(provided);
            if (rec != null) {
                valid = true;
                clientId = rec.clientId();
                request.setAttribute("turant.clientId", clientId);
                request.setAttribute("turant.clientRecord", rec);
            }
        }
        if (!valid && constantTimeEquals(expectedApiKey, provided)) {
            valid = true;
            clientId = "tsp-a";
            request.setAttribute("turant.clientId", clientId);
        }
        if (!valid) {
            if (mtlsIdentityService != null && mtlsIdentityService.extractIdentity(request).isPresent()) {
                chain.doFilter(request, response);
                return;
            }
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
