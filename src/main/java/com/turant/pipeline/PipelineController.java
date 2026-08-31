package com.turant.pipeline;

import com.turant.cap.CapIngestionService;
import com.turant.http.ApiError;
import com.turant.types.cap.CapAlert;
import com.turant.types.report.AlertReport;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.concurrent.CompletableFuture;

/**
 * REST API for pipeline status and reporting.
 * 
 * Exposes pipeline execution status, tower data, and alert reports
 * to the frontend and external systems.
 * 
 * Migrated from TypeScript src/pipeline/routes.ts
 */
@RestController
@RequestMapping("/api/v1/pipeline")
public class PipelineController {
    
    private final PipelineStatusStore statusStore;
    private final ReportBuilder reportBuilder;
    private final AlertPipeline alertPipeline;
    private final CapIngestionService capService;
    
    public PipelineController(
            PipelineStatusStore statusStore, 
            ReportBuilder reportBuilder,
            AlertPipeline alertPipeline,
            CapIngestionService capService) {
        this.statusStore = statusStore;
        this.reportBuilder = reportBuilder;
        this.alertPipeline = alertPipeline;
        this.capService = capService;
        LoggerFactory.getLogger(PipelineController.class).info("PipelineController initialized successfully");
    }
    
    /**
     * Simple test endpoint
     */
    @GetMapping("/test")
    public ResponseEntity<String> test() {
        return ResponseEntity.ok("Pipeline controller is working");
    }
    
    /**
     * POST /api/v1/pipeline/trigger
     * 
     * Trigger pipeline execution for an existing CAP alert.
     */
    @PostMapping("/trigger")
    public CompletableFuture<ResponseEntity<Object>> triggerPipeline(@RequestBody TriggerRequest request, HttpServletRequest httpReq) {
        String capIdentifier = request.capIdentifier();
        String alertId = request.alertId() != null ? request.alertId() : capIdentifier;
        
        LoggerFactory.getLogger(PipelineController.class).info("Pipeline trigger: capIdentifier={}, alertId={}", capIdentifier, alertId);
        
        return capService.getAlert(alertId).thenCompose(alertOpt -> {
            if (alertOpt.isEmpty()) {
                ApiError err = ApiError.of(httpReq, 404, "Not Found", "ALERT_NOT_FOUND", "Alert not found: " + alertId);
                return CompletableFuture.completedFuture(
                    ResponseEntity.status(HttpStatus.NOT_FOUND).body((Object) err)
                );
            }
            
            CapAlert alert = alertOpt.get();
            AlertPipeline.RunPipelineInput input = new AlertPipeline.RunPipelineInput(
                alert, capIdentifier, alertId
            );
            
            return alertPipeline.runAlertPipeline(input).handle((status, err) -> {
                if (err != null) {
                    ApiError apiErr = ApiError.of(httpReq, 500, "Internal Server Error", "PIPELINE_FAILED", "Pipeline failed: " + err.getMessage());
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body((Object) apiErr);
                }
                return ResponseEntity.ok((Object) new TriggerResponse(
                    capIdentifier, alertId, "triggered", status.status(), status.stage()
                ));
            });
        });
    }
    
    /**
     * POST /api/v1/pipeline/trigger-by-cap
     * 
     * Ingest CAP XML and immediately trigger pipeline execution.
     * Accepts up to 20 MB (see WebConfig/Tomcat customizer + cap.max-xml-bytes).
     * The previous 503 (30.28s) was Spring async timeout (default 30s) — now 300s.
     */
    @PostMapping(value = "/trigger-by-cap",
            consumes = {"application/xml", "text/xml", "application/*+xml", "text/plain", "*/*"},
            produces = "application/json")
    public CompletableFuture<ResponseEntity<Object>> triggerByCap(@RequestBody(required = false) String capXml, HttpServletRequest httpReq) {
        if (capXml == null || capXml.isBlank()) {
            ApiError err = ApiError.of(httpReq, 400, "Bad Request", "EMPTY_CAP", "Empty CAP XML body");
            return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.BAD_REQUEST).body((Object) err));
        }
        if (capXml.length() > 20 * 1024 * 1024) {
            ApiError err = ApiError.of(httpReq, 413, "Payload Too Large", "CAP_TOO_LARGE", "CAP XML exceeds 20 MB limit: " + capXml.length());
            return CompletableFuture.completedFuture(ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body((Object) err));
        }
        LoggerFactory.getLogger(PipelineController.class).info("Pipeline trigger with CAP XML, length={}", capXml.length());
        
        return capService.ingestCap(capXml).thenCompose(alert -> {
            String capIdentifier = alert.identifier();
            AlertPipeline.RunPipelineInput input = new AlertPipeline.RunPipelineInput(
                alert, capIdentifier, capIdentifier
            );
            
            return alertPipeline.runAlertPipeline(input).handle((status, err) -> {
                if (err != null) {
                    Throwable cause = err.getCause() != null ? err.getCause() : err;
                    LoggerFactory.getLogger(PipelineController.class).error("Pipeline failed for capIdentifier={}: {}", capIdentifier, cause.getMessage(), cause);
                    ApiError apiErr = ApiError.of(httpReq, 500, "Internal Server Error", "PIPELINE_FAILED", "Pipeline failed: " + cause.getMessage());
                    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body((Object) apiErr);
                }
                return ResponseEntity.ok((Object) new TriggerResponse(
                    capIdentifier, capIdentifier, "triggered", status.status(), status.stage()
                ));
            });
        }).exceptionally(err -> {
            Throwable cause = err.getCause() != null ? err.getCause() : err;
            boolean isParse = cause instanceof com.turant.cap.CapParseException || (cause.getMessage() != null && cause.getMessage().contains("CAP"));
            HttpStatus status = isParse ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR;
            String code = isParse ? "CAP_PARSE_ERROR" : "INGEST_FAILED";
            LoggerFactory.getLogger(PipelineController.class).error("trigger-by-cap failed: {}", cause.getMessage(), cause);
            ApiError apiErr = ApiError.of(httpReq, status.value(), status.getReasonPhrase(), code, (isParse ? "CAP parsing failed: " : "Pipeline failed: ") + cause.getMessage());
            return ResponseEntity.status(status).body((Object) apiErr);
        });
    }
    
    /**
     * GET /api/v1/pipeline/{capIdentifier}/pipeline-status
     * @deprecated Canonical is GET /api/v1/pipeline/status/{capIdentifier}. Kept for backward compatibility.
     */
    @Deprecated(since = "1.0", forRemoval = false)
    @GetMapping("/{capIdentifier}/pipeline-status")
    public ResponseEntity<?> getPipelineStatus(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        LoggerFactory.getLogger(PipelineController.class).info("Checking pipeline status for: {}", capIdentifier);
        
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "PIPELINE_NOT_FOUND", "No pipeline status found for: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        
        return ResponseEntity.ok(status);
    }
    
    /**
     * GET /api/v1/pipeline/status/{capIdentifier} — CANONICAL status endpoint for EWS polling.
     */
    @GetMapping("/status/{capIdentifier}")
    public ResponseEntity<?> getStatus(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "PIPELINE_NOT_FOUND", "No pipeline status found for: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        
        return ResponseEntity.ok(status);
    }
    
    /**
     * GET /api/v1/pipeline/towers/{capIdentifier}
     * 
     * Get matched towers for an alert (for frontend map visualization).
     */
    @GetMapping("/towers/{capIdentifier}")
    public ResponseEntity<?> getTowers(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        var towers = statusStore.getTowers(capIdentifier);
        
        if (towers == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "TOWERS_NOT_FOUND", "No towers found for alert: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        
        return ResponseEntity.ok(new TowersResponse(capIdentifier, towers.size(), towers));
    }
    
    /**
     * GET /api/v1/pipeline/report/{capIdentifier}
     * 
     * Get completion report for an alert.
     */
    @GetMapping("/report/{capIdentifier}")
    public ResponseEntity<?> getReport(@PathVariable String capIdentifier, HttpServletRequest httpReq) {
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            ApiError err = ApiError.of(httpReq, 404, "Not Found", "REPORT_NOT_FOUND", "No status found for alert: " + capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(err);
        }
        
        if (!"completed".equals(status.status())) {
            ApiError err = ApiError.of(httpReq, 202, "Accepted", "REPORT_NOT_READY", "Alert processing not yet complete: " + status.stage());
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(err);
        }
        
        // Build report from the real status record.
        // delivered/failed/expired stay at their genuine current value: no SMS
        // has been submitted yet (submittedCount=0, awaiting SMSC credentials),
        // so no DLRs can exist. They become live counts when the SMPP/DLR path
        // is wired to a real SMSC.
        Long startedAtMs = statusStore.startedAtOf(capIdentifier);
        Long endedAtMs = status.updatedAtMs();
        ReportBuilder.ReportInput input = new ReportBuilder.ReportInput(
            capIdentifier,
            capIdentifier,
            status.expectedRecipients() != null ? status.expectedRecipients() : 0,
            status.submittedCount() != null ? status.submittedCount() : 0,
            status.acceptedCount() != null ? status.acceptedCount() : 0,
            0,
            0,
            0,
            status.towerCount() != null ? status.towerCount() : 0,
            startedAtMs,
            endedAtMs
        );
        
        AlertReport report = reportBuilder.buildAlertReport(input);
        return ResponseEntity.ok(report);
    }
    
    /**
     * DELETE /api/v1/pipeline/status/{capIdentifier}
     * 
     * Clear pipeline status for an alert (cleanup).
     */
    @DeleteMapping("/status/{capIdentifier}")
    public ResponseEntity<Void> clearStatus(@PathVariable String capIdentifier) {
        statusStore.remove(capIdentifier);
        return ResponseEntity.noContent().build();
    }
    
    // Response DTOs
    record TowersResponse(
        String capIdentifier,
        int count,
        Object towers
    ) {}
    
    record TriggerRequest(String capIdentifier, String alertId) {}
    record TriggerResponse(String capIdentifier, String alertId, String action, String status, String stage) {}
    record ErrorResponse(String error) {}
}
