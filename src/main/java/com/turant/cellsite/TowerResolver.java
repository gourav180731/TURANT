package com.turant.cellsite;

import com.turant.simulation.SimulatedTowerSource;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import com.turant.cellsite.TowerResolutionResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
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
 * 
 * SIMULATION MODE:
 * When simulation.mode=enabled, SimulatedTowerSource is auto-registered and used.
 * No PostGIS database required.
 * 
 * REAL MODE (simulation.mode=disabled):
 * ONLY PostGisTowerSource is registered for "postgis" mode. If PostGIS is unavailable,
 * resolution FAILS CLEARLY — no silent fallback to simulated data.
 */
@Service
public class TowerResolver {
    
    private static final Logger logger = LoggerFactory.getLogger(TowerResolver.class);
    
    private final Map<String, TowerSource> sources = new HashMap<>();
    
    private final String towerSourceMode;
    private final String simulationMode;
    private final long timeBudgetMs;
    
    public TowerResolver(
            @Value("${tower.source-mode:postgis}") String towerSourceMode,
            @Value("${simulation.mode:disabled}") String simulationMode,
            @Value("${tower.match-time-budget-ms:30000}") long timeBudgetMs,
            @Autowired(required = false) PostGisTowerSource postgisTowerSource,
            @Autowired(required = false) SimulatedTowerSource simulatedTowerSource) {
        
        this.towerSourceMode = towerSourceMode;
        this.simulationMode = simulationMode;
        this.timeBudgetMs = timeBudgetMs;
        
        boolean simEnabled = "enabled".equalsIgnoreCase(simulationMode);
        
        logger.info("TowerResolver initializing: simulation.mode={}, tower.source-mode={}", 
            simulationMode, towerSourceMode);
        
        // Register PostGisTowerSource — always under "postgis" key
        if (postgisTowerSource != null) {
            sources.put("postgis", postgisTowerSource);
            logger.info("REGISTERED: PostGisTowerSource (name={}) as 'postgis' source", 
                postgisTowerSource.getName());
        } else {
            logger.warn("PostGisTowerSource NOT AVAILABLE (DataSource/JdbcTemplate not configured)");
        }
        
        // Register SimulatedTowerSource — only when simulation.mode=enabled.
        // CRITICAL: it is registered ONLY under the literal key "simulated".
        // It must NEVER be registered under "postgis" (the REAL mode key), because
        // that would make REAL mode silently return fabricated towers. Real mode
        // resolution is guaranteed to use PostGisTowerSource.
        if (simulatedTowerSource != null) {
            if (simEnabled) {
                sources.put("simulated", simulatedTowerSource);
                logger.info("REGISTERED: SimulatedTowerSource (name={}) as 'simulated' source only " +
                    "(simulation.mode=enabled). It is NEVER registered under 'postgis'.", 
                    simulatedTowerSource.getName());
            } else {
                // REAL MODE — do NOT register SimulatedTowerSource at all
                logger.info("SKIPPED: SimulatedTowerSource registration because simulation.mode={} (REAL MODE active)", 
                    simulationMode);
            }
        } else {
            if (simEnabled) {
                logger.warn("SimulatedTowerSource NOT AVAILABLE but simulation.mode=enabled");
            }
        }
        
        if (sources.isEmpty()) {
            logger.error("NO TOWER SOURCES REGISTERED! simulation.mode={}, postgis available={}, simulated available={}",
                simulationMode, postgisTowerSource != null, simulatedTowerSource != null);
        }
        
        // Validate that the configured mode is available in REAL mode
        if (!simEnabled && !sources.containsKey(towerSourceMode)) {
            logger.error("REAL MODE ASSERTION FAILED: tower.source-mode='{}' but that source is NOT REGISTERED. Available sources: {}",
                towerSourceMode, sources.keySet());
            throw new IllegalStateException(
                "REAL MODE: tower.source-mode='" + towerSourceMode + "' is not available. " +
                "Registered sources: " + sources.keySet() + ". " +
                "Check that PostgreSQL is configured and reachable, DATABASE_URL is set, and PostGIS extension is installed."
            );
        }

        // HARD REAL-MODE GUARD: Verify the source RESOLVED for the configured mode is NOT a SimulatedTowerSource.
        // Catches accidental registration bugs (e.g. sources.put("postgis", simulatedTowerSource)).
        if (!simEnabled && sources.containsKey(towerSourceMode)) {
            TowerSource resolved = sources.get(towerSourceMode);
            boolean isActuallySimulated = "simulated".equalsIgnoreCase(resolved.getName())
                || resolved instanceof com.turant.simulation.SimulatedTowerSource;
            if (isActuallySimulated) {
                logger.error("REAL MODE ASSERTION FAILED (CRITICAL): tower.source-mode='{}' resolves to SIMULATED source (class={}, name={}). " +
                    "This indicates a BUG in TowerResolver source registration. Simulated data is FORBIDDEN in REAL mode.",
                    towerSourceMode, resolved.getClass().getSimpleName(), resolved.getName());
                throw new IllegalStateException(
                    "REAL MODE CRITICAL: Source for tower.source-mode='" + towerSourceMode + "' is SIMULATED (" +
                    resolved.getClass().getSimpleName() + "/" + resolved.getName() + "). " +
                    "Real PostgreSQL/PostGIS required. Check that PostGisTowerSource bean was created and that " +
                    "SimulatedTowerSource did NOT overwrite the 'postgis' key in TowerResolver sources map."
                );
            }
        }

        logger.info("============================================================");
        logger.info("TowerResolver initialization COMPLETE (REAL-MODE GUARDS PASSED):");
        logger.info("  simulation.mode          = {}", simulationMode);
        logger.info("  tower.source-mode        = {}", towerSourceMode);
        logger.info("  Registered sources       = {}", sources.keySet());
        logger.info("  Configured mode resolves = {}",
            sources.containsKey(towerSourceMode) ? sources.get(towerSourceMode).getClass().getSimpleName() + " (name=" + sources.get(towerSourceMode).getName() + ")" : "UNAVAILABLE");
        logger.info("  IS_SIMULATED (for configured mode) = {}",
            sources.containsKey(towerSourceMode) && "simulated".equalsIgnoreCase(sources.get(towerSourceMode).getName()));
        logger.info("============================================================");
    }
    
    /**
     * Resolve towers for an alert zone using configured source.
     *
     * @param alertId CAP alert identifier
     * @param zone Geographic zone from CAP alert
     * @param options Search options
     * @return List of matching cell towers
     */
    public CompletableFuture<TowerResolutionResult> resolveTowers(
            String alertId, 
            GeoZone zone, 
            TowerSource.FindTowersOptions options) {
        
        TowerSource source = getSource(towerSourceMode);
        boolean simEnabled = "enabled".equalsIgnoreCase(simulationMode);
        boolean isSimulated = "simulated".equalsIgnoreCase(source.getName());
        
        // REAL MODE GUARD: Never return simulated towers when simulation.mode=disabled
        if (!simEnabled && isSimulated) {
            logger.error("REAL MODE VIOLATION: Configured source for mode='{}' returned SIMULATED source (name='{}'). " +
                "Aborting — will not return fake data in REAL mode.", towerSourceMode, source.getName());
            CompletableFuture<TowerResolutionResult> failed = new CompletableFuture<>();
            failed.completeExceptionally(new IllegalStateException(
                "REAL MODE VIOLATION: Tower source for mode='" + towerSourceMode + "' is SIMULATED. " +
                "This system is configured with simulation.mode=disabled. Check PostgreSQL connection."
            ));
            return failed;
        }
        
        logger.info("TowerResolver PROVENANCE: alertId={}, simulation.mode={}, tower.source-mode={}, " +
            "SELECTED_SOURCE={}, SOURCE_NAME={}, IS_SIMULATED={}",
            alertId, simulationMode, towerSourceMode, 
            source.getClass().getSimpleName(), source.getName(), isSimulated);
        
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
    public CompletableFuture<TowerResolutionResult> resolveWithSource(
            TowerSource source,
            String alertId,
            GeoZone zone,
            TowerSource.FindTowersOptions options) {
        
        boolean isSimulated = "simulated".equalsIgnoreCase(source.getName());
        
        logger.info("Cell match start: alertId={}, sourceClass={}, sourceName={}, " +
            "isSimulated={}, geometries={}, budgetMs={}", 
            alertId, source.getClass().getSimpleName(), source.getName(), 
            isSimulated, zone.geometries().size(), timeBudgetMs);
        
        long startTime = System.currentTimeMillis();
        
        // Apply client-side timeout
        CompletableFuture<TowerResolutionResult> future = source.findTowersInZone(zone, options)
            .orTimeout(timeBudgetMs, TimeUnit.MILLISECONDS)
            .whenComplete((result, error) -> {
                long elapsedMs = System.currentTimeMillis() - startTime;
                
                if (error != null) {
                    if (error instanceof TimeoutException) {
                        logger.warn("Cell match exceeded time budget: alertId={}, elapsedMs={}, budgetMs={}", 
                            alertId, elapsedMs, timeBudgetMs);
                    } else {
                        logger.error("Cell match failed: alertId={}", alertId, error);
                    }
                } else {
                    List<CellTower> towers = result.towers();
                    logger.info("Cell match COMPLETED: alertId={}, towers={}, elapsedMs={}, " +
                        "source={}, isSimulated={}, rawTotal={}, duplicatesRemoved={}", 
                        alertId, towers.size(), elapsedMs, source.getName(), isSimulated,
                        result.rawTotal(), result.duplicatesRemoved());
                    
                    // Log sample of tower IDs if real PostGIS source
                    if (!isSimulated && !towers.isEmpty()) {
                        int sampleCount = Math.min(5, towers.size());
                        StringBuilder ids = new StringBuilder();
                        StringBuilder cellIds = new StringBuilder();
                        for (int i = 0; i < sampleCount; i++) {
                            CellTower t = towers.get(i);
                            if (i > 0) { ids.append(", "); cellIds.append(", "); }
                            ids.append(t.id());
                            cellIds.append(t.cellId());
                        }
                        if (towers.size() > sampleCount) {
                            ids.append("... (").append(towers.size()).append(" total)");
                            cellIds.append("... (").append(towers.size()).append(" total)");
                        }
                        logger.info("REAL PostGIS towers SAMPLE: alertId={}, first {} tower.ids=[{}], first {} tower.cellIds=[{}]",
                            alertId, sampleCount, ids.toString(), sampleCount, cellIds.toString());
                    }
                    
                    if (elapsedMs > timeBudgetMs) {
                        logger.warn("Cell match budget exceeded: alertId={}, elapsedMs={}, budgetMs={}", 
                            alertId, elapsedMs, timeBudgetMs);
                    }
                }
            });
        
        return future;
    }
    
    /**
     * Get tower source by mode.
     *
     * In REAL mode the configured mode must be explicitly registered (otherwise
     * we fail loudly — no silent fallback to simulation). In SIMULATION mode, if
     * the configured mode (e.g. "postgis") is absent but the "simulated" source
     * is registered, we alias to it transparently. This alias NEVER overwrites
     * the "postgis" key with a simulated object; it only changes which key we
     * look up, preserving the hard REAL-mode guarantee.
     */
    private TowerSource getSource(String mode) {
        TowerSource source = sources.get(mode);
        if (source == null) {
            boolean simEnabled = "enabled".equalsIgnoreCase(simulationMode);
            if (simEnabled && sources.containsKey("simulated")) {
                logger.warn("TOWER_SOURCE_MODE='{}' is not registered, but simulation.mode=enabled and " +
                    "'simulated' source is available — aliasing '{}' -> 'simulated' for simulation only.",
                    mode, mode);
                return sources.get("simulated");
            }
            throw new IllegalArgumentException(
                "Unknown TOWER_SOURCE_MODE \"" + mode + "\" (expected postgis|http|memory). " +
                "Registered sources: " + sources.keySet()
            );
        }
        return source;
    }
}
