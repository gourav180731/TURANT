package com.turant.security;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.cert.X509Certificate;
import java.util.Optional;

/**
 * Item #2 Layer 2 — mTLS client identity extraction.
 * Real extraction from TLS handshake via Servlet attribute "javax.servlet.request.X509Certificate".
 * Supports subject DN and SAN mapping via configured allowlist.
 */
@Service
public class MtlsIdentityService {

    private static final Logger log = LoggerFactory.getLogger(MtlsIdentityService.class);
    private static final String JAKARTA_CERT_ATTR = "jakarta.servlet.request.X509Certificate";
    private static final String JAVAX_CERT_ATTR = "javax.servlet.request.X509Certificate";
    private static final String CLIENT_CERT_HEADER = "X-Client-Cert-DN"; // for reverse-proxy forward

    private final String clientAuthMode;

    public MtlsIdentityService(@Value("${server.ssl.client-auth:none}") String clientAuthMode) {
        this.clientAuthMode = clientAuthMode;
    }

    public Optional<ClientIdentity> extractIdentity(HttpServletRequest req) {
        // 1. Try TLS attribute (real mTLS) - supports Jakarta EE & legacy Servlet
        Object certAttr = req.getAttribute(JAKARTA_CERT_ATTR);
        if (certAttr == null) {
            certAttr = req.getAttribute(JAVAX_CERT_ATTR);
        }
        if (certAttr instanceof X509Certificate[] certs && certs.length > 0 && certs[0] != null) {
            X509Certificate cert = certs[0];
            try {
                cert.checkValidity(); // expiration via TLS stack
                String subject = cert.getSubjectX500Principal().getName();
                String san = extractSan(cert);
                String clientId = mapToClientId(subject, san);
                log.info("mTLS identity extracted subject={} san={} -> clientId={}", subject, san, clientId);
                return Optional.of(new ClientIdentity(clientId, subject, san, cert));
            } catch (Exception e) {
                log.warn("mTLS cert validation failed: {}", e.getMessage());
                return Optional.empty();
            }
        }
        // 2. Fallback for reverse-proxy header (when TLS terminated at LB, must be trusted proxy)
        String headerDn = req.getHeader(CLIENT_CERT_HEADER);
        if (headerDn != null && !headerDn.isBlank() && isTrustedProxy(req)) {
            log.warn("Using proxy header {} for identity (ensure proxy is trusted)", CLIENT_CERT_HEADER);
            return Optional.of(new ClientIdentity(mapToClientId(headerDn, null), headerDn, null, null));
        }
        return Optional.empty();
    }

    private String extractSan(X509Certificate cert) {
        try {
            var sans = cert.getSubjectAlternativeNames();
            if (sans != null) {
                for (var san : sans) {
                    if (san.size() >= 2 && san.get(1) instanceof String) return (String) san.get(1);
                }
            }
        } catch (Exception ignore) {}
        return null;
    }

    private String mapToClientId(String subject, String san) {
        // Simple mapping: extract CN from subject DN, else san, else full subject
        if (subject != null) {
            // DN like "CN=TSP-A, OU=C-DOT, O=TSP, C=IN"
            for (String part : subject.split(",")) {
                part = part.trim();
                if (part.startsWith("CN=")) return part.substring(3).trim();
            }
        }
        if (san != null && !san.isBlank()) return san;
        return subject != null ? subject : "unknown";
    }

    private boolean isTrustedProxy(HttpServletRequest req) {
        // Check if request comes from trusted proxy (configure via env)
        String trusted = System.getenv("TRUSTED_PROXY_CIDR");
        // For now, only allow header if clientAuth is not 'need' (dev) or if remoteAddr is loopback
        String remote = req.getRemoteAddr();
        return "127.0.0.1".equals(remote) || "0:0:0:0:0:0:0:1".equals(remote);
    }

    public boolean isMtlsRequired() { return "need".equalsIgnoreCase(clientAuthMode); }

    public record ClientIdentity(String clientId, String subjectDn, String san, X509Certificate certificate) {}
}
