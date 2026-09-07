package com.turant.ews.controller;

import com.turant.ews.EwsService;
import com.turant.ews.config.EwsProperties;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import com.turant.ews.exception.EwsException;
import com.turant.http.ApiError;
import com.turant.security.SecurityService;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/**
 * Remote EWS test endpoint — invokes configured remote EWS client.
 * POST /api/v1/ews/test-remote
 * Validates mode==remote, never logs secrets, never switches mode dynamically.
 */
@RestController
@RequestMapping("/api/v1/ews")
public class EwsRemoteController {

    private static final Logger log = LoggerFactory.getLogger(EwsRemoteController.class);
    private final EwsService ewsService;
    private final EwsProperties properties;
    private final SecurityService securityService;

    public EwsRemoteController(EwsService ewsService, EwsProperties properties,
                               @Autowired(required = false) SecurityService securityService) {
        this.ewsService = ewsService;
        this.properties = properties;
        this.securityService = securityService;
    }

    @PostMapping("/test-remote")
    public ResponseEntity<?> testRemote(@RequestBody(required = false) EwsRequest request,
                                        HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, request != null ? request.alertId() : null);
            if (!sec.allowed()) {
                ApiError err = ApiError.of(httpReq, sec.httpStatus(),
                        sec.httpStatus() == 401 ? "Unauthorized" : "Forbidden",
                        sec.code(), sec.message());
                return ResponseEntity.status(sec.httpStatus()).body(err);
            }
        }

        if (request == null || request.alertId() == null || request.alertId().isBlank()) {
            ApiError err = ApiError.of(httpReq, 400, "Bad Request", "INVALID_REQUEST", "alertId is required");
            return ResponseEntity.badRequest().body(err);
        }

        // Must be in remote mode — no silent fallback
        if (!"remote".equalsIgnoreCase(properties.getMode())) {
            log.warn("Remote EWS test rejected: mode={} (remote required)", properties.getMode());
            // Return clear error per spec
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(java.util.Map.of(
                            "mode", properties.getMode(),
                            "status", "rejected",
                            "reason", "EWS is not configured in remote mode",
                            "httpStatus", 400,
                            "code", "UNSUPPORTED_MODE"
                    ));
        }

        try {
            EwsResponse resp = ewsService.sendRemote(request);
            // Log correlation/referenceId only — never secrets
            log.info("Remote EWS test succeeded: alertId={}, referenceId={}, mode=remote", request.alertId(), resp.referenceId());
            return ResponseEntity.ok(resp);
        } catch (EwsException e) {
            // Map EwsException to appropriate HTTP status, never leak credentials
            int httpStatus = e.getHttpStatus() != null ? e.getHttpStatus() : mapErrorCode(e.getErrorCode());
            log.warn("Remote EWS test failed: alertId={}, errorCode={}, httpStatus={}", request.alertId(), e.getErrorCode(), httpStatus);
            String code = e.getErrorCode() != null ? e.getErrorCode().name() : "SERVER_ERROR";
            // Distinguish error types per spec (do not convert all to 200)
            if (e.getErrorCode() == com.turant.ews.exception.EwsErrorCode.AUTHENTICATION_FAILURE) {
                return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                        .body(java.util.Map.of("mode", "remote", "status", "AUTHENTICATION_FAILURE", "code", code, "message", e.getMessage(), "httpStatus", 401));
            }
            if (e.getErrorCode() == com.turant.ews.exception.EwsErrorCode.TIMEOUT) {
                return ResponseEntity.status(HttpStatus.GATEWAY_TIMEOUT)
                        .body(java.util.Map.of("mode", "remote", "status", "TIMEOUT", "code", code, "message", e.getMessage(), "httpStatus", 504));
            }
            if (e.getErrorCode() == com.turant.ews.exception.EwsErrorCode.CONNECTION_FAILURE) {
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                        .body(java.util.Map.of("mode", "remote", "status", "CONNECTION_FAILURE", "code", code, "message", e.getMessage(), "httpStatus", 502));
            }
            ApiError err = ApiError.of(httpReq, httpStatus, "EWS Error", code, e.getMessage());
            return ResponseEntity.status(httpStatus).body(err);
        } catch (Exception e) {
            log.error("Remote EWS unexpected error: alertId={}", request.alertId(), e);
            ApiError err = ApiError.of(httpReq, 500, "Internal Server Error", "SERVER_ERROR", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(err);
        }
    }

    private int mapErrorCode(com.turant.ews.exception.EwsErrorCode code) {
        if (code == null) return 500;
        return switch (code) {
            case INVALID_REQUEST -> 400;
            case AUTHENTICATION_FAILURE -> 401;
            case REMOTE_REJECTED -> 409;
            case TIMEOUT -> 504;
            case CONNECTION_FAILURE -> 502;
            case SERVER_ERROR -> 500;
            default -> 500;
        };
    }
}
