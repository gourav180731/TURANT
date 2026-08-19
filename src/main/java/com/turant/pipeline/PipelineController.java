package com.turant.pipeline;

import com.turant.types.report.AlertReport;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

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
    
    public PipelineController(PipelineStatusStore statusStore, ReportBuilder reportBuilder) {
        this.statusStore = statusStore;
        this.reportBuilder = reportBuilder;
    }
    
    /**
     * GET /api/v1/pipeline/status/:capIdentifier
     * 
     * Get current pipeline status for an alert.
     */
    @GetMapping("/status/{capIdentifier}")
    public ResponseEntity<PipelineStatusRecord> getStatus(@PathVariable String capIdentifier) {
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            return ResponseEntity.notFound().build();
        }
        
        return ResponseEntity.ok(status);
    }
    
    /**
     * GET /api/v1/pipeline/towers/{capIdentifier}
     * 
     * Get matched towers for an alert (for frontend map visualization).
     */
    @GetMapping("/towers/{capIdentifier}")
    public ResponseEntity<?> getTowers(@PathVariable String capIdentifier) {
        var towers = statusStore.getTowers(capIdentifier);
        
        if (towers == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ErrorResponse("No towers found for alert: " + capIdentifier));
        }
        
        return ResponseEntity.ok(new TowersResponse(capIdentifier, towers.size(), towers));
    }
    
    /**
     * GET /api/v1/pipeline/report/{capIdentifier}
     * 
     * Get completion report for an alert.
     */
    @GetMapping("/report/{capIdentifier}")
    public ResponseEntity<?> getReport(@PathVariable String capIdentifier) {
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new ErrorResponse("No status found for alert: " + capIdentifier));
        }
        
        if (!"completed".equals(status.status())) {
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                .body(new ErrorResponse("Alert processing not yet complete: " + status.stage()));
        }
        
        // Build report from status
        ReportBuilder.ReportInput input = new ReportBuilder.ReportInput(
            capIdentifier, // Using capIdentifier as alertId for now
            capIdentifier,
            status.expectedRecipients() != null ? status.expectedRecipients() : 0,
            status.submittedCount() != null ? status.submittedCount() : 0,
            status.acceptedCount() != null ? status.acceptedCount() : 0,
            0, // deliveredCount - TODO: integrate with DLR tracking
            0, // failedCount - TODO: calculate from aggregate
            0, // expiredMessageCount - TODO: from aggregate
            status.towerCount() != null ? status.towerCount() : 0
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
    
    record ErrorResponse(String error) {}
}
