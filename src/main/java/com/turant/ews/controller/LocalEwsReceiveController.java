package com.turant.ews.controller;

import com.turant.ews.LocalEwsStore;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Controlled local EWS endpoint — the actual runnable local EWS server.
 * This controller IS the local EWS for development/demonstration.
 *
 * Pipeline → EwsService → LocalEwsClient → HTTP → this controller.
 * The HTTP/network interaction is real (RestClient → Spring MVC), not in-memory.
 *
 * Responsibilities:
 * - Receive EWS report from TURANT
 * - Log/record request (for manual inspection)
 * - Validate (alertId required etc.)
 * - Return deterministic success (mode=local, status=accepted)
 * - Allow failure simulation for testing (?simulateFailure=401 etc.)
 * - Allow payload inspection via GET /api/v1/ews/local/last-received
 */
@RestController
@RequestMapping("/api/v1/ews/local")
public class LocalEwsReceiveController {

    private static final Logger log = LoggerFactory.getLogger(LocalEwsReceiveController.class);
    private final LocalEwsStore store;

    public LocalEwsReceiveController(LocalEwsStore store) {
        this.store = store;
    }

    /**
     * Primary local EWS receive endpoint — pipeline's Activity 7 posts here when EWS_MODE=local.
     * This is the controlled local EWS server.
     */
    @PostMapping("/receive")
    public ResponseEntity<?> receive(
            @RequestBody(required = false) EwsRequest request,
            @RequestParam(value = "simulateFailure", required = false) String simulateFailure,
            @RequestHeader(value = "X-EWS-FAIL", required = false) String headerFail) {

        String failCode = simulateFailure != null ? simulateFailure : headerFail;

        // Allow failure simulation for testing error paths
        if (failCode != null && !failCode.isBlank()) {
            store.recordFailureAttempt();
            int code;
            try {
                code = Integer.parseInt(failCode.trim());
            } catch (NumberFormatException e) {
                code = 500;
            }
            log.warn("[LOCAL EWS] Simulating failure: code={} for alertId={}", code, request != null ? request.alertId() : "null");
            if (code == 401) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("mode", "local", "status", "AUTHENTICATION_FAILURE", "code", "AUTHENTICATION_FAILURE", "message", "Simulated 401", "httpStatus", 401));
            } else if (code == 429) {
                return ResponseEntity.status(429).body(Map.of("mode", "local", "status", "REMOTE_REJECTED", "code", "REMOTE_REJECTED", "message", "Simulated 429", "httpStatus", 429));
            } else if (code >= 400 && code < 500) {
                return ResponseEntity.status(code).body(Map.of("mode", "local", "status", "INVALID_REQUEST", "code", "INVALID_REQUEST", "message", "Simulated " + code, "httpStatus", code));
            } else {
                return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("mode", "local", "status", "SERVER_ERROR", "code", "SERVER_ERROR", "message", "Simulated 500", "httpStatus", 500));
            }
        }

        if (request == null || request.alertId() == null || request.alertId().isBlank()) {
            log.warn("[LOCAL EWS] Rejected: missing alertId");
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("mode", "local", "status", "INVALID_REQUEST", "code", "INVALID_REQUEST", "message", "alertId is required", "httpStatus", 400));
        }

        // Validate alertId format (same as feedback: alphanumeric, dot, underscore, hyphen, up to 255)
        if (request.alertId().length() > 255 || !request.alertId().matches("[A-Za-z0-9._-]+")) {
            log.warn("[LOCAL EWS] Rejected: invalid alertId format: {}", request.alertId());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("mode", "local", "status", "INVALID_REQUEST", "code", "INVALID_REQUEST", "message", "Invalid alertId format", "httpStatus", 400));
        }

        String referenceId = "LOCAL-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        EwsResponse resp = new EwsResponse(
                "local",
                "accepted",
                referenceId,
                Instant.now().toString(),
                request.alertId(),
                "Local EWS report received and accepted (controlled endpoint)",
                "ACCEPTED",
                200
        );

        store.record(request, resp);
        log.info("[LOCAL EWS] Received EWS report: alertId={}, capIdentifier={}, severity={}, payloadType={}, referenceId={}, timestamp={}",
                request.alertId(), request.capIdentifier(), request.severity(),
                request.payload() != null ? request.payload().getClass().getSimpleName() : "null",
                referenceId, resp.timestamp());
        if (request.payload() != null) {
            log.debug("[LOCAL EWS] Payload: {}", request.payload());
        }

        return ResponseEntity.ok(resp);
    }

    /**
     * Inspect last received EWS report — for manual demonstration.
     */
    @GetMapping("/last-received")
    public ResponseEntity<?> lastReceived() {
        EwsRequest req = store.getLastRequest();
        EwsResponse resp = store.getLastResponse();
        if (req == null) {
            return ResponseEntity.ok(Map.of("receivedCount", store.getReceivedCount(), "lastReceived", "none", "message", "No EWS report received yet"));
        }
        return ResponseEntity.ok(Map.of(
                "receivedCount", store.getReceivedCount(),
                "lastReceivedAt", store.getLastReceivedAt().toString(),
                "request", req,
                "response", resp,
                "failureSimulations", store.getFailureSimulations()
        ));
    }

    @GetMapping("/received-count")
    public ResponseEntity<?> receivedCount() {
        return ResponseEntity.ok(Map.of("receivedCount", store.getReceivedCount(), "failureSimulations", store.getFailureSimulations()));
    }

    @GetMapping("/history")
    public ResponseEntity<?> history() {
        return ResponseEntity.ok(Map.of("receivedCount", store.getReceivedCount(), "history", store.getHistory()));
    }

    @PostMapping("/clear")
    public ResponseEntity<?> clear() {
        store.clear();
        log.info("[LOCAL EWS] Store cleared");
        return ResponseEntity.ok(Map.of("status", "cleared", "receivedCount", 0));
    }
}
