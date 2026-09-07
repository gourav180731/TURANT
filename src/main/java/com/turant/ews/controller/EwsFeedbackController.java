package com.turant.ews.controller;

import com.turant.ews.EwsService;
import com.turant.ews.dto.EwsFeedback;
import com.turant.ews.exception.EwsException;
import com.turant.http.ApiError;
import com.turant.security.SecurityService;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.Map;

/**
 * EWS Feedback / Callback endpoint — EWS calls TURANT back with delivery feedback.
 * POST /api/v1/ews/feedback
 *
 * Requirements:
 * - authenticate caller via existing security architecture
 * - validate payload
 * - extract alert/reference/correlation ID
 * - persist feedback, idempotent, prevent duplicate corruption
 * - never trust arbitrary alert IDs without validation
 */
@RestController
@RequestMapping("/api/v1/ews")
public class EwsFeedbackController {

    private static final Logger log = LoggerFactory.getLogger(EwsFeedbackController.class);
    private final EwsService ewsService;
    private final SecurityService securityService;

    public EwsFeedbackController(EwsService ewsService,
                                 @Autowired(required = false) SecurityService securityService) {
        this.ewsService = ewsService;
        this.securityService = securityService;
    }

    @PostMapping("/feedback")
    public ResponseEntity<?> feedback(@RequestBody(required = false) EwsFeedback feedback,
                                      HttpServletRequest httpReq) {
        // Authenticate via existing security (ApiKey / mTLS)
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, feedback != null ? feedback.alertId() : null);
            if (!sec.allowed()) {
                ApiError err = ApiError.of(httpReq, sec.httpStatus(),
                        sec.httpStatus() == 401 ? "Unauthorized" : sec.httpStatus() == 429 ? "Too Many Requests" : "Forbidden",
                        sec.code(), sec.message());
                return ResponseEntity.status(sec.httpStatus()).body(err);
            }
        }

        // Validate payload
        if (feedback == null || feedback.alertId() == null || feedback.alertId().isBlank()) {
            ApiError err = ApiError.of(httpReq, 400, "Bad Request", "INVALID_REQUEST", "alertId is required in feedback payload");
            return ResponseEntity.badRequest().body(err);
        }
        // Basic alertId validation — prevent arbitrary IDs without format check
        String alertId = feedback.alertId().trim();
        if (alertId.length() > 255 || !alertId.matches("[A-Za-z0-9._-]+")) {
            ApiError err = ApiError.of(httpReq, 400, "Bad Request", "INVALID_REQUEST", "Invalid alertId format");
            return ResponseEntity.badRequest().body(err);
        }

        try {
            String refId = feedback.referenceId();
            boolean isDuplicate = ewsService.isDuplicateFeedback(alertId, refId);
            EwsFeedback stored = ewsService.handleFeedback(feedback);
            if (isDuplicate) {
                log.info("EWS feedback duplicate acknowledged (idempotent): alertId={}, referenceId={}", alertId, refId);
                return ResponseEntity.ok(Map.of(
                        "status", "acknowledged",
                        "duplicate", true,
                        "alertId", alertId,
                        "referenceId", refId != null ? refId : "",
                        "timestamp", Instant.now().toString(),
                        "message", "Duplicate feedback — already processed (idempotent)"
                ));
            }
            log.info("EWS feedback acknowledged: alertId={}, referenceId={}, status={}", alertId, refId, feedback.status());
            return ResponseEntity.ok(Map.of(
                    "status", "acknowledged",
                    "duplicate", false,
                    "alertId", alertId,
                    "referenceId", refId != null ? refId : "",
                    "timestamp", Instant.now().toString(),
                    "message", "Feedback received and persisted"
            ));
        } catch (EwsException e) {
            int httpStatus = e.getHttpStatus() != null ? e.getHttpStatus() : 400;
            ApiError err = ApiError.of(httpReq, httpStatus, "EWS Feedback Error",
                    e.getErrorCode() != null ? e.getErrorCode().name() : "INVALID_REQUEST", e.getMessage());
            return ResponseEntity.status(httpStatus).body(err);
        } catch (Exception e) {
            log.error("EWS feedback error: alertId={}", feedback.alertId(), e);
            ApiError err = ApiError.of(httpReq, 500, "Internal Server Error", "SERVER_ERROR", "Failed to process feedback");
            return ResponseEntity.status(500).body(err);
        }
    }

    @GetMapping("/feedback/{alertId}")
    public ResponseEntity<?> getFeedback(@PathVariable String alertId, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, alertId);
            if (!sec.allowed()) {
                return ResponseEntity.status(sec.httpStatus())
                        .body(ApiError.of(httpReq, sec.httpStatus(), "Unauthorized", sec.code(), sec.message()));
            }
        }
        var store = ewsService.getFeedbackStore();
        var matches = store.entrySet().stream()
                .filter(e -> e.getKey().startsWith(alertId + "::"))
                .map(Map.Entry::getValue)
                .toList();
        if (matches.isEmpty()) {
            return ResponseEntity.status(404)
                    .body(ApiError.of(httpReq, 404, "Not Found", "FEEDBACK_NOT_FOUND", "No feedback found for alertId: " + alertId));
        }
        return ResponseEntity.ok(Map.of("alertId", alertId, "count", matches.size(), "feedbacks", matches));
    }
}
