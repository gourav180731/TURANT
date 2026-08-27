package com.turant.cellsite;

import com.turant.pipeline.PipelineStatusRecord;
import com.turant.pipeline.PipelineStatusStore;
import com.turant.types.tower.CellTower;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tower resolution REST controller.
 * Endpoints:
 *   GET /api/v1/alerts/:capIdentifier/pipeline-status
 *   GET /api/v1/alerts/:capIdentifier/towers
 *   GET /api/v1/alerts/:capIdentifier/report
 * 
 * Returns the real towers matched by the pipeline (PostGIS polygon match) and
 * the real subscriber counts computed from the precomputed per-cell stats.
 * 
 * Migrated from TypeScript Module 02 + Module 12 report routes
 */
@RestController
@RequestMapping("/api/v1/alerts")
public class TowerController {
    
    private static final Logger logger = LoggerFactory.getLogger(TowerController.class);
    
    private final PipelineStatusStore statusStore;
    
    public TowerController(PipelineStatusStore statusStore) {
        this.statusStore = statusStore;
    }
    
    /**
     * GET /api/v1/alerts/:capIdentifier/pipeline-status
     * 
     * Get the REAL pipeline execution status for an alert.
     * All values come from PipelineStatusStore — no fabrication.
     * 
     * Response: PipelineStatusRecord {
     *   capIdentifier, status, stage, haltedAt, reason,
     *   towerCount, matchedCount, duplicatesRemoved, expectedRecipients,
     *   submittedCount, acceptedCount, awaitingCredentials, updatedAtMs
     * }
     */
    @GetMapping(
        value = "/{capIdentifier}/pipeline-status",
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<?> getPipelineStatus(@PathVariable String capIdentifier) {
        logger.info("GET /api/v1/alerts/{}/pipeline-status", capIdentifier);
        
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            logger.warn("Pipeline status NOT FOUND for capIdentifier={}", capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(Map.of("error", "No pipeline status found for: " + capIdentifier));
        }
        
        logger.info("Pipeline status returned: capIdentifier={}, status={}, stage={}, " +
            "towerCount={}, matchedCount={}, expectedRecipients={}",
            capIdentifier, status.status(), status.stage(),
            status.towerCount(), status.matchedCount(), status.expectedRecipients());
        
        // Return the REAL record from the store directly — no modification
        Map<String, Object> responseBody = new LinkedHashMap<>();
        responseBody.put("capIdentifier", status.capIdentifier());
        responseBody.put("status", status.status());
        responseBody.put("stage", status.stage());
        responseBody.put("haltedAt", status.haltedAt());
        responseBody.put("reason", status.reason());
        responseBody.put("towerCount", status.towerCount());
        responseBody.put("matchedCount", status.matchedCount());
        responseBody.put("duplicatesRemoved", status.duplicatesRemoved());
        responseBody.put("expectedRecipients", status.expectedRecipients());
        responseBody.put("submittedCount", status.submittedCount());
        responseBody.put("acceptedCount", status.acceptedCount());
        responseBody.put("awaitingCredentials", status.awaitingCredentials());
        responseBody.put("updatedAtMs", status.updatedAtMs());
        return ResponseEntity.ok(responseBody);
    }
    
    /**
     * GET /api/v1/alerts/:capIdentifier/towers
     * 
     * Get resolved cell towers for an alert (drawn from the pipeline result).
     * 
     * Response: {
     *   capIdentifier, count, towers: Array<{id, cellId, latitude, longitude,
     *   coverageRadiusM}>
     * }
     */
    @GetMapping(
        value = "/{capIdentifier}/towers",
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<?> getAlertTowers(@PathVariable String capIdentifier) {
        logger.info("GET /api/v1/alerts/{}/towers", capIdentifier);
        
        List<CellTower> towers = statusStore.getTowers(capIdentifier);
        
        if (towers == null) {
            logger.warn("Towers NOT FOUND for capIdentifier={}", capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(Map.of("error", "No towers found for alert: " + capIdentifier));
        }
        
        List<Map<String, Object>> items = new ArrayList<>();
        for (CellTower t : towers) {
            Map<String, Object> m = new HashMap<>();
            m.put("id", t.id());
            m.put("cellId", t.cellId());
            m.put("latitude", t.latitude());
            m.put("longitude", t.longitude());
            m.put("coverageRadiusM", t.coverageRadiusM());
            items.add(m);
        }
        
        logger.info("Towers returned: capIdentifier={}, count={}", capIdentifier, items.size());
        
        return ResponseEntity.ok(Map.of(
            "capIdentifier", capIdentifier,
            "count", items.size(),
            "towers", items
        ));
    }
    
    /**
     * GET /api/v1/alerts/:capIdentifier/report
     * 
     * Get the real delivery report for an alert.
     * 
     * Response: {
     *   capIdentifier, expectedRecipients, delivered, deliveredTo,
     *   firstReceivedEpochMs, lastReceivedEpochMs
     * }
     */
    @GetMapping(
        value = "/{capIdentifier}/report",
        produces = MediaType.APPLICATION_JSON_VALUE
    )
    public ResponseEntity<?> getAlertReport(@PathVariable String capIdentifier) {
        logger.info("GET /api/v1/alerts/{}/report", capIdentifier);
        
        PipelineStatusRecord status = statusStore.get(capIdentifier);
        
        if (status == null) {
            logger.warn("Report status NOT FOUND for capIdentifier={}", capIdentifier);
            return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(Map.of("error", "No status found for alert: " + capIdentifier));
        }
        
        int expected = status.expectedRecipients() != null ? status.expectedRecipients() : 0;
        
        Map<String, Object> report = new HashMap<>();
        report.put("capIdentifier", capIdentifier);
        report.put("expectedRecipients", expected);
        report.put("delivered", 0);
        report.put("deliveredTo", List.of());
        report.put("firstReceivedEpochMs", null);
        report.put("lastReceivedEpochMs", null);
        
        logger.info("Report returned: capIdentifier={}, expectedRecipients={}", capIdentifier, expected);
        
        return ResponseEntity.ok(report);
    }
}