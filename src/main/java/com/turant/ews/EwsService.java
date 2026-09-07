package com.turant.ews;

import com.turant.ews.dto.EwsFeedback;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import com.turant.ews.exception.EwsErrorCode;
import com.turant.ews.exception.EwsException;
import com.turant.pipeline.PipelineStatusStore;
import com.turant.types.report.AlertReport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * EWS Service — central business logic for EWS integration.
 * Used by controllers and pipeline (non-blocking).
 * Preserves existing CAP → pipeline flow; EWS feedback is async and never blocks subscriber matching.
 */
@Service
public class EwsService {

    private static final Logger log = LoggerFactory.getLogger(EwsService.class);

    private final EwsClientFactory clientFactory;
    private final PipelineStatusStore statusStore;
    private final JdbcTemplate jdbc;

    // In-memory feedback store for idempotency when DB not available
    private final Map<String, EwsFeedback> feedbackStore = new ConcurrentHashMap<>();
    private final Map<String, Instant> feedbackTimestamps = new ConcurrentHashMap<>();

    @Autowired
    public EwsService(EwsClientFactory clientFactory,
                      PipelineStatusStore statusStore,
                      @Autowired(required = false) JdbcTemplate jdbc) {
        this.clientFactory = clientFactory;
        this.statusStore = statusStore;
        this.jdbc = jdbc;
        // feedback table creation is lazy — best effort
        initFeedbackTable();
    }

    private void initFeedbackTable() {
        if (jdbc == null) return;
        try {
            jdbc.execute("""
                    CREATE TABLE IF NOT EXISTS ews_feedback (
                        id UUID PRIMARY KEY,
                        alert_id VARCHAR(255) NOT NULL,
                        cap_identifier VARCHAR(255),
                        reference_id VARCHAR(255),
                        status VARCHAR(50),
                        message TEXT,
                        payload TEXT,
                        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(alert_id, reference_id)
                    )
                    """);
        } catch (Exception e) {
            log.debug("EWS feedback table init skipped: {}", e.getMessage());
        }
    }

    /**
     * Send via mode-selected client (LOCAL or REMOTE per turant.ews.mode).
     */
    public EwsResponse send(EwsRequest request) {
        EwsClient client = clientFactory.getClient();
        log.info("EWS send: mode={}, alertId={}", client.getMode(), request.alertId());
        return client.send(request);
    }

    /**
     * Explicit local send — used by /api/v1/ews/local/test, never calls remote server.
     */
    public EwsResponse sendLocal(EwsRequest request) {
        return clientFactory.getLocalClient().send(request);
    }

    /**
     * Explicit remote send — used by /api/v1/ews/test-remote.
     * Rejects if mode != remote (no silent fallback).
     */
    public EwsResponse sendRemote(EwsRequest request) {
        if (!clientFactory.isRemoteMode()) {
            throw new EwsException(EwsErrorCode.UNSUPPORTED_MODE,
                    "EWS is not configured in remote mode (current mode: " + clientFactory.getClient().getMode() + ")", 400);
        }
        return clientFactory.getRemoteClient().send(request);
    }

    /**
     * Send AlertReport completion feedback to EWS (called by pipeline after completion).
     * Non-blocking — called async from AlertPipeline.
     */
    public EwsResponse sendReport(AlertReport report) {
        EwsRequest req = new EwsRequest(report.alertId(), report.capIdentifier(),
                "Pipeline completion feedback", "INFO", report);
        return send(req);
    }

    /**
     * Handle inbound EWS feedback callback: POST /api/v1/ews/feedback
     * Validates, deduplicates, persists, updates pipeline state if applicable.
     * Idempotent — duplicate feedback with same alertId+referenceId does not corrupt state.
     */
    public EwsFeedback handleFeedback(EwsFeedback feedback) {
        if (feedback == null || feedback.alertId() == null || feedback.alertId().isBlank()) {
            throw new EwsException(EwsErrorCode.INVALID_REQUEST, "alertId is required", 400);
        }
        String alertId = feedback.alertId().trim();
        String referenceId = feedback.referenceId() != null ? feedback.referenceId().trim() : "";
        String dedupKey = alertId + "::" + referenceId;

        // Idempotency: check duplicate
        if (feedbackStore.containsKey(dedupKey)) {
            log.info("Duplicate EWS feedback ignored (idempotent): alertId={}, referenceId={}", alertId, referenceId);
            return feedbackStore.get(dedupKey);
        }
        if (jdbc != null) {
            try {
                Integer cnt = jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ews_feedback WHERE alert_id=? AND COALESCE(reference_id,'')=COALESCE(?,'')",
                        Integer.class, alertId, referenceId.isEmpty() ? null : referenceId);
                if (cnt != null && cnt > 0) {
                    log.info("Duplicate EWS feedback found in DB: alertId={}, referenceId={}", alertId, referenceId);
                    feedbackStore.put(dedupKey, feedback);
                    return feedback;
                }
            } catch (Exception e) {
                log.debug("EWS feedback duplicate check DB fallback: {}", e.getMessage());
            }
        }

        // Persist
        feedbackStore.put(dedupKey, feedback);
        feedbackTimestamps.put(dedupKey, Instant.now());
        if (jdbc != null) {
            try {
                jdbc.update(
                        "INSERT INTO ews_feedback (id, alert_id, cap_identifier, reference_id, status, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        UUID.randomUUID(), alertId, feedback.capIdentifier(), referenceId.isEmpty() ? null : referenceId,
                        feedback.status(), feedback.message(),
                        feedback.rawPayload() != null ? feedback.rawPayload() : feedback.toString(),
                        Timestamp.from(Instant.now()));
            } catch (Exception e) {
                log.debug("EWS feedback DB persist fallback to memory: {}", e.getMessage());
            }
        }

        // Optionally update pipeline state if feedback correlates to known alert
        try {
            if (statusStore != null && feedback.capIdentifier() != null) {
                var existing = statusStore.get(feedback.capIdentifier());
                if (existing != null) {
                    log.info("EWS feedback correlated to pipeline: capIdentifier={}, existingStatus={}", feedback.capIdentifier(), existing.status());
                }
            }
        } catch (Exception e) {
            log.debug("EWS feedback pipeline correlation ignored: {}", e.getMessage());
        }

        log.info("EWS feedback stored: alertId={}, referenceId={}, status={}", alertId, referenceId, feedback.status());
        return feedback;
    }

    public boolean isDuplicateFeedback(String alertId, String referenceId) {
        String key = (alertId != null ? alertId.trim() : "") + "::" + (referenceId != null ? referenceId.trim() : "");
        return feedbackStore.containsKey(key);
    }

    public Map<String, EwsFeedback> getFeedbackStore() {
        return feedbackStore;
    }
}
