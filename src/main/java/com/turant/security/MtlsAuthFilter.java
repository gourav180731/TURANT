package com.turant.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.turant.http.ApiError;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Item #2 Layer 2 — mTLS enforcement.
 * Validates client cert presence when server.ssl.client-auth=need (prod).
 * Never trust X-CLIENT-ID header as identity — identity must come from verified cert.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 11)
public class MtlsAuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(MtlsAuthFilter.class);
    private final MtlsIdentityService mtlsService;
    private final ObjectMapper objectMapper = new ObjectMapper();
    public static final String CLIENT_ID_ATTR = "turant.clientId";
    public static final String CLIENT_CERT_ATTR = "turant.clientCert";

    public MtlsAuthFilter(MtlsIdentityService mtlsService) { this.mtlsService = mtlsService; }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest req) {
        String path = req.getRequestURI();
        // Only enforce mTLS for protected APIs (same as ApiKey)
        if (path.equals("/healthz") || path.startsWith("/swagger-ui") || path.startsWith("/v3/api-docs") || path.startsWith("/api-docs")) return true;
        if (!path.startsWith("/api/v1/pipeline/") && !path.startsWith("/api/v1/alerts/")) return true;
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        boolean mtlsRequired = mtlsService.isMtlsRequired();
        var identityOpt = mtlsService.extractIdentity(request);

        if (mtlsRequired && identityOpt.isEmpty()) {
            log.warn("mTLS required but no client certificate for {} {}", request.getMethod(), request.getRequestURI());
            writeUnauthorized(request, response, "Client certificate required (mTLS)");
            return;
        }

        // If cert present but invalid, extractIdentity returns empty and mtlsRequired would have already rejected.
        // For need=false, we allow missing cert but if present we still validate.
        if (identityOpt.isPresent()) {
            var id = identityOpt.get();
            // Never allow X-CLIENT-ID to override mTLS identity
            String spoofed = request.getHeader("X-CLIENT-ID");
            if (spoofed != null && !spoofed.equals(id.clientId())) {
                log.warn("X-CLIENT-ID header {} does not match mTLS identity {} — ignoring header", spoofed, id.clientId());
            }
            request.setAttribute(CLIENT_ID_ATTR, id.clientId());
            request.setAttribute(CLIENT_CERT_ATTR, id.certificate());
            log.info("mTLS authenticated clientId={} subject={}", id.clientId(), id.subjectDn());
        } else {
            // No cert, but not required (dev) — allow, but mark as unauthenticated for audit
            request.setAttribute(CLIENT_ID_ATTR, "anonymous");
        }

        // Revocation check placeholder — production must configure OCSP/CRL via truststore
        // Documented in SECURITY_COMPLETE.md §5 Limitations

        chain.doFilter(request, response);
    }

    private void writeUnauthorized(HttpServletRequest req, HttpServletResponse res, String msg) throws IOException {
        ApiError err = ApiError.of(req, 401, "Unauthorized", "CERTIFICATE_FAILURE", msg);
        res.setStatus(401);
        res.setContentType("application/json");
        res.setHeader("WWW-Authenticate", "Client-Cert realm=\"turant\"");
        res.getWriter().write(objectMapper.writeValueAsString(err));
    }
}
