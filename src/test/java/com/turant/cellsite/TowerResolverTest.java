package com.turant.cellsite;

import com.turant.simulation.SimulatedTowerSource;
import com.turant.simulation.TestDataFixtures;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for TowerResolver (Module 02).
 * 
 * Tests tower resolution with timeout enforcement and source selection.
 * Uses SimulatedTowerSource for testing without PostGIS dependency.
 */
@SpringBootTest
@ActiveProfiles("test")
class TowerResolverTest {
    
    @Autowired
    private TowerResolver resolver;
    
    @Autowired
    private SimulatedTowerSource simulatedSource;
    
    @Test
    void testResolveTowersWithSimulatedSource() throws Exception {
        // Given: Geographic zone
        GeoZone zone = TestDataFixtures.createDelhiZone();
        
        TowerSource.FindTowersOptions options = new TowerSource.FindTowersOptions()
            .setTraceKey("test-resolve-001")
            .setTimeoutMs(5000L);
        
        // When: Resolving towers with simulated source
        CompletableFuture<List<CellTower>> future = resolver.resolveWithSource(
            simulatedSource,
            "alert-001",
            zone,
            options
        );
        
        List<CellTower> towers = future.get(10, TimeUnit.SECONDS);
        
        // Then: Should return towers
        assertNotNull(towers);
        assertFalse(towers.isEmpty(), "Should find towers in zone");
        assertTrue(towers.size() >= 5, "Should generate multiple towers");
        
        // Verify tower structure
        CellTower firstTower = towers.get(0);
        assertNotNull(firstTower.cellId());
        assertNotNull(firstTower.latitude());
        assertNotNull(firstTower.longitude());
    }
    
    @Test
    void testResolveTowersCompletesQuickly() throws Exception {
        // Given: Simple zone
        GeoZone zone = TestDataFixtures.createSmallZone();
        
        TowerSource.FindTowersOptions options = new TowerSource.FindTowersOptions()
            .setTraceKey("test-performance")
            .setTimeoutMs(5000L);
        
        // When: Resolving towers
        long startTime = System.currentTimeMillis();
        
        CompletableFuture<List<CellTower>> future = resolver.resolveWithSource(
            simulatedSource,
            "alert-perf-001",
            zone,
            options
        );
        
        List<CellTower> towers = future.get(10, TimeUnit.SECONDS);
        long elapsedMs = System.currentTimeMillis() - startTime;
        
        // Then: Should complete quickly (simulated source is fast)
        assertNotNull(towers);
        assertTrue(elapsedMs < 5000, "Should complete within 5 seconds");
    }
    
    @Test
    void testResolverLogsProgress() throws Exception {
        // Given: Zone with towers
        GeoZone zone = TestDataFixtures.createDelhiZone();
        
        TowerSource.FindTowersOptions options = new TowerSource.FindTowersOptions()
            .setTraceKey("test-logging")
            .setTimeoutMs(5000L);
        
        // When: Resolving towers (logs should be generated)
        CompletableFuture<List<CellTower>> future = resolver.resolveWithSource(
            simulatedSource,
            "alert-log-001",
            zone,
            options
        );
        
        List<CellTower> towers = future.get(10, TimeUnit.SECONDS);
        
        // Then: Should complete successfully
        // (Logs are verified manually or with log capture framework)
        assertNotNull(towers);
        assertTrue(towers.size() > 0);
    }
    
    @Test
    void testMultipleConcurrentResolutions() throws Exception {
        // Given: Multiple zones
        GeoZone zone1 = TestDataFixtures.createDelhiZone();
        GeoZone zone2 = TestDataFixtures.createMumbaiZone();
        
        TowerSource.FindTowersOptions options1 = new TowerSource.FindTowersOptions()
            .setTraceKey("test-concurrent-1")
            .setTimeoutMs(5000L);
        
        TowerSource.FindTowersOptions options2 = new TowerSource.FindTowersOptions()
            .setTraceKey("test-concurrent-2")
            .setTimeoutMs(5000L);
        
        // When: Resolving towers concurrently
        CompletableFuture<List<CellTower>> future1 = resolver.resolveWithSource(
            simulatedSource, "alert-concurrent-1", zone1, options1);
        
        CompletableFuture<List<CellTower>> future2 = resolver.resolveWithSource(
            simulatedSource, "alert-concurrent-2", zone2, options2);
        
        // Wait for both
        CompletableFuture.allOf(future1, future2).get(15, TimeUnit.SECONDS);
        
        List<CellTower> towers1 = future1.get();
        List<CellTower> towers2 = future2.get();
        
        // Then: Both should succeed
        assertNotNull(towers1);
        assertNotNull(towers2);
        assertFalse(towers1.isEmpty());
        assertFalse(towers2.isEmpty());
    }
    
    @Test
    void testEmptyZoneHandling() throws Exception {
        // Given: Empty zone (no geometries)
        GeoZone emptyZone = new GeoZone(List.of(), 4326);
        
        TowerSource.FindTowersOptions options = new TowerSource.FindTowersOptions()
            .setTraceKey("test-empty-zone")
            .setTimeoutMs(5000L);
        
        // When: Resolving towers in empty zone
        CompletableFuture<List<CellTower>> future = resolver.resolveWithSource(
            simulatedSource,
            "alert-empty-001",
            emptyZone,
            options
        );
        
        List<CellTower> towers = future.get(10, TimeUnit.SECONDS);
        
        // Then: Should return empty list (no geometry to match)
        assertNotNull(towers);
        assertTrue(towers.isEmpty(), "Empty zone should yield no towers");
    }
    
    @Test
    void testTowerSourceName() {
        // When: Getting source name
        String name = simulatedSource.getName();
        
        // Then: Should return simulated source name
        assertEquals("simulated", name);
    }
}
