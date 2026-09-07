package com.turant.ews.controller;

import com.turant.ews.EwsService;
import com.turant.ews.config.EwsProperties;
import com.turant.ews.dto.EwsRequest;
import com.turant.ews.dto.EwsResponse;
import com.turant.http.ApiError;
import com.turant.security.SecurityService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.UUID;

/**
 * Local-only EWS test endpoint for development/testing.
 * POST /api/v1/ews/local/test
 * Never calls remote EWS server — uses LocalEwsClient exclusively.
 * Protected by existing security (ApiKey/mTLS).
 */
@RestController
@RequestMapping("/api/v1/ews")
public class EwsLocalController {

    private static final Logger log = LoggerFactory.getLogger(EwsLocalController.class);
    private final EwsService ewsService;
    private final EwsProperties properties;
    private final SecurityService securityService;

    public EwsLocalController(EwsService ewsService, EwsProperties properties,
                              @Autowired(required = false) SecurityService securityService) {
        this.ewsService = ewsService;
        this.properties = properties;
        this.securityService = securityService;
    }

    @PostMapping("/local/test")
    public ResponseEntity<?> localTest(@RequestBody(required = false) EwsRequest request,
                                       HttpServletRequest httpReq) {
        // Security check via existing architecture
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, request != null ? request.alertId() : null);
            if (!sec.allowed()) {
                ApiError err = ApiError.of(httpReq, sec.httpStatus(),
                        sec.httpStatus() == 401 ? "Unauthorized" : sec.httpStatus() == 429 ? "Too Many Requests" : "Forbidden",
                        sec.code(), sec.message());
                return ResponseEntity.status(sec.httpStatus()).body(err);
            }
        }

        // Validate request
        if (request == null || request.alertId() == null || request.alertId().isBlank()) {
            ApiError err = ApiError.of(httpReq, 400, "Bad Request", "INVALID_REQUEST", "alertId is required");
            return ResponseEntity.badRequest().body(err);
        }

        // Explicitly use LOCAL client — never touches remote EWS
        EwsResponse resp = ewsService.sendLocal(request);
        log.info("Local EWS test: alertId={}, referenceId={}", request.alertId(), resp.referenceId());

        // Response per spec: mode=local, status=accepted, referenceId, timestamp
        return ResponseEntity.ok(resp);
    }

    @GetMapping("/mode")
    public ResponseEntity<?> getMode(HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, null);
            if (!sec.allowed()) {
                return ResponseEntity.status(sec.httpStatus())
                        .body(ApiError.of(httpReq, sec.httpStatus(), "Unauthorized", sec.code(), sec.message()));
            }
        }
        return ResponseEntity.ok(java.util.Map.of(
                "mode", properties.getMode(),
                "effectiveMode", properties.getEwsMode().name().toLowerCase(),
                "baseUrlConfigured", properties.effectiveBaseUrl() != null && !properties.effectiveBaseUrl().isBlank(),
                "timestamp", Instant.now().toString()
        ));
    }

    @PostMapping("/local/report")
    public ResponseEntity<?> localReport(@RequestBody EwsRequest request, HttpServletRequest httpReq) {
        // Alias that accepts same shape but returns local response with alertReport simulation
        return localTest(request, httpReq);
    }
}
