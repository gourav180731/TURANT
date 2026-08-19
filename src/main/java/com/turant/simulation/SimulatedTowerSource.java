package com.turant.simulation;

import com.turant.cellsite.TowerSource;
import com.turant.types.tower.CellTower;
import com.turant.types.tower.GeoZone;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CompletableFuture;

/**
 * Simulated tower source for testing without real PostGIS database.
 * 
 * Generates deterministic cell towers within a geographic zone.
 * Useful for:
 * - Integration testing
 * - Demo scenarios
 * - Development without PostGIS setup
 * - Load testing
 * 
 * Enable with: simulation.mode=enabled
 */
@Component
@ConditionalOnProperty(name = "simulation.mode", havingValue = "enabled")
public class SimulatedTowerSource implements TowerSource {
    
    private static final Logger logger = LoggerFactory.getLogger(SimulatedTowerSource.class);
    
    // Configuration for simulation
    private static final int MIN_TOWERS_PER_ZONE = 5;
    private static final int MAX_TOWERS_PER_ZONE = 50;
    private static final double TOWER_SPREAD_KM = 5.0; // How far towers spread from zone center
    
    @Override
    public String getName() {
        return "simulated";
    }
    
    @Override
    public CompletableFuture<List<CellTower>> findTowersInZone(
            GeoZone zone, 
            FindTowersOptions options) {
        
        return CompletableFuture.supplyAsync(() -> {
            logger.info("Simulating tower search for zone with {} geometries", 
                zone.geometries().size());
            
            List<CellTower> towers = new ArrayList<>();
            
            for (GeoZone.ZoneGeometry geometry : zone.geometries()) {
                towers.addAll(generateTowersForGeometry(geometry, options));
            }
            
            logger.info("Simulation complete: {} towers generated", towers.size());
            
            return towers;
        });
    }
    
    /**
     * Generate towers for a single geometry.
     */
    private List<CellTower> generateTowersForGeometry(
            GeoZone.ZoneGeometry geometry,
            FindTowersOptions options) {
        
        List<CellTower> towers = new ArrayList<>();
        
        // Determine number of towers based on geometry type and hash
        int towerCount = determineTowerCount(geometry);
        
        // Get center point for tower generation
        GeoZone.ZoneCenter center = getGeometryCenter(geometry);
        
        // Generate towers around center
        Random random = new Random(center.hashCode());
        
        for (int i = 0; i < towerCount; i++) {
            CellTower tower = generateTower(i, center, random);
            towers.add(tower);
        }
        
        return towers;
    }
    
    /**
     * Determine number of towers based on geometry.
     */
    private int determineTowerCount(GeoZone.ZoneGeometry geometry) {
        // Use geometry type and coordinates to generate deterministic count
        int hash = geometry.type().hashCode();
        if (geometry.center() != null) {
            hash ^= geometry.center().hashCode();
        }
        
        Random random = new Random(hash);
        return MIN_TOWERS_PER_ZONE + 
               random.nextInt(MAX_TOWERS_PER_ZONE - MIN_TOWERS_PER_ZONE);
    }
    
    /**
     * Get center point of geometry.
     */
    private GeoZone.ZoneCenter getGeometryCenter(GeoZone.ZoneGeometry geometry) {
        if ("Circle".equals(geometry.type()) && geometry.center() != null) {
            return geometry.center();
        }
        
        if ("Polygon".equals(geometry.type()) && geometry.coordinates() != null 
            && !geometry.coordinates().isEmpty()) {
            // For polygon, calculate centroid (simplified: use first point)
            var firstRing = geometry.coordinates().get(0);
            if (firstRing != null && !firstRing.isEmpty()) {
                List<Double> firstPoint = firstRing.get(0);
                if (firstPoint.size() >= 2) {
                    return new GeoZone.ZoneCenter(firstPoint.get(0), firstPoint.get(1)); // lat, lng
                }
            }
        }
        
        // Default to Delhi, India for demonstration
        return new GeoZone.ZoneCenter(28.6139, 77.2090); // lat, lng
    }
    
    /**
     * Generate a single cell tower.
     */
    private CellTower generateTower(int index, GeoZone.ZoneCenter center, Random random) {
        // Generate position offset from center
        double offsetLat = (random.nextDouble() - 0.5) * (TOWER_SPREAD_KM / 111.0); // ~111km per degree
        double offsetLng = (random.nextDouble() - 0.5) * (TOWER_SPREAD_KM / 111.0);
        
        double lat = center.lat() + offsetLat;
        double lng = center.lng() + offsetLng;
        
        // Generate realistic Indian cell IDs
        // Format: MCC(404/405) + MNC(2 digits) + LAC(4 digits) + CID(4 digits)
        int mcc = 404 + random.nextInt(2); // 404 or 405 for India
        int mnc = 10 + random.nextInt(90); // 10-99
        int lac = 1000 + random.nextInt(9000); // 1000-9999
        int cid = 1000 + random.nextInt(9000); // 1000-9999
        
        String cellId = String.format("%d-%02d-%04d-%04d", mcc, mnc, lac, cid);
        String towerId = "sim-tower-" + String.format("%04d", index);
        
        return new CellTower(
            towerId,     // id
            cellId,      // cellId
            lat,         // latitude
            lng,         // longitude
            500.0,       // coverageRadiusM
            null         // coverageGeoJson
        );
    }
    
    /**
     * Generate operator name based on MNC.
     */
    private String generateOperator(int mnc) {
        // Simplified mapping of Indian operators
        return switch (mnc % 10) {
            case 0, 1, 2 -> "Bharti Airtel";
            case 3, 4 -> "Vodafone Idea";
            case 5, 6 -> "Reliance Jio";
            case 7, 8 -> "BSNL";
            default -> "Other Operator";
        };
    }
    
    /**
     * Generate technology type.
     */
    private String generateTechnology(Random random) {
        String[] technologies = {"4G", "4G", "4G", "5G", "3G"}; // Weighted toward 4G
        return technologies[random.nextInt(technologies.length)];
    }
}
