package com.turant.ews;

import com.turant.ews.config.EwsProperties;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.UUID;

/**
 * LOCAL / controlled EWS implementation — development, testing, demonstrations.
 * Clearly marked as DEVELOPMENT/TEST behavior; never used when EWS_MODE=remote.
 *
 * When turant.ews.local-url (EWS_LOCAL_URL) is configured, this client performs
 * a real HTTP POST to the controlled local EWS endpoint (e.g., http://localhost:8080/api/v1/ews/local/receive).
 * The HTTP/network interaction is real (RestClient → Spring MVC), not in-memory.
 * If localUrl is blank or HTTP fails, it falls back to in-memory deterministic success for backward compat.
 */
@Component
public class LocalEwsClient implements EwsClient {

    private static final Logger log = LoggerFactory.getLogger(LocalEwsClient.class);
    private final EwsProperties properties;
    private final RestClient restClient;
    private final String serverPort;
    private final Environment environment;
    private final LocalEwsStore localStore;

    @Autowired
    public LocalEwsClient(EwsProperties properties,
                          @Value("${server.port:8080}") String serverPort,
                          Environment environment,
                          @Autowired(required = false) LocalEwsStore localStore) {
        this.properties = properties;
        this.serverPort = serverPort;
        this.environment = environment;
        this.localStore = localStore;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) properties.getConnectTimeout().toMillis());
        factory.setReadTimeout((int) properties.getReadTimeout().toMillis());
        this.restClient = RestClient.builder().requestFactory(factory).build();
    }

    @Override
    public EwsResponse send(EwsRequest request) {
        if (request == null || request.alertId() == null || request.alertId().isBlank()) {
            log.warn("[LOCAL EWS] Rejected: missing alertId");
            return new EwsResponse("local", EwsResponse.EwsStatus.INVALID_REQUEST.name(),
                    null, Instant.now().toString(), null, "alertId is required", "INVALID_REQUEST", 400);
        }

        String localUrl = properties.getLocalUrl();
        // Resolve effective HTTP URL: explicit localUrl > dynamic loopback via local.server.port > server.port > in-memory fallback
        String effectiveUrl = null;
        if (localUrl != null && !localUrl.isBlank()) {
            effectiveUrl = localUrl.trim();
        } else {
            // Try to resolve actual running port (local.server.port is set after server starts with RANDOM_PORT)
            String localPort = null;
            try {
                localPort = environment.getProperty("local.server.port");
            } catch (Exception ignored) {}
            if (localPort != null && !localPort.isBlank() && !"0".equals(localPort)) {
                effectiveUrl = "http://localhost:" + localPort + "/api/v1/ews/local/receive";
            } else if (serverPort != null && !serverPort.isBlank() && !"0".equals(serverPort)) {
                effectiveUrl = "http://localhost:" + serverPort + "/api/v1/ews/local/receive";
            }
        }

        if (effectiveUrl != null) {
            log.info("[LOCAL EWS] HTTP POST to controlled local EWS: alertId={}, capIdentifier={}, url={}", request.alertId(), request.capIdentifier(), effectiveUrl);
            try {
                EwsResponse resp = restClient.post()
                        .uri(effectiveUrl)
                        .contentType(MediaType.APPLICATION_JSON)
                        .body(request)
                        .retrieve()
                        .body(EwsResponse.class);
                if (resp != null) {
                    log.info("[LOCAL EWS] HTTP success: alertId={}, referenceId={}, status={}", request.alertId(), resp.referenceId(), resp.status());
                    // The receive controller already stored to LocalEwsStore; no need to double-store
                    return resp;
                }
            } catch (Exception e) {
                log.warn("[LOCAL EWS] HTTP to {} failed for alertId={}, falling back to in-memory: {}", effectiveUrl, request.alertId(), e.getMessage());
                // fall through to in-memory
            }
        } else {
            log.debug("[LOCAL EWS] No effective localUrl, using in-memory deterministic response for alertId={}", request.alertId());
        }

        // In-memory fallback (deterministic, for tests without HTTP server or when localUrl blank)
        log.info("[LOCAL EWS] Simulating EWS send: alertId={}, capIdentifier={}, severity={}, mode=local",
                request.alertId(), request.capIdentifier(), request.severity());
        String referenceId = "LOCAL-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        EwsResponse fallbackResp = new EwsResponse(
                "local",
                "accepted",
                referenceId,
                Instant.now().toString(),
                request.alertId(),
                "Local EWS test request accepted (DEVELOPMENT/TEST behavior — controlled endpoint or in-memory fallback)",
                "ACCEPTED",
                200
        );
        // Record to store for manual inspection even in fallback
        if (localStore != null) {
            try {
                localStore.record(request, fallbackResp);
            } catch (Exception ignored) {}
        }
        return fallbackResp;
    }

    @Override
    public String getMode() {
        return "local";
    }
}
