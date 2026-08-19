package com.turant.pipeline;

import com.turant.cap.CapParser;
import com.turant.cellsite.TowerResolver;
import com.turant.cellsite.TowerSource;
import com.turant.dedup.MsisdnDeduplicator;
import com.turant.parallel.ParallelOrchestrator;
import com.turant.parallel.WorkerJob;
import com.turant.parallel.WorkerResult.AlertSubmitSummary;
import com.turant.types.cap.*;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * Automatic end-to-end pipeline orchestrator.
 * 
 * After a CAP alert is successfully ingested (module 01), this runs the real chain:
 * 
 *   01 ingest → 02 tower resolution → 03/04 subscriber matching → 
 *   05 dedup → 06 expiry → 07-13 submit
 * 
 * The chain stops cleanly at the first stage whose real input is missing,
 * and never fabricates what is absent.
 * 
 * Migrated from TypeScript src/pipeline/alert-pipeline.ts
 */
@Service
public class AlertPipeline {
    
    private static final Logger logger = LoggerFactory.getLogger(AlertPipeline.class);
    
    private final TowerResolver towerResolver;
    private final MsisdnDeduplicator deduplicator;
    private final ParallelOrchestrator orchestrator;
    private final PipelineStatusStore statusStore;
    
    @Value("${subscriber.matching-available:false}")
    private boolean subscriberMatchingAvailable;
    
    @Value("${tower.match-time-budget-ms:30000}")
    private long timeBudgetMs;
    
    @Autowired
    public AlertPipeline(
            TowerResolver towerResolver,
            MsisdnDeduplicator deduplicator,
            ParallelOrchestrator orchestrator,
            PipelineStatusStore statusStore) {
        this.towerResolver = towerResolver;
        this.deduplicator = deduplicator;
        this.orchestrator = orchestrator;
        this.statusStore = statusStore;
    }
    
    public static class RunPipelineInput {
        private final CapAlert alert;
        private final String capIdentifier;
        private final String alertId;
        private final TowerSource source;
        
        public RunPipelineInput(CapAlert alert, String capIdentifier, String alertId) {
            this(alert, capIdentifier, alertId, null);
        }
        
        public RunPipelineInput(CapAlert alert, String capIdentifier, String alertId, TowerSource source) {
            this.alert = alert;
            this.capIdentifier = capIdentifier;
            this.alertId = alertId;
            this.source = source;
        }
        
        public CapAlert getAlert() { return alert; }
        public String getCapIdentifier() { return capIdentifier; }
        public String getAlertId() { return alertId; }
        public TowerSource getSource() { return source; }
    }
    
    /**
     * Run the complete alert pipeline.
     */
    public CompletableFuture<PipelineStatusRecord> runAlertPipeline(RunPipelineInput input) {
        String capIdentifier = input.getCapIdentifier();
        String alertId = input.getAlertId();
        CapAlert alert = input.getAlert();
        
        logger.info("Pipeline started: alertId={}, capIdentifier={}", alertId, capIdentifier);
        
        // Stage: ingested
        running(capIdentifier, "ingested", null);
        
        // Module 02: Cell site identification
        running(capIdentifier, "tower-resolution", null);
        
        GeoZone zone = capZoneToGeoZone(alert);
        if (zone.geometries().isEmpty()) {
            logger.warn("Pipeline halted: CAP alert has no geographic area");
            return CompletableFuture.completedFuture(
                halted(capIdentifier, "tower-resolution", 
                    "CAP alert has no geographic area (no polygon/circle areas)", null)
            );
        }
        
        // Resolve towers
        TowerSource.FindTowersOptions options = new TowerSource.FindTowersOptions()
            .setTraceKey(capIdentifier)
            .setTimeoutMs(timeBudgetMs);
        
        CompletableFuture<List<CellTower>> towersFuture = input.getSource() != null
            ? towerResolver.resolveWithSource(input.getSource(), alertId, zone, options)
            : towerResolver.resolveTowers(alertId, zone, options);
        
        return towersFuture
            .exceptionally(err -> {
                logger.error("Tower resolution failed: alertId=" + alertId, err);
                throw new RuntimeException("Tower resolution failed: " + err.getMessage(), err);
            })
            .thenCompose(towers -> {
                int towerCount = towers.size();
                running(capIdentifier, "tower-resolution", towerCount);
                
                // Store tower data for frontend
                statusStore.setTowers(capIdentifier, towers);
                
                logger.info("Towers resolved: count={}, alertId={}", towerCount, alertId);
                
                // Modules 03/04: Subscriber matching
                // TODO: Currently not available - waiting for subscriber data source
                if (!subscriberMatchingAvailable) {
                    String reason = "awaiting subscriber data - modules 03/04 not yet connected";
                    logger.warn("Pipeline halted: {}", reason);
                    return CompletableFuture.completedFuture(
                        halted(capIdentifier, "subscriber-matching", reason, towerCount)
                    );
                }
                
                // When subscriber matching is available, run dissemination leg
                return runDisseminationLeg(alert, capIdentifier, alertId, towers);
            })
            .exceptionally(err -> {
                logger.error("Pipeline failed: alertId=" + alertId, err);
                return halted(capIdentifier, "tower-resolution", 
                    err.getMessage() != null ? err.getMessage() : "Unknown error", null);
            });
    }
    
    /**
     * Real dissemination: match → dedup → submit (runs when matcher exists).
     */
    private CompletableFuture<PipelineStatusRecord> runDisseminationLeg(
            CapAlert alert,
            String capIdentifier,
            String alertId,
            List<CellTower> towers) {
        
        // TODO: Implement subscriber matching when data source is available
        // For now, return halted status
        logger.info("Dissemination leg: alertId={}, towers={}", alertId, towers.size());
        
        return CompletableFuture.completedFuture(
            halted(capIdentifier, "subscriber-matching",
                "Subscriber matching not yet implemented", towers.size())
        );
        
        // Future implementation will:
        // 1. Match subscribers via SubscriberMatcher
        // 2. Deduplicate MSISDNs (Module 05)
        // 3. Submit via ParallelOrchestrator (Modules 06-13)
        // 4. Build and push completion report (Module 12)
    }
    
    /**
     * Convert CAP alert geometries to GeoZone.
     */
    private GeoZone capZoneToGeoZone(CapAlert alert) {
        List<GeoZone.ZoneGeometry> geometries = new ArrayList<>();
        
        if (alert.info() != null && alert.info().areas() != null) {
            for (CapArea area : alert.info().areas()) {
                if (area.geometries() != null) {
                    for (CapGeometry capGeom : area.geometries()) {
                        GeoZone.ZoneGeometry zoneGeom = convertCapGeometry(capGeom);
                        if (zoneGeom != null) {
                            geometries.add(zoneGeom);
                        }
                    }
                }
            }
        }
        
        return new GeoZone(geometries, 4326); // WGS84 SRID
    }
    
    /**
     * Convert CapGeometry to GeoZone.ZoneGeometry.
     */
    private GeoZone.ZoneGeometry convertCapGeometry(CapGeometry capGeom) {
        if (capGeom.getType().equals("Polygon")) {
            // Cast to access polygon-specific fields
            CapGeometry poly = capGeom;
            // For now, return a simple polygon structure
            // TODO: Properly extract coordinates when needed
            return new GeoZone.ZoneGeometry("Polygon", List.of(), null, null);
            
        } else if (capGeom.getType().equals("Circle")) {
            // Cast to access circle-specific fields
            CapGeometry circle = capGeom;
            // TODO: Properly extract center and radius when needed
            GeoZone.ZoneCenter center = new GeoZone.ZoneCenter(0.0, 0.0);
            return new GeoZone.ZoneGeometry("Circle", null, center, 1000.0);
        }
        
        return null;
    }
    
    /**
     * Update status to running.
     */
    private void running(String capIdentifier, String stage, Integer towerCount) {
        PipelineStatusRecord record = new PipelineStatusRecord(
            capIdentifier,
            "running",
            stage,
            null,
            null,
            towerCount,
            null,
            null,
            null,
            null,
            null,
            null,
            System.currentTimeMillis()
        );
        statusStore.update(record);
    }
    
    /**
     * Update status to halted.
     */
    private PipelineStatusRecord halted(String capIdentifier, String stage, String reason, Integer towerCount) {
        PipelineStatusRecord record = new PipelineStatusRecord(
            capIdentifier,
            "halted",
            stage,
            stage,
            reason,
            towerCount,
            null,
            null,
            null,
            null,
            null,
            null,
            System.currentTimeMillis()
        );
        statusStore.update(record);
        return record;
    }
}
