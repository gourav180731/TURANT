package com.turant.pipeline;

import com.turant.cap.CapIngestionService;
import com.turant.http.ApiError;
import com.turant.security.AuditService;
import com.turant.security.ReplayProtectionService;
import com.turant.security.SecurityService;
import com.turant.types.cap.CapAlert;
import com.turant.types.report.AlertReport;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.concurrent.CompletableFuture;

/**
 * REST API for pipeline status and reporting.
 * Canonical EWS: POST /api/v1/pipeline/trigger-by-cap
 * Security: ApiKey + mTLS + IP + RateLimit + CAP validation + Signature + Replay + Audit
 */
@RestController
@RequestMapping("/api/v1/pipeline")
public class PipelineController {
    
    private final PipelineStatusStore statusStore;
    private final ReportBuilder reportBuilder;
    private final AlertPipeline alertPipeline;
    private final CapIngestionService capService;
    private final SecurityService securityService;
    private final AuditService auditService;
    private final ReplayProtectionService replayService;
    
    public PipelineController(
            PipelineStatusStore statusStore, 
            ReportBuilder reportBuilder,
            AlertPipeline alertPipeline,
            CapIngestionService capService,
            @Autowired(required = false) SecurityService securityService,
            @Autowired(required = false) AuditService auditService,
            @Autowired(required = false) ReplayProtectionService replayService) {
        this.statusStore = statusStore;
        this.reportBuilder = reportBuilder;
        this.alertPipeline = alertPipeline;
        this.capService = capService;
        this.securityService = securityService;
        this.auditService = auditService;
        this.replayService = replayService;
        LoggerFactory.getLogger(PipelineController.class).info("PipelineController initialized successfully (security: {})", securityService != null);
    }
    
    @GetMapping("/test")
    public ResponseEntity<String> test() {
        return ResponseEntity.ok("Pipeline controller is working");
    }
    
    @PostMapping("/trigger")
    public CompletableFuture<ResponseEntity<Object>> triggerPipeline(@RequestBody TriggerRequest request, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, request.capIdentifier());
            if (!sec.allowed()) {
                ApiError err = ApiError.of(httpReq, sec.httpStatus(), sec.httpStatus()==401?"Unauthorized":sec.httpStatus()==429?"Too Many Requests":"Forbidden", sec.code(), sec.message());
                return CompletableFuture.completedFuture(ResponseEntity.status(sec.httpStatus()).body((Object) err));
            }
        }
        String capIdentifier = request.capIdentifier();
        String alertId = request.alertId() != null ? request.alertId() : capIdentifier;
        LoggerFactory.getLogger(PipelineController.class).info("Pipeline trigger: capIdentifier={}, alertId={}", capIdentifier, alertId);
        return capService.getAlert(alertId).thenCompose(alertOpt -> {
            if (alertOpt.isEmpty()) {
                ApiError err = ApiError.of(httpReq, 404, "Not Found", "ALERT_NOT_FOUND", "Alert not found: " + alertId);
                return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.NOT_FOUND).body((Object) err));
            }
            CapAlert alert = alertOpt.get();
            AlertPipeline.RunPipelineInput input = new AlertPipeline.RunPipelineInput(alert, capIdentifier, alertId);
            return alertPipeline.runAlertPipeline(input).handle((status, err) -> {
                if (err != null) {
                    ApiError apiErr = ApiError.of(httpReq, 500, "Internal Server Error", "PIPELINE_FAILED", "Pipeline failed: " + err.getMessage());
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body((Object) apiErr);
                }
                return ResponseEntity.ok((Object) new TriggerResponse(capIdentifier, alertId, "triggered", status.status(), status.stage()));
            });
        });
    }
    
    @PostMapping(value = "/trigger-by-cap",
            consumes = {"application/xml", "text/xml", "application/*+xml", "text/plain", "*/*"},
            produces = "application/json")
    public CompletableFuture<ResponseEntity<Object>> triggerByCap(@RequestBody(required = false) String capXml, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, capXml, null);
            if (!sec.allowed()) {
                ApiError err = ApiError.of(httpReq, sec.httpStatus(), sec.httpStatus()==401?"Unauthorized":sec.httpStatus()==429?"Too Many Requests":"Forbidden", sec.code(), sec.message());
                if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), sec.clientId(), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), null), AuditService.AuditEvent.ALERT_REJECTED, "DENIED", sec.code());
                return CompletableFuture.completedFuture(ResponseEntity.status(sec.httpStatus()).body((Object) err));
            }
        }
        if (capXml == null || capXml.isBlank()) {
            if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), null), AuditService.AuditEvent.CAP_VALIDATION_FAILURE, "DENIED", "EMPTY_CAP");
            ApiError err = ApiError.of(httpReq, 400, "Bad Request", "EMPTY_CAP", "Empty CAP XML body");
            return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.BAD_REQUEST).body((Object) err));
        }
        if (capXml.length() > 20 * 1024 * 1024) {
            if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), null), AuditService.AuditEvent.CAP_VALIDATION_FAILURE, "DENIED", "CAP_TOO_LARGE");
            ApiError err = ApiError.of(httpReq, 413, "Payload Too Large", "CAP_TOO_LARGE", "CAP XML exceeds 20 MB limit: " + capXml.length());
            return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body((Object) err));
        }
        LoggerFactory.getLogger(PipelineController.class).info("Pipeline trigger with CAP XML, length={}", capXml.length());
        
        return capService.ingestCap(capXml).thenCompose(alert -> {
            String capIdentifier = alert.identifier();
            String sender = alert.sender();
            if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), (String)httpReq.getAttribute("turant.clientCert"), httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), capIdentifier), AuditService.AuditEvent.CAP_VALIDATION_SUCCESS, "ALLOWED", "CAP valid");
            if (replayService != null) {
                var replayRes = replayService.checkAndMark(capIdentifier, sender, capXml, httpReq.getRemoteAddr(), (String)httpReq.getAttribute("turant.clientId"));
                if (replayRes == ReplayProtectionService.ReplayResult.REPLAY_DETECTED) {
                    if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), capIdentifier), AuditService.AuditEvent.REPLAY_DETECTED, "DENIED", "Duplicate capIdentifier+sender");
                    ApiError err = ApiError.of(httpReq, 409, "Conflict", "REPLAY_DETECTED", "Duplicate CAP identifier (replay): " + capIdentifier);
                    return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.CONFLICT).body((Object) err));
                }
            }
            AlertPipeline.RunPipelineInput input = new AlertPipeline.RunPipelineInput(alert, capIdentifier, capIdentifier);
            return alertPipeline.runAlertPipeline(input).handle((status, err) -> {
                if (err != null) {
                    Throwable cause = err.getCause() != null ? err.getCause() : err;
                    LoggerFactory.getLogger(PipelineController.class).error("Pipeline failed for capIdentifier={}: {}", capIdentifier, cause.getMessage(), cause);
                    if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), capIdentifier), AuditService.AuditEvent.ALERT_REJECTED, "FAILED", cause.getMessage());
                    ApiError apiErr = ApiError.of(httpReq, 500, "Internal Server Error", "PIPELINE_FAILED", "Pipeline failed: " + cause.getMessage());
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body((Object) apiErr);
                }
                if (auditService != null) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), capIdentifier), AuditService.AuditEvent.ALERT_ACCEPTED, "ALLOWED", "towerCount="+status.towerCount());
                return ResponseEntity.ok((Object) new TriggerResponse(capIdentifier, capIdentifier, "triggered", status.status(), status.stage()));
            });
        }).exceptionally(err -> {
            Throwable cause = err.getCause() != null ? err.getCause() : err;
            boolean isParse = cause instanceof com.turant.cap.CapParseException || (cause.getMessage() != null && cause.getMessage().contains("CAP"));
            HttpStatus status = isParse ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR;
            String code = isParse ? "CAP_PARSE_ERROR" : "INGEST_FAILED";
            if (auditService != null && isParse) auditService.audit(new AuditService.HttpContext((String)httpReq.getAttribute("turant.requestId"), (String)httpReq.getAttribute("turant.clientId"), null, httpReq.getRemoteAddr(), httpReq.getRequestURI(), httpReq.getMethod(), null), AuditService.AuditEvent.CAP_VALIDATION_FAILURE, "DENIED", cause.getMessage());
            LoggerFactory.getLogger(PipelineController.class).error("trigger-by-cap failed: {}", cause.getMessage(), cause);
            ApiError apiErr = ApiError.of(httpReq, status.value(), status.getReasonPhrase(), code, (isParse ? "CAP parsing failed: " : "Pipeline failed: ") + cause.getMessage());
            return ResponseEntity.status(status).body((Object) apiErr);
        });
    }
    
    @Deprecated(since = "1.0", forRemoval = false)
    @GetMapping("/{capIdentifier}/pipeline-status")
    public ResponseEntity<?> getPipelineStatus(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) return ResponseEntity.status(sec.httpStatus()).body(ApiError.of(httpReq, sec.httpStatus(), "Unauthorized", sec.code(), sec.message()));
        }
        LoggerFactory.getLogger(PipelineController.class).info("Checking pipeline status for: {}", capIdentifier);
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        if (status == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "PIPELINE_NOT_FOUND", "No pipeline status found for: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        return ResponseEntity.ok(status);
    }
    
    @GetMapping("/status/{capIdentifier}")
    public ResponseEntity<?> getStatus(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) return ResponseEntity.status(sec.httpStatus()).body(ApiError.of(httpReq, sec.httpStatus(), "Unauthorized", sec.code(), sec.message()));
        }
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        if (status == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "PIPELINE_NOT_FOUND", "No pipeline status found for: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        return ResponseEntity.ok(status);
    }
    
    @GetMapping("/towers/{capIdentifier}")
    public ResponseEntity<?> getTowers(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) return ResponseEntity.status(sec.httpStatus()).body(ApiError.of(httpReq, sec.httpStatus(), "Unauthorized", sec.code(), sec.message()));
        }
        var towers = statusStore.getTowers(capIdentifier);
        if (towers == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "TOWERS_NOT_FOUND", "No towers found for alert: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        return ResponseEntity.ok(new TowersResponse(capIdentifier, towers.size(), towers));
    }
    
    @GetMapping("/report/{capIdentifier}")
    public ResponseEntity<?> getReport(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) return ResponseEntity.status(sec.httpStatus()).body(ApiError.of(httpReq, sec.httpStatus(), "Unauthorized", sec.code(), sec.message()));
        }
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        if (status == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "REPORT_NOT_FOUND", "No status found for alert: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        if (!"completed".equals(status.status())) {
            ApiError err = ApiError.of(httpReq, 202, "Accepted", "REPORT_NOT_READY", "Alert processing not yet complete: " + status.stage());
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(err);
        }
        Long startedAtMs = statusStore.startedAtOf(capIdentifier);
        Long endedAtMs = status.updatedAtMs();
        ReportBuilder.ReportInput input = new ReportBuilder.ReportInput(
            capIdentifier, capIdentifier,
            status.expectedRecipients() != null ? status.expectedRecipients() : 0,
            status.submittedCount() != null ? status.submittedCount() : 0,
            status.acceptedCount() != null ? status.acceptedCount() : 0,
            0,0,0,
            status.towerCount() != null ? status.towerCount() : 0,
            startedAtMs, endedAtMs
        );
        AlertReport report = reportBuilder.buildAlertReport(input);
        return ResponseEntity.ok(report);
    }
    
    @DeleteMapping("/status/{capIdentifier}")
    public ResponseEntity<Void> clearStatus(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        if (securityService != null) {
            var sec = securityService.check(httpReq, null, capIdentifier);
            if (!sec.allowed()) return ResponseEntity.status(sec.httpStatus()).build();
        }
        statusStore.remove(capIdentifier);
        return ResponseEntity.noContent().build();
    }
    
    record TowersResponse(String capIdentifier, int count, Object towers) {}
    record TriggerRequest(String capIdentifier, String alertId) {}
    record TriggerResponse(String capIdentifier, String alertId, String action, String status, String stage) {}
    record ErrorResponse(String error) {}
}
