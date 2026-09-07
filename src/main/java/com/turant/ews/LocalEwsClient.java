package com.turant.ews;

import com.turant.ews.config.EwsProperties;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.UUID;

/**
 * LOCAL / mock EWS implementation — development, testing, demonstrations.
 * Clearly marked as DEVELOPMENT/TEST behavior; never used when EWS_MODE=remote.
 *
 * Simulates EWS interaction without contacting any external server.
 */
@Component
public class LocalEwsClient implements EwsClient {

    private static final Logger log = LoggerFactory.getLogger(LocalEwsClient.class);
    private final EwsProperties properties;

    public LocalEwsClient(EwsProperties properties) {
        this.properties = properties;
    }

    @Override
    public EwsResponse send(EwsRequest request) {
        // Validate (mirror real validation where appropriate, but do not fabricate success blindly)
        if (request == null || request.alertId() == null || request.alertId().isBlank()) {
            log.warn("[LOCAL EWS] Rejected: missing alertId");
            return new EwsResponse("local", EwsResponse.EwsStatus.INVALID_REQUEST.name(),
                    null, Instant.now().toString(), null, "alertId is required", "INVALID_REQUEST", 400);
        }
        // DEVELOPMENT/TEST marker
        log.info("[LOCAL EWS] Simulating EWS send: alertId={}, capIdentifier={}, severity={}, mode=local",
                request.alertId(), request.capIdentifier(), request.severity());
        String referenceId = "LOCAL-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        return new EwsResponse(
                "local",
                "accepted",
                referenceId,
                Instant.now().toString(),
                request.alertId(),
                "Local EWS test request accepted (DEVELOPMENT/TEST behavior — no external call)",
                "ACCEPTED",
                200
        );
    }

    @Override
    public String getMode() {
        return "local";
    }
}
