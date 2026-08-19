package com.turant.cellsite;

import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Cell site identification resolver - requirement #2.
 * 
 * Selects the TowerSource by config (TOWER_SOURCE_MODE), enforces the time budget,
 * and records the result in the alert's audit trail.
 * 
 * The budget is enforced twice: DB-side (statement_timeout in PostGIS adapter)
 * and client-side here (timeout on CompletableFuture), so a slow match can never
 * block an alert.
 * 
 * Migrated from TypeScript Module 02 resolver.ts
 */
@Service
public class TowerResolver {
    
    private static final Logger logger = LoggerFactory.getLogger(TowerResolver.class);
    
    private final Map<String, TowerSource> sources = new HashMap<>();
    
    @Value("${tower.source-mode:postgis}")
    private String towerSourceMode;
    
    @Value("${tower.match-time-budget-ms:30000}")
    private long timeBudgetMs;
    
    public TowerResolver(PostGisTowerSource postgisTowerSource) {
        sources.put("postgis", postgisTowerSource);
        // Additional sources (http, memory) can be registered here
    }
    
    /**
     * Resolve towers for an alert zone using configured source.
     *
     * @param alertId CAP alert identifier
     * @param zone Geographic zone from CAP alert
     * @param options Search options
     * @return List of matching cell towers
     */
    public CompletableFuture<List<CellTower>> resolveTowers(
            String alertId, 
            GeoZone zone, 
            TowerSource.FindTowersOptions options) {
        
        TowerSource source = getSource(towerSourceMode);
        return resolveWithSource(source, alertId, zone, options);
    }
    
    /**
     * Resolve towers with explicit source - used for testing.
     *
     * @param source Tower data source
     * @param alertId CAP alert identifier
     * @param zone Geographic zone
     * @param options Search options
     * @return List of matching cell towers
     */
    public CompletableFuture<List<CellTower>> resolveWithSource(
            TowerSource source,
            String alertId,
            GeoZone zone,
            TowerSource.FindTowersOptions options) {
        
        logger.info("Cell match start: source={}, geometries={}, budgetMs={}", 
            source.getName(), zone.geometries().size(), timeBudgetMs);
        
        long startTime = System.currentTimeMillis();
        
        // Apply client-side timeout
        CompletableFuture<List<CellTower>> future = source.findTowersInZone(zone, options)
            .orTimeout(timeBudgetMs, TimeUnit.MILLISECONDS)
            .whenComplete((towers, error) -> {
                long elapsedMs = System.currentTimeMillis() - startTime;
                
                if (error != null) {
                    if (error instanceof TimeoutException) {
                        logger.warn("Cell match exceeded time budget: elapsedMs={}, budgetMs={}", 
                            elapsedMs, timeBudgetMs);
                    } else {
                        logger.error("Cell match failed", error);
                    }
                } else {
                    logger.info("Cell match completed: towers={}, elapsedMs={}", 
                        towers.size(), elapsedMs);
                    
                    if (elapsedMs > timeBudgetMs) {
                        logger.warn("Cell match budget exceeded: elapsedMs={}, budgetMs={}", 
                            elapsedMs, timeBudgetMs);
                    }
                }
            });
        
        return future;
    }
    
    /**
     * Get tower source by mode.
     */
    private TowerSource getSource(String mode) {
        TowerSource source = sources.get(mode);
        if (source == null) {
            throw new IllegalArgumentException(
                "Unknown TOWER_SOURCE_MODE \"" + mode + "\" (expected postgis|http|memory)"
            );
        }
        return source;
    }
}
